/**
 * Tauri IPC mock for Playwright web-mode E2E tests.
 *
 * The frontend calls Tauri commands via `@tauri-apps/api`, which under the hood
 * calls `window.__TAURI_INTERNALS__.invoke(cmd, args)`. When running against the
 * Vite dev server in a normal browser those internals are absent, so every
 * invoke would throw and crash the React tree.
 *
 * This script is injected by Playwright via `page.addInitScript` before any
 * app code runs. It installs a minimal `__TAURI_INTERNALS__` shim that returns
 * safe defaults for the commands hit during smoke tests. Extend the
 * `handlers` map as new flows need coverage.
 */
export const mockTauriInitScript = `
(() => {
  const handlers = {
    // Filesystem / project
    get_cwd: () => "",
    list_directory: () => [],
    // Git
    get_git_branch: () => null,
    get_git_status: () => ({ clean: true, staged: [], unstaged: [], untracked: [] }),
    // Statusline pollers (Claude + Codex)
    get_status_line: () => null,
    get_codex_status_line: () => null,
    // Agent detection
    detect_agents: () => ({ claude: false, codex: false }),
    // Persisted state loaders
    load_state: () => null,
    load_flights: () => [],
    load_agents: () => [],
    load_settings: () => ({}),
    // MCP / scaffold / deploy config reads
    read_mcp_config: () => ({ servers: [] }),
    read_deploy_config: () => ({}),
    list_scaffold_templates: () => [],
    // Analytics / history / cost
    get_analytics: () => ({}),
    get_prompt_history: () => [],
    get_cost_summary: () => ({}),
  };

  function invoke(cmd, _args) {
    const handler = handlers[cmd];
    if (handler) {
      try {
        return Promise.resolve(handler());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    // Unknown commands resolve to null — keeps the UI alive instead of
    // throwing, and logs so we can spot gaps while iterating on tests.
    // eslint-disable-next-line no-console
    console.warn("[mock-tauri] unhandled invoke:", cmd);
    return Promise.resolve(null);
  }

  // Tauri v2 internals
  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      // @ts-ignore
      window["_" + id] = cb;
      return id;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
  };

  // Event API no-ops
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
})();
`;
