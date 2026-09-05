import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// Remote Agents fail-closed seam. `remoteAgentsSettingsStore` records user
// intent only; `src/lib/remoteAgentsGate.ts` is the single place allowed to turn
// that intent into an authorization decision, because it also requires the
// ratified private-beta gates in `dev/remoteagents/04-security.md:385`. A bare
// `settings.requested.enabled` check anywhere else would reintroduce exactly the
// fail-open this seam exists to prevent (audit F23).
//
// A `patterns` group rather than `paths`: the specifier differs by import depth
// ("@/stores/...", "./remoteAgentsSettingsStore", "../stores/..."), and a glob
// catches every form.
const REMOTE_AGENTS_STORE_RESTRICTION = {
  group: ["**/remoteAgentsSettingsStore"],
  message:
    "Remote Agents is fail-closed: import isRemoteAgentsEnabled / useRemoteAgentsEnabled / assertRemoteAgentsEnabled from @/lib/remoteAgentsGate instead. The store is user intent, not authorization.",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "src-tauri/**",
      "src/generated/**",
      "agent-sidecar/dist/**",
      // Flat-config ignore globs are root-relative, so the "dist/**" entry
      // above does NOT cover nested workspace build output. Without these,
      // linting `remoteagents` pulls in the PWA's minified bundle and the
      // shared package's emitted .js/.d.ts.
      "remoteagents/*/dist/**",
      "agent-sidecar/node_modules/**",
      ".claude/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Disable overly strict react-hooks v7 rules that flag common patterns
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
  // Tile program (P1-S2): store-isolation. The derived-projection session model
  // requires that the two engines never import each other — `agentTaskStore`
  // (headless conversations) and `workspaceStore` (placement) stay decoupled so
  // a conversation without a tile is a first-class citizen. `sessionGlue` is the
  // ONLY bridge; `sessionIndex` is a read-only projection. Enforced here so a
  // regression turns CI red rather than quietly re-coupling the stores.
  {
    files: ["src/stores/agentTaskStore.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/stores/workspaceStore",
              message:
                "Store isolation (tile program): agentTaskStore must not import workspaceStore. Bridge through sessionGlue.",
            },
            {
              name: "./workspaceStore",
              message:
                "Store isolation (tile program): agentTaskStore must not import workspaceStore. Bridge through sessionGlue.",
            },
          ],
          // Repeated because a later flat-config block REPLACES this rule rather
          // than merging into it; without this the general restriction below
          // would not apply to this file.
          patterns: [REMOTE_AGENTS_STORE_RESTRICTION],
        },
      ],
    },
  },
  {
    files: ["src/stores/workspaceStore.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/stores/agentTaskStore",
              message:
                "Store isolation (tile program): workspaceStore must not import agentTaskStore. Bridge through sessionGlue.",
            },
            {
              name: "./agentTaskStore",
              message:
                "Store isolation (tile program): workspaceStore must not import agentTaskStore. Bridge through sessionGlue.",
            },
          ],
          // See the note in the agentTaskStore block above.
          patterns: [REMOTE_AGENTS_STORE_RESTRICTION],
        },
      ],
    },
  },

  // The general case: nothing may reach the Remote Agents store directly except
  // the gate that wraps it, the store itself, and tests that exercise either.
  // Placed last so it wins for every file the two blocks above do not name; those
  // two carry the same pattern inline.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/remoteAgentsGate.ts",
      "src/stores/remoteAgentsSettingsStore.ts",
      "src/stores/agentTaskStore.ts",
      "src/stores/workspaceStore.ts",
      "src/**/__tests__/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [REMOTE_AGENTS_STORE_RESTRICTION] }],
    },
  },
);
