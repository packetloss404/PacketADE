import { test, expect } from "./setup/fixtures";

test.describe("Workspace view", () => {
  test("can navigate to the separate Workspace view", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Workspace", exact: true }).click();

    // Parallel web-mode workers can leave the initial CLI-detection/onboarding
    // render just beyond Playwright's five-second assertion default.
    await expect(page.getByRole("heading", { name: "Welcome to PacketBench" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Open a project folder")).toBeVisible();
  });
});
