import { test, expect } from "./setup/fixtures";

test.describe("Settings information architecture", () => {
  test("uses six lossless groups with searchable sub-sections and scope badges", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    for (const label of [
      "General",
      "Workspaces & Terminal",
      "Agents & Models",
      "Automation",
      "Integrations & Data",
      "Security & Diagnostics",
    ]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: "Workspaces & Terminal", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Workspaces & Terminal", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "CLI Clients", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remote Hosts", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Project Rules", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "CLI Clients", exact: true }).click();
    await expect(page.getByLabel("Setting scopes")).toContainText("New sessions");

    await page.getByRole("searchbox", { name: "Search settings" }).fill("forgejo");
    await page.getByRole("button", { name: /Git Hosts/ }).click();

    await expect(
      page.getByRole("heading", { name: "Integrations & Data", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Git Hosts", exact: true })).toBeVisible();
  });
});
