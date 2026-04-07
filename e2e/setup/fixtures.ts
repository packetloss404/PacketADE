import { test as base, expect } from "@playwright/test";
import { mockTauriInitScript } from "./mock-tauri";

/**
 * Shared fixture that installs the Tauri IPC mock before every page load
 * and clears localStorage between tests so state is deterministic.
 */
/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture API uses a
   parameter conventionally named `use`, which collides with React's hook
   naming lint rule. This file is E2E-only and contains no React code. */
export const test = base.extend({
  page: async ({ page }, usePage) => {
    await page.addInitScript(mockTauriInitScript);
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* ignore */
      }
    });
    await usePage(page);
  },
});

export { expect };
