import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration for PacketCode.
 *
 * This runs the React frontend against the Vite dev server (web mode).
 * Tauri-specific IPC calls are mocked via `e2e/setup/mock-tauri.ts`.
 * Full Tauri end-to-end coverage would require tauri-driver, which is
 * out of scope for this first pass.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
