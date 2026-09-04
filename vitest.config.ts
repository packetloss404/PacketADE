import { defineConfig, defaultExclude } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Test-environment split.
 *
 * Building a jsdom environment is the single largest cost in this suite
 * (~730s of accumulated `environment` time across 285 files at the time this
 * was introduced), and the ~200 tests under `src/lib` and `src/stores` are
 * mostly pure logic that never touches the DOM. So the suite is split into two
 * Vitest projects: `dom` (jsdom) and `node` (no DOM at all).
 *
 * `test.projects` is the API for this. `environmentMatchGlobs` was deprecated
 * in Vitest 3 and is **gone** in Vitest 4 (4.1.2 here — the option no longer
 * exists in `node_modules/vitest/dist/**` types), and the per-file
 * `// @vitest-environment` docblock is likewise no longer honoured, so the glob
 * list below is the only mechanism available.
 *
 * `DOM_TEST_GLOBS` is the single source of truth: the `dom` project includes
 * exactly these, the `node` project excludes exactly these. Adding a test that
 * touches `window`/`document`/React Testing Library/xterm means adding it here.
 *
 * `localStorage` is NOT a reason to be listed: both setup files install a
 * memory-backed `Storage` on `globalThis`, so persisted Zustand stores work
 * identically under either environment.
 */
const DOM_TEST_GLOBS = [
  // Whole directories that are DOM-bound by construction.
  "src/__tests__/**/*.{test,spec}.{ts,tsx}",
  "src/components/**/*.{test,spec}.{ts,tsx}",
  "src/hooks/**/*.{test,spec}.{ts,tsx}",
  // Any TSX test anywhere renders components.
  "src/**/*.{test,spec}.tsx",

  // Individual non-component tests that genuinely need a DOM.
  //
  // The three below are here for a specific, verified reason: their subjects
  // branch on `typeof window` and go deliberately inert without one
  // (`dictationStore.ts:171` gates Tauri event listeners on
  // `"__TAURI_INTERNALS__" in window`; `analyticsStore.ts:156` returns a null
  // storage when `window` is undefined). Under node they would not fail
  // honestly — they would pass through a disabled code path or throw on a
  // listener that was never registered. Keep them on jsdom rather than
  // loosening a production browser guard to suit the test runner.
  "src/stores/__tests__/analyticsStoreGuardrails.test.ts",
  "src/stores/__tests__/dictationStore.test.ts",
  "src/lib/__tests__/usageStatusline.test.ts",
  // Drives `apiAgentListeners`, whose notification path calls
  // `document.hasFocus()` (`src/lib/notifications.ts:10`). Without a DOM this
  // surfaced as an unhandled rejection that left every test "passing" while
  // the run still exited non-zero.
  "src/stores/__tests__/agentWorkspaceDecoupling.test.ts",

  "src/lib/__tests__/dictationTarget.test.ts",
  "src/lib/__tests__/keyboardTarget.test.ts",
  "src/lib/__tests__/openInEditor.test.ts",
  "src/lib/__tests__/storage-migration.test.ts",
  "src/lib/__tests__/storage.test.ts",
  // Patches `Storage.prototype` and probes `window.__TAURI_INTERNALS__`, and
  // asserts against a real `sessionStorage`; the node shim supplies neither.
  "src/lib/__tests__/storageMirror.test.ts",
  "src/stores/__tests__/agentDraftStore.test.ts",
  "src/stores/__tests__/notificationStore.test.ts",
  "src/stores/__tests__/persistenceMigration.test.ts",
  "src/stores/__tests__/terminalSettingsStore.test.ts",
];

const ALL_TEST_GLOBS = [
  "src/**/*.{test,spec}.{ts,tsx}",
  "scripts/**/*.{test,spec}.{mjs,ts}",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    // Import cost, not test work, dominates this suite (~500s of accumulated
    // `import` time). Under full-suite parallelism a handful of store tests
    // therefore blow the 5s default while passing in well under a second when
    // run alone — a false failure that reports as a product bug. The budget is
    // deliberately generous: it exists to absorb machine contention, not to
    // let a genuinely hung test sit for a minute.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          globals: true,
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: DOM_TEST_GLOBS,
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          globals: true,
          environment: "node",
          setupFiles: ["./src/test/setup.node.ts"],
          include: ALL_TEST_GLOBS,
          exclude: [...defaultExclude, ...DOM_TEST_GLOBS],
        },
      },
    ],
  },
});
