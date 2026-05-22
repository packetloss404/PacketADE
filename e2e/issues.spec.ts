import { test, expect } from "./setup/fixtures";

test.describe("Issue board", () => {
  test("opens the Issues view and renders the board", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Issues", exact: true }).click();

    // IssueBoard renders kanban columns — at minimum a Backlog column header.
    // Use a loose match since the store is persisted to localStorage (cleared
    // per-test by the fixture) so the board always starts empty.
    await expect(page.getByText(/^Backlog$/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^In Progress$/)).toBeVisible();
  });

  test("issue board is interactive after navigation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Issues", exact: true }).click();

    // The board toolbar exposes a search input; confirm it is present and
    // accepts input. Creating a full issue requires the NewIssueForm modal
    // which depends on several backend invokes — covered once we add deeper
    // Tauri mocks.
    const searchInput = page.getByPlaceholder("Filter by label, agent, flight…");
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill("hello");
    await expect(searchInput).toHaveValue("hello");
  });
});
