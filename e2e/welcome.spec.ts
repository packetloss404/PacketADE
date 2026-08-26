import { test, expect } from "./setup/fixtures";

test.describe("Welcome screen", () => {
  test("app loads and renders the welcome screen", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "PacketBench" })).toBeVisible();

    // Primary navigation should be present. Tile program (P5): the Agents rail
    // item was retired; Workspace is the primary surface.
    await expect(page.getByRole("button", { name: "Workspace", exact: true })).toBeVisible();
  });

  test("no uncaught console errors on initial load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketBench" })).toBeVisible();

    expect(errors, `page errors: ${errors.join("\n")}`).toEqual([]);
  });
});
