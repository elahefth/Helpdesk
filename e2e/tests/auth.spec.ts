import { expect, test } from "@playwright/test";
import { SIGNED_OUT } from "../auth-state.ts";
import { E2E_USERS } from "../credentials.ts";
import { resetDomainData } from "../fixtures/db.ts";
import { submitLoginForm } from "../fixtures/login.ts";

test.beforeEach(async () => {
  await resetDomainData();
});

test.describe("login page", () => {
  // Every test here starts with no cookies, unlike the suite default of admin.
  test.use({ storageState: SIGNED_OUT });

  test("signing in with valid admin credentials lands on the ticket queue", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitLoginForm(
      page,
      E2E_USERS.admin.email,
      E2E_USERS.admin.password,
    );

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText(E2E_USERS.admin.name)).toBeVisible();
    // The queue itself renders, so the authenticated fetch of /api/tickets
    // carried the new session cookie rather than 401-ing.
    await expect(page.getByText("No tickets yet")).toBeVisible();
  });

  test("an agent signs in to the same queue, without the admin nav", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitLoginForm(
      page,
      E2E_USERS.agent.email,
      E2E_USERS.agent.password,
    );

    await expect(page).toHaveURL("/");
    await expect(page.getByText(E2E_USERS.agent.name)).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  });

  test("signing in with a bad password shows an error and stays on /login", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitLoginForm(page, E2E_USERS.admin.email, "not-the-password");

    await expect(page.getByRole("alert")).toHaveText(
      "Invalid email or password.",
    );
    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  test("an unknown email fails with the same message as a bad password", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitLoginForm(page, "nobody@e2e.test", "some-other-password");

    // Identical copy for both halves of the pair, so the form cannot be used to
    // discover which addresses have accounts.
    await expect(page.getByRole("alert")).toHaveText(
      "Invalid email or password.",
    );
    await expect(page).toHaveURL("/login");
  });

  test("a malformed email is rejected by the form before any request", async ({
    page,
  }) => {
    // Only the sign-in call: the page also fetches /api/auth/get-session on
    // mount, and that one is expected.
    let signInCalls = 0;
    await page.route("**/api/auth/sign-in/**", (route) => {
      signInCalls += 1;
      return route.continue();
    });

    await page.goto("/login");
    await submitLoginForm(page, "not-an-email", E2E_USERS.admin.password);

    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page).toHaveURL("/login");
    expect(signInCalls).toBe(0);
  });

  test("an empty password is rejected by the form", async ({ page }) => {
    await page.goto("/login");
    await submitLoginForm(page, E2E_USERS.admin.email, "");

    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(page).toHaveURL("/login");
  });
});

test.describe("route guards", () => {
  test.use({ storageState: SIGNED_OUT });

  test("an unauthenticated visitor is redirected from a protected route to /login", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("an unauthenticated visitor is redirected from an admin route to /login", async ({
    page,
  }) => {
    await page.goto("/users");

    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
  });

  /**
   * Known-broken, so this is expected to fail until it is fixed — it will turn
   * red the moment it starts passing, which is the point.
   *
   * `authClient.signIn.email()` resolves before the `useSession` store has
   * refetched, so LoginPage's `navigate(from)` renders RequireAuth against a
   * still-null session. RequireAuth bounces back to /login, and by then the
   * session has landed, so LoginPage's `if (session) return <Navigate to="/" />`
   * fires and the deep link is lost. Reproducible 5 runs out of 5.
   */
  test.fail(
    "signing in after a guard redirect returns to the deep link",
    async ({ page }) => {
      await page.goto("/users?tab=staff");
      await expect(page).toHaveURL("/login");

      await submitLoginForm(
        page,
        E2E_USERS.admin.email,
        E2E_USERS.admin.password,
      );

      await expect(page).toHaveURL("/users?tab=staff");
      await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    },
  );
});
