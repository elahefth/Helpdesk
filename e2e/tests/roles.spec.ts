import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "../auth-state.ts";
import { E2E_USERS } from "../credentials.ts";
import { resetDomainData } from "../fixtures/db.ts";

test.beforeEach(async () => {
  await resetDomainData();
});

test.describe("as an admin", () => {
  test("the Users nav link is offered and opens the admin page", async ({
    page,
  }) => {
    await page.goto("/");

    const usersLink = page.getByRole("link", { name: "Users" });
    await expect(usersLink).toBeVisible();

    await usersLink.click();
    await expect(page).toHaveURL("/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });
});

test.describe("as an agent", () => {
  test.use({ storageState: STORAGE_STATE.agent });

  test("the Users nav link is not rendered", async ({ page }) => {
    await page.goto("/");

    // Anchor on something the agent *does* see first, so the absence below is
    // an absence in a loaded page rather than in an empty one.
    await expect(page.getByText(E2E_USERS.agent.name)).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  });

  test("typing /users redirects back to the ticket queue", async ({ page }) => {
    await page.goto("/users");

    await expect(page).toHaveURL("/");
    await expect(page.getByText("No tickets yet")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
  });
});
