import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createApp } from "./app.ts";
import type { Auth } from "./auth.ts";
import { canTransition } from "@helpdesk/shared";

let server: Server;
let baseUrl: string;

/**
 * The root `test` script runs with `-u DATABASE_URL`, so the real auth instance
 * cannot be built. This stub stands in for it: any request carrying a cookie is
 * treated as signed in, so the guard's two branches are both reachable without
 * a database.
 */
const stubAuth = {
  handler: () => new Response(null, { status: 404 }),
  api: {
    getSession: ({ headers }: { headers: Headers }) =>
      Promise.resolve(
        headers.get("cookie")
          ? {
              user: {
                id: "00000000-0000-4000-8000-000000000001",
                email: "agent@helpdesk.test",
                name: "Test Agent",
                role: "agent",
              },
            }
          : null,
      ),
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

/** Signed in — the stub only checks that a cookie is present. */
const getAuthed = (path: string) =>
  fetch(`${baseUrl}${path}`, { headers: { cookie: "helpdesk.session=stub" } });

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
