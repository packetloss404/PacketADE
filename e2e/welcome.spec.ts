import { test, expect } from "./setup/fixtures";

test.describe("Welcome screen", () => {
  test("app loads and renders the welcome screen", async ({ page }) => {
    await page.goto("/");

    // PacketCode title on the welcome view
    await expect(page.getByRole("heading", { name: "PacketCode" })).toBeVisible();

    // Toolbar should be present with the Sessions button
    await expect(page.getByRole("button", { name: "Sessions" })).toBeVisible();
  });

  test("no uncaught console errors on initial load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PacketCode" })).toBeVisible();

    expect(errors, `page errors: ${errors.join("\n")}`).toEqual([]);
  });
});
