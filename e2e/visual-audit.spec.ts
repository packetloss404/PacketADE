import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./setup/fixtures";

/**
 * Visual layout audit — captures full-page screenshots of every core view
 * reachable in web mode (Vite + mocked Tauri IPC) at two viewports.
 *
 * This is an auditing tool, not a regression gate: each view is wrapped in a
 * tolerant step that logs-and-continues when a surface errors, so `pnpm e2e`
 * never goes red because of it. Output lands in `e2e/visual-audit-output/`
 * (gitignored); curated findings live under `docs/reports/`.
 *
 * Notes on representativeness: PTY/xterm panes, GitHub data, memory events,
 * analytics, and provider auth are all mocked to empty in web mode, so most
 * views render their empty states. That is intentional — empty states are
 * part of the audit — but conclusions about data-dense layouts cannot be
 * drawn from these captures.
 */

const OUT_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "visual-audit-output",
);

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
] as const;

const skipped: string[] = [];

async function snap(page: Page, dir: string, name: string) {
  // Let any transition / lazy chunk settle before capture.
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(OUT_ROOT, dir, `${name}.png`),
    fullPage: true,
  });
}

/** Tolerant step: capture-or-log, never fail the run. */
async function auditStep(
  info: TestInfo,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  await test.step(label, async () => {
    try {
      await fn();
    } catch (err) {
      const msg = `[visual-audit] SKIPPED "${label}": ${String(err).split("\n")[0]}`;
      skipped.push(msg);
      console.warn(msg);
    }
  });
}

/**
 * Click with a bounded timeout, falling back to a direct DOM click event if
 * Playwright's actionability checks stall (e.g. an invisible overlay). This is
 * an audit harness — robustness beats strictness here.
 */
async function robustClick(page: Page, locator: ReturnType<Page["locator"]>) {
  try {
    await locator.click({ timeout: 5_000 });
  } catch {
    await locator.dispatchEvent("click");
  }
}

/** Click a left-rail item (accessible name comes from its title attr). */
async function railTo(page: Page, name: string) {
  await robustClick(page, page.getByRole("button", { name, exact: true }).first());
}

for (const vp of VIEWPORTS) {
  const dir = `${vp.width}x${vp.height}`;

  test.describe(`visual audit @ ${dir}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, actionTimeout: 10_000 });

    test(`capture core views (${dir})`, async ({ page }, info) => {
      test.setTimeout(300_000);

      await page.goto("/");
      await expect(page.getByRole("heading", { name: "PacketADE" })).toBeVisible({
        timeout: 15_000,
      });

      // ---- Core views via left rail --------------------------------------
      await auditStep(info, "welcome", async () => {
        await snap(page, dir, "01-welcome");
      });

      await auditStep(info, "workspace (empty/onboarding)", async () => {
        await railTo(page, "Workspace");
        await expect(
          page.getByRole("heading", { name: "Welcome to PacketADE" }),
        ).toBeVisible({ timeout: 10_000 });
        await snap(page, dir, "02-workspace-empty");
      });

      await auditStep(info, "agents", async () => {
        await railTo(page, "Agents");
        // First visit auto-opens the "Welcome to Agents" onboarding modal —
        // capture it, then dismiss to capture the actual Agents surface.
        await snap(page, dir, "03-agents-onboarding-modal");
        const gotIt = page.getByRole("button", { name: "Got it" });
        if (await gotIt.isVisible().catch(() => false)) {
          await robustClick(page, gotIt);
        }
        await snap(page, dir, "03b-agents");
      });

      await auditStep(info, "flight deck", async () => {
        await railTo(page, "Flight Deck");
        // Capture whatever renders (even an error boundary) — this is an
        // audit, and a crashed view is itself a finding worth seeing.
        await page.waitForTimeout(800);
        await snap(page, dir, "04-flights");
      });

      await auditStep(info, "issues board", async () => {
        await railTo(page, "Issues");
        await expect(
          page.getByPlaceholder("Filter by label, agent, flight…"),
        ).toBeVisible({ timeout: 10_000 });
        await snap(page, dir, "05-issues");
      });

      await auditStep(info, "memory", async () => {
        await railTo(page, "Memory");
        await snap(page, dir, "06-memory");
      });

      await auditStep(info, "github", async () => {
        await railTo(page, "GitHub");
        await snap(page, dir, "07-github");
      });

      // ---- Dictation (toolbar VT button) ---------------------------------
      await auditStep(info, "dictation", async () => {
        await robustClick(page, page.getByRole("button", { name: "VT" }));
        await snap(page, dir, "08-dictation");
      });

      // ---- History via command palette -----------------------------------
      await auditStep(info, "command palette (open state)", async () => {
        await robustClick(page, page.getByRole("button", { name: /Search/ }).first());
        await page.waitForTimeout(300);
        await snap(page, dir, "09-command-palette");
      });

      await auditStep(info, "history (via palette)", async () => {
        // Palette should still be open from the previous step; if not, reopen.
        const paletteInput = page.getByPlaceholder(/command|search/i).first();
        if (!(await paletteInput.isVisible().catch(() => false))) {
          await robustClick(page, page.getByRole("button", { name: /Search/ }).first());
        }
        await page.keyboard.type("history");
        await page.waitForTimeout(300);
        await robustClick(page, page.getByText("Session History", { exact: true }).first());
        await snap(page, dir, "10-history");
      });

      // ---- Settings: walk all six groups ---------------------------------
      const groups: Array<[string, string]> = [
        ["General", "11-settings-general"],
        ["Workspaces & Terminal", "12-settings-workspaces-terminal"],
        ["Agents & Models", "13-settings-agents-models"],
        ["Automation", "14-settings-automation"],
        ["Integrations & Data", "15-settings-integrations-data"],
        ["Security & Diagnostics", "16-settings-security-diagnostics"],
      ];

      await auditStep(info, "open settings", async () => {
        await railTo(page, "Settings");
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
          timeout: 10_000,
        });
      });

      for (const [label, file] of groups) {
        await auditStep(info, `settings group: ${label}`, async () => {
          await robustClick(page, page.getByRole("button", { name: label, exact: true }));
          await expect(
            page.getByRole("heading", { name: label, exact: true }),
          ).toBeVisible({ timeout: 5_000 });
          await snap(page, dir, file);
        });
      }

      // A representative sub-tab inside a group (CLI Clients).
      await auditStep(info, "settings sub-tab: CLI Clients", async () => {
        await robustClick(page, page.getByRole("button", { name: "Workspaces & Terminal", exact: true }));
        await robustClick(page, page.getByRole("button", { name: "CLI Clients", exact: true }));
        await snap(page, dir, "17-settings-cli-clients");
      });

      // ---- Modals ---------------------------------------------------------
      await auditStep(info, "new flight modal", async () => {
        await robustClick(page, page.getByRole("button", { name: "New", exact: true }));
        await robustClick(page, page.getByText("New Flight", { exact: true }));
        await page.waitForTimeout(800); // lazy chunk
        await snap(page, dir, "19-modal-new-flight");
        // Modal defaults to Escape-to-close, so dismissal is keyboard-only.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      });

      await auditStep(info, "new issue modal", async () => {
        await robustClick(page, page.getByRole("button", { name: "New", exact: true }));
        await robustClick(page, page.getByText("New Issue", { exact: true }));
        await page.waitForTimeout(400);
        await snap(page, dir, "20-modal-new-issue");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      });

      if (skipped.length > 0) {
        console.warn(`[visual-audit] ${skipped.length} step(s) skipped this run.`);
      }
    });
  });
}
