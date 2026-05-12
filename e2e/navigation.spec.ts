import { test, expect } from "./setup/fixtures";

test.describe("Toolbar navigation", () => {
  test("can navigate to the Issues view via the toolbar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketADE" })).toBeVisible();

    await page.getByRole("button", { name: "Issues", exact: true }).click();

    // Welcome screen heading should no longer be visible once we switch views
    await expect(page.getByPlaceholder("Filter by label, agent, flight…")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("can navigate to Flight Deck and Memory views", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketADE" })).toBeVisible();

    await page.getByRole("button", { name: "Flight Deck", exact: true }).click();
    await expect(page.getByText("Flight Deck").first()).toBeVisible();

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByText("Memory").first()).toBeVisible();
  });
});
