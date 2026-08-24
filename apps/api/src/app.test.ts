import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createApp } from "./app.ts";
import type { Auth } from "./auth.ts";
import { canTransition } from "@helpdesk/shared";

let server: Server;
let baseUrl: string;

/** The two identities the stub can resolve to, keyed by session cookie value. */
const STUB_USERS = {
  agent: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "agent@helpdesk.test",
    name: "Test Agent",
    role: "agent",
  },
  admin: {
    id: "00000000-0000-4000-8000-000000000002",
    email: "admin@helpdesk.test",
    name: "Test Admin",
    role: "admin",
  },
} as const;

/**
 * The root `test` script runs with `-u DATABASE_URL`, so the real auth instance
 * cannot be built. This stub stands in for it: any request carrying a cookie is
 * treated as signed in, so the guard's two branches are both reachable without
 * a database.
 *
 * The cookie *value* selects the role, which is what makes `requireRole` testable
 * without Postgres. Anything unrecognised resolves to `agent`, so the plain
 * `getAuthed` helper keeps the least-privileged identity it has always had.
 */
const stubAuth = {
  handler: () => new Response(null, { status: 404 }),
  api: {
    getSession: ({ headers }: { headers: Headers }) => {
      const cookie = headers.get("cookie");
      if (!cookie) return Promise.resolve(null);
      const role = /helpdesk\.session=admin\b/.test(cookie) ? "admin" : "agent";
      return Promise.resolve({ user: STUB_USERS[role] });
    },
  },
} as unknown as Auth;

beforeAll(async () => {
  const app = createApp({ auth: stubAuth });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

/** Unauthenticated. */
const get = (path: string) => fetch(`${baseUrl}${path}`);

/** Signed in as an agent — the stub maps any unrecognised cookie value to that. */
const getAuthed = (path: string) =>
  fetch(`${baseUrl}${path}`, { headers: { cookie: "helpdesk.session=stub" } });

/** Signed in as a specific role, for the admin-only routes. */
const getAuthedAs = (role: keyof typeof STUB_USERS, path: string) =>
  fetch(`${baseUrl}${path}`, {
    headers: { cookie: `helpdesk.session=${role}` },
  });

/** As above but for the writes. `body` is sent raw so a malformed one is testable. */
const writeAs = (
  method: "POST" | "PATCH",
  role: keyof typeof STUB_USERS | "anon",
  path: string,
  body: unknown,
) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role === "anon" ? {} : { cookie: `helpdesk.session=${role}` }),
    },
    body: JSON.stringify(body),
  });

const postAs = (
  role: keyof typeof STUB_USERS | "anon",
  path: string,
  body: unknown,
) => writeAs("POST", role, path, body);

const patchAs = (
  role: keyof typeof STUB_USERS | "anon",
  path: string,
  body: unknown,
) => writeAs("PATCH", role, path, body);

const NEW_USER = {
  name: "Cass Agent",
  email: "cass@helpdesk.test",
  password: "correct-horse-battery",
};

/** A well-formed target for the edit route. No such row exists — see below. */
const TARGET = "/api/users/00000000-0000-4000-8000-0000000000ff";

/** A valid edit that changes no password. */
const EDIT = { name: "Cass Renamed", email: "cass@helpdesk.test" };

/** `Response.json()` is `unknown`; tests assert on shape deliberately. */
const body = (res: Response) => res.json() as Promise<any>;

describe("health", () => {
  it("reports liveness", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.status).toBe("ok");
    expect(typeof payload.uptimeSeconds).toBe("number");
  });

  // The root `test` script runs with --env-file=/dev/null so this premise
  // holds regardless of the developer's local .env.
  it("reports degraded readiness when no database is configured", async () => {
    const res = await get("/readyz");
    expect(res.status).toBe(503);
    const payload = await body(res);
    expect(payload.checks.database).toBe("down");
  });
});

