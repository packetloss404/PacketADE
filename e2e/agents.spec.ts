import { test, expect } from "./setup/fixtures";
import type { Page } from "@playwright/test";

const seededConversation = {
  id: "conv_e2e_agents",
  title: "E2E smoke conversation",
  agent: "api-minimax",
  projectPath: "D:\\projects\\PacketADE",
  status: "done",
  messages: [
    {
      id: "msg_user",
      role: "user",
      content: "Smoke test",
      timestamp: 1_700_000_000_000,
    },
  ],
  sessionId: null,
  rawOutput: "",
  createdAt: 1_700_000_000_000,
  updatedAt: Date.now(),
  mode: "api",
  provider: "minimax",
  model: "MiniMax-M2.7-highspeed",
};

async function installAgentsPaneMocks(page: Page) {
  await page.addInitScript((conversation) => {
    window.localStorage.setItem("packetade:agents-onboarding-dismissed", "1");
    Object.assign(window, {
      __PACKETADE_E2E_CONVERSATIONS__: [JSON.stringify(conversation)],
    });
  }, seededConversation);
}

test.describe("Agents pane", () => {
  test("renders without workspace handoff copy", async ({ page }) => {
    await installAgentsPaneMocks(page);

    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();

    await expect(page.getByRole("button", { name: /Group: Project/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByPlaceholder(/what would you like to work on/i)).toBeVisible();
    await expect(page.getByText(/Open in workspace/i)).toHaveCount(0);
    await expect(page.getByText(/no workspace/i)).toHaveCount(0);
  });

  test("group dropdown does not include Workspace", async ({ page }) => {
    await installAgentsPaneMocks(page);

    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();

    const groupButton = page.getByRole("button", { name: /Group: Project/i });
    await expect(groupButton).toBeVisible({ timeout: 15_000 });
    await groupButton.click();

    const groupControl = groupButton.locator("xpath=..");
    await expect(groupControl.getByRole("button", { name: "Project", exact: true })).toBeVisible();
    await expect(groupControl.getByRole("button", { name: "Status", exact: true })).toBeVisible();
    await expect(
      groupControl.getByRole("button", { name: "Environment", exact: true }),
    ).toBeVisible();
    await expect(groupControl.getByRole("button", { name: /Workspace/i })).toHaveCount(0);
  });
});
