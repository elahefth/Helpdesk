import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { E2EUser } from "../credentials.ts";

/** Better Auth's cookie, unprefixed because `useSecureCookies` is off outside production. */
export const SESSION_COOKIE = "better-auth.session_token";

/** Fills and submits the login form. Does not wait for the outcome — the failure cases assert on it. */
export async function submitLoginForm(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Signs in through the real form and waits for the app shell.
 *
 * Tests that end a session (sign out, revocation) must mint their own like this
 * rather than reusing STORAGE_STATE: those files are cookies for two session
 * rows shared by the whole run, and deleting either one would sign out every
 * test that follows.
 */
export async function signInThroughForm(
  page: Page,
  user: E2EUser,
): Promise<void> {
  await page.goto("/login");
  await submitLoginForm(page, user.email, user.password);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/**
 * The `session.token` column value for the context's current cookie.
 *
 * The cookie carries `<token>.<signature>`; only the first half is stored.
 */
export async function sessionToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find(
    (c) => c.name === SESSION_COOKIE,
  );
  if (!cookie) throw new Error(`No ${SESSION_COOKIE} cookie on this context`);

  const [token = ""] = cookie.value.split(".");
  return token;
}