describe("tickets", () => {
  it("returns an empty page", async () => {
    const res = await getAuthed("/api/tickets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], nextCursor: null });
  });

  it("accepts valid filters", async () => {
    const res = await getAuthed(
      "/api/tickets?status=open&priority=urgent&limit=10",
    );
    expect(res.status).toBe(200);
  });

  it("rejects an invalid filter value", async () => {
    const res = await getAuthed("/api/tickets?status=not-a-status");
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.error.code).toBe("validation_failed");
  });

  it("attaches a request id to errors", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    const payload = await body(res);
    expect(payload.error.code).toBe("not_found");
    expect(payload.error.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("users (admin only)", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await get("/api/users");
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe("unauthorized");
  });

  // The role gate runs before the handler touches the database, which is the only
  // reason this is reachable in a suite that has no Postgres.
  it("forbids an agent", async () => {
    const res = await getAuthedAs("agent", "/api/users");
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("forbidden");
  });

  it("does not turn an unknown /api path into a 403", async () => {
    // Regression guard for mounting requireRole with router.use instead of on the
    // route: that would shadow notFoundHandler for every non-admin.
    const res = await getAuthedAs("agent", "/api/nope");
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("not_found");
  });

  it("admits an admin as far as the database check", async () => {
    const res = await getAuthedAs("admin", "/api/users");
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe("service_unavailable");
  });

  it("rejects an invalid role filter", async () => {
    const res = await getAuthedAs("admin", "/api/users?role=wizard");
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  it("rejects an out-of-range limit", async () => {
    const res = await getAuthedAs("admin", "/api/users?limit=0");
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  // Input validation precedes the database check deliberately, so a bad cursor
  // reports itself rather than being masked by the 503 above.
  it("rejects a malformed cursor", async () => {
    const res = await getAuthedAs(
      "admin",
      "/api/users?cursor=not-base64-email",
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("bad_request");
  });
});

/**
 * POST is the only HTTP path that creates an account — sign-up is closed in
 * auth.ts — so the guard on it is the whole access-control story for staff
 * creation, and it is checked here rather than left to the E2E suite.
 *
 * This suite has no Postgres, so a well-formed request can only be followed as
 * far as the database check. That is enough to pin the guard and the body
 * validation, which are the parts that must not regress silently; the Better
 * Auth hand-off itself needs a real database and belongs in e2e/.
 */
describe("create user (admin only)", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await postAs("anon", "/api/users", NEW_USER);
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe("unauthorized");
  });

  it("forbids an agent creating staff", async () => {
    const res = await postAs("agent", "/api/users", NEW_USER);
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("forbidden");
  });

  it("admits an admin as far as the database check", async () => {
    const res = await postAs("admin", "/api/users", NEW_USER);
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe("service_unavailable");
  });

  it("rejects a name shorter than three characters", async () => {
    const res = await postAs("admin", "/api/users", {
      ...NEW_USER,
      name: "Al",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  // The trim runs before the length check, so whitespace cannot buy the third
  // character — the counterpart of the same assertion in the SPA's form test.
  it("rejects a name that only reaches three characters with padding", async () => {
    const res = await postAs("admin", "/api/users", {
      ...NEW_USER,
      name: " Al ",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  it("rejects a password shorter than eight characters", async () => {
    const res = await postAs("admin", "/api/users", {
      ...NEW_USER,
      password: "1234567",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  it("rejects a malformed email", async () => {
    const res = await postAs("admin", "/api/users", {
      ...NEW_USER,
      email: "not-an-email",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  // `role` is input: false on the Better Auth user model and absent from
  // createUserBodySchema, so a payload asking for admin is rejected outright
  // rather than quietly having the field dropped.
  it("rejects a payload that tries to hand out a role", async () => {
    const res = await postAs("admin", "/api/users", {
      ...NEW_USER,
      role: "admin",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });
});

/**
 * Editing runs the same guard as creating and the same body rules, minus the
 * one that differs: the password is optional, and blank means "leave it alone".
 *
 * As with POST, no Postgres here means a well-formed request can only be
 * followed as far as the database check. That still pins the guard, the path
 * param, and every branch of the body schema — the parts that must not regress
 * quietly. The Better Auth password hand-off needs a real database and is
 * verified against one separately.
 */
describe("update user (admin only)", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await patchAs("anon", TARGET, EDIT);
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe("unauthorized");
  });

  it("forbids an agent editing staff", async () => {
    const res = await patchAs("agent", TARGET, EDIT);
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("forbidden");
  });

  it("admits an admin as far as the database check", async () => {
    const res = await patchAs("admin", TARGET, EDIT);
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe("service_unavailable");
  });

  // The three ways of saying "leave the password alone" have to be equivalent,
  // because the form sends the middle one and a scripted caller may send either
  // of the others. Reaching the database check is what proves the body parsed.
  it.each([
    ["omitted", EDIT],
    ["blank", { ...EDIT, password: "" }],
    ["whitespace only", { ...EDIT, password: "   " }],
  ])("accepts a password that is %s", async (_label, payload) => {
    const res = await patchAs("admin", TARGET, payload);
    expect(res.status).toBe(503);
  });

  it("accepts a password that is actually being changed", async () => {
    const res = await patchAs("admin", TARGET, {
      ...EDIT,
      password: "correct-horse-battery",
    });
    expect(res.status).toBe(503);
  });

  // A path param is input too. 400 rather than 404 because the id is not merely
  // absent from the table, it could never name a row.
  it("rejects a malformed user id", async () => {
    const res = await patchAs("admin", "/api/users/not-a-uuid", EDIT);
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("bad_request");
  });

  it("has no edit route without an id", async () => {
    // Guards the ":id" on the route: a pathless patch must not fall through to
    // something that would edit an unspecified user.
    const res = await patchAs("admin", "/api/users", EDIT);
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("not_found");
  });

  it("rejects a name shorter than three characters", async () => {
    const res = await patchAs("admin", TARGET, { ...EDIT, name: "Al" });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  it("rejects a name that only reaches three characters with padding", async () => {
    const res = await patchAs("admin", TARGET, { ...EDIT, name: " Al " });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  it("rejects a malformed email", async () => {
    const res = await patchAs("admin", TARGET, {
      ...EDIT,
      email: "not-an-email",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  // A non-empty password still has to clear the floor: "unchanged" is the empty
  // string, not any short string.
  it("rejects a password shorter than eight characters", async () => {
    const res = await patchAs("admin", TARGET, {
      ...EDIT,
      password: "1234567",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });

  // Same reasoning as on create: `role` is input: false on the user model, so
  // an attempt to set one is answered rather than quietly stripped. Editing an
  // account must not be a way to promote it.
  it("rejects a payload that tries to hand out a role", async () => {
    const res = await patchAs("admin", TARGET, { ...EDIT, role: "admin" });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("validation_failed");
  });
});

describe("auth guard", () => {
  it("rejects an unauthenticated ticket request", async () => {
    const res = await get("/api/tickets");
    expect(res.status).toBe(401);
    const payload = await body(res);
    expect(payload.error.code).toBe("unauthorized");
    expect(payload.error.requestId).toBeTruthy();
  });

  it("leaves the health endpoints public", async () => {
    expect((await get("/healthz")).status).toBe(200);
  });

  it("fails closed when no auth instance exists", async () => {
    // No DATABASE_URL and no injected stub: sessions cannot be verified, so
    // requests must be refused rather than waved through.
    const app = createApp();
    const closed = app.listen(0);
    await new Promise((resolve) => closed.once("listening", resolve));
    const address = closed.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      headers: { cookie: "helpdesk.session=stub" },
    });
    expect(res.status).toBe(401);

    closed.close();
  });
});

describe("ticket lifecycle", () => {
  it("allows the student-replied reopen", () => {
    expect(canTransition("resolved", "open")).toBe(true);
  });

  it("treats closed as terminal", () => {
    expect(canTransition("closed", "open")).toBe(false);
  });

  it("rejects skipping straight from new to resolved", () => {
    expect(canTransition("new", "resolved")).toBe(false);
  });
});
