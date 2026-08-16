import { expect, test } from "@playwright/test";
import { SIGNED_OUT } from "../auth-state.ts";
import { E2E_USERS } from "../credentials.ts";
import { deleteSessionByToken, resetDomainData } from "../fixtures/db.ts";
import {
  SESSION_COOKIE,
  sessionToken,
  signInThroughForm,
} from "../fixtures/login.ts";

test.beforeEach(async () => {
  await resetDomainData();
});

/**
 * Session lifecycle. Every test starts signed out and mints its own session
 * through the form: ending a session is the point of half of these, and the
 * shared storageState rows must survive the run (see fixtures/login.ts).
 */
test.describe("session lifecycle", () => {
  test.use({ storageState: SIGNED_OUT });

  test("signing out returns to the login page and drops the session cookie", async ({
    page,
    context,
  }) => {
    await signInThroughForm(page, E2E_USERS.admin);
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    const cookies = await context.cookies();
    expect(cookies.map((c) => c.name)).not.toContain(SESSION_COOKIE);
  });

  test("a signed-out session is rejected by the API, not just hidden by the UI", async ({
    page,
  }) => {
    await signInThroughForm(page, E2E_USERS.admin);
    const before = await page.request.get("/api/tickets");
    expect(before.status()).toBe(200);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");

    const response = await page.request.get("/api/tickets");
    expect(response.status()).toBe(401);

    await page.goto("/");
    await expect(page).toHaveURL("/login");
  });

  test("a signed-in user who opens /login is sent back to the queue", async ({
    page,
  }) => {
    await signInThroughForm(page, E2E_USERS.admin);

    await page.goto("/login");

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("the session survives a full page reload", async ({ page }) => {
    await signInThroughForm(page, E2E_USERS.admin);

    await page.goto("/users");
    await page.reload();

    // RequireAuth renders "Loading…" until getSession answers; a cold load must
    // resolve to the page, not bounce to /login.
    await expect(page).toHaveURL("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });

  test("deleting the session row signs the browser out", async ({
    page,
    context,
  }) => {
    await signInThroughForm(page, E2E_USERS.admin);

    // What revoking an agent will mean once the admin screen exists: no
    // cookieCache, so the next request re-reads the row and finds it gone.
    const revoked = await deleteSessionByToken(await sessionToken(context));
    expect(revoked).toBe(1);

    const response = await page.request.get("/api/tickets");
    expect(response.status()).toBe(401);

    await page.reload();
    await expect(page).toHaveURL("/login");
  });

  test("the session cookie is not readable from page scripts", async ({
    page,
    context,
  }) => {
    await signInThroughForm(page, E2E_USERS.admin);

    const cookie = (await context.cookies()).find(
      (c) => c.name === SESSION_COOKIE,
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");

    // String form rather than an arrow function: the e2e tsconfig has no DOM
    // lib, so `document` is not a known global at type level.
    const visibleToScripts = await page.evaluate<string>("document.cookie");
    expect(visibleToScripts).not.toContain(SESSION_COOKIE);
  });
});
