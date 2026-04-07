import { test, expect } from "./setup/fixtures";

test.describe("Toolbar navigation", () => {
  test("can navigate to the Issues view via the toolbar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketCode" })).toBeVisible();

    await page.getByRole("button", { name: "Issues", exact: true }).click();

    // Welcome screen heading should no longer be visible once we switch views
    await expect(page.getByRole("heading", { name: "PacketCode" })).toHaveCount(0);
  });

  test("can navigate to Flight and History views", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketCode" })).toBeVisible();

    await page.getByRole("button", { name: "Flight", exact: true }).click();
    await expect(page.getByRole("button", { name: "Flight", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByRole("button", { name: "History", exact: true })).toBeVisible();
  });
});
