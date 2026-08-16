import { expect, test } from "@playwright/test";
import { SIGNED_OUT, STORAGE_STATE } from "../auth-state.ts";
import { E2E_USERS } from "../credentials.ts";
import { resetDomainData } from "../fixtures/db.ts";

interface ApiErrorBody {
  error: { code: string; message: string; requestId: string };
}

interface BetterAuthErrorBody {
  code?: string;
  message?: string;
}

test.beforeEach(async () => {
  await resetDomainData();
});

/**
 * The server-side half of the boundary. RequireAuth and RequireAdmin only hide
 * UI, so everything that actually has to hold is asserted here against the API.
 */
test.describe("unauthenticated API access", () => {
  test.use({ storageState: SIGNED_OUT });

  test("a guarded route answers 401 with a matching request id", async ({
    request,
  }) => {
    const response = await request.get("/api/tickets");

    expect(response.status()).toBe(401);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toBe(response.headers()["x-request-id"]);
  });

  test("an unknown /api path answers 401 rather than revealing that it is unknown", async ({
    request,
  }) => {
    // requireAuth is mounted on /api ahead of the 404 handler, so route
    // existence is not probeable without a session.
    const response = await request.get("/api/does-not-exist");

    expect(response.status()).toBe(401);
  });

  test("sign-up over HTTP is closed and creates no account", async ({
    request,
  }) => {
    const intruder = {
      email: "intruder@e2e.test",
      password: "intruder-password",
      name: "Intruder",
    };

    const signUp = await request.post("/api/auth/sign-up/email", {
      data: { ...intruder, role: "admin" },
      failOnStatusCode: false,
    });

    expect(signUp.status()).toBe(400);
    const body = (await signUp.json()) as BetterAuthErrorBody;
    expect(body.code).toBe("SIGN_UP_DISABLED");

    // The hook has to reject before the insert, not merely fail the response.
    const signIn = await request.post("/api/auth/sign-in/email", {
      data: { email: intruder.email, password: intruder.password },
      failOnStatusCode: false,
    });
    expect(signIn.status()).toBe(401);
  });

  test("an unknown email and a wrong password are indistinguishable", async ({
    request,
  }) => {
    const unknown = await request.post("/api/auth/sign-in/email", {
      data: { email: "nobody@e2e.test", password: "some-other-password" },
      failOnStatusCode: false,
    });
    const wrongPassword = await request.post("/api/auth/sign-in/email", {
      data: { email: E2E_USERS.admin.email, password: "not-the-password" },
      failOnStatusCode: false,
    });

    expect(unknown.status()).toBe(wrongPassword.status());
    expect(unknown.status()).toBe(401);
    expect(((await unknown.json()) as BetterAuthErrorBody).code).toBe(
      ((await wrongPassword.json()) as BetterAuthErrorBody).code,
    );
  });

  test("the session endpoint reports no session instead of failing", async ({
    request,
  }) => {
    const response = await request.get("/api/auth/get-session");

    // The SPA's cold load depends on this: RequireAuth waits for a resolved
    // null, and an error status here would strand it on "Loading…".
    expect(response.status()).toBe(200);
    expect(await response.json()).toBeNull();
  });

  test("CORS advertises only the configured web origin", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get("/api/tickets", {
      headers: { origin: "http://evil.test" },
      failOnStatusCode: false,
    });

    // Echoing the caller's origin back is the classic way an allowlist stops
    // being one; this must stay the fixed WEB_ORIGIN value.
    expect(response.headers()["access-control-allow-origin"]).toBe(baseURL);
  });
});

test.describe("agent API access", () => {
  test.use({ storageState: STORAGE_STATE.agent });

  test("an agent cannot grant themselves the admin role", async ({
    request,
  }) => {
    const escalate = await request.post("/api/auth/update-user", {
      data: { role: "admin" },
      failOnStatusCode: false,
    });

    // `role` is an additionalField with `input: false`, so Better Auth refuses
    // the payload outright rather than silently ignoring the field.
    expect(escalate.status()).toBe(400);
    expect(((await escalate.json()) as BetterAuthErrorBody).code).toBe(
      "FIELD_NOT_ALLOWED",
    );

    const session = await request.get("/api/auth/get-session");
    const body = (await session.json()) as { user: { role: string } };
    expect(body.user.role).toBe("agent");
  });

  test("an agent's session is accepted by the guarded routes", async ({
    request,
  }) => {
    // Tickets are staff-wide, not admin-only: the agent's 200 here is the
    // expected behavior, and the reason /users is guarded in the SPA alone.
    const response = await request.get("/api/tickets");

    expect(response.status()).toBe(200);
  });
});
