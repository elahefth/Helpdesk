import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { STORAGE_STATE } from "./auth-state.ts";
import { E2E_ROLES, E2E_USERS } from "./credentials.ts";

/**
 * Mints one signed-in session per role and parks it on disk for `storageState`.
 *
 * Signs in over the API rather than by driving the login form. The product of
 * this file is a session cookie; routing that through LoginPage.tsx would make
 * every future test's setup break whenever that markup changes. The login form
 * deserves its own test — it just should not be load-bearing for all the others.
 *
 * The request goes to `baseURL`, i.e. the Vite origin, so it travels the same
 * proxy the browser uses and the cookie is scoped to the origin the tests will
 * actually visit.
 */
for (const role of E2E_ROLES) {
  setup(`authenticate as ${role}`, async ({ request }) => {
    const { email, password } = E2E_USERS[role];

    const response = await request.post("/api/auth/sign-in/email", {
      data: { email, password },
    });

    // A precondition, not an assertion about the product: if this fails the
    // seed did not take, and every downstream test would fail confusingly.
    expect(
      response.ok(),
      `sign-in failed for ${email}: ${response.status()} ${await response.text()}`,
    ).toBeTruthy();

    const file = STORAGE_STATE[role];
    mkdirSync(path.dirname(file), { recursive: true });
    await request.storageState({ path: file });
  });
}
