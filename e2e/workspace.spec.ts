import { test, expect } from "./setup/fixtures";

test.describe("Workspace view", () => {
  test("can navigate to the separate Workspace view", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Workspace", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Welcome to PacketADE" })).toBeVisible();
    await expect(page.getByText("Open a project folder")).toBeVisible();
  });
});
