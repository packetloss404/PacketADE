import { test, expect } from "./setup/fixtures";

test.describe("Welcome screen", () => {
  test("app loads and renders the welcome screen", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "PacketADE" })).toBeVisible();

    // Primary navigation should be present.
    await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  });

  test("no uncaught console errors on initial load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketADE" })).toBeVisible();

    expect(errors, `page errors: ${errors.join("\n")}`).toEqual([]);
  });
});
