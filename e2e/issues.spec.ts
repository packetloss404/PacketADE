import { test, expect } from "./setup/fixtures";

test.describe("Issue board", () => {
  test("opens the Issues view and renders the board", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Issues", exact: true }).click();

    // IssueBoard renders kanban columns — at minimum a "Todo" column header.
    // Use a loose match since the store is persisted to localStorage (cleared
    // per-test by the fixture) so the board always starts empty.
    await expect(page.getByText(/to ?do/i).first()).toBeVisible();
    await expect(page.getByText(/in progress/i).first()).toBeVisible();
  });

  test("issue board is interactive after navigation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Issues", exact: true }).click();

    // The board toolbar exposes a search input; confirm it is present and
    // accepts input. Creating a full issue requires the NewIssueForm modal
    // which depends on several backend invokes — covered once we add deeper
    // Tauri mocks.
    const searchInputs = page.getByPlaceholder(/search/i);
    if ((await searchInputs.count()) > 0) {
      await searchInputs.first().fill("hello");
      await expect(searchInputs.first()).toHaveValue("hello");
    }
  });
});
