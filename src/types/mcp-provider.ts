// === MCP Provider Types ===
// PacketBench acting as an MCP server, exposing flights, tasks, and memory as resources.

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpProviderConfig {
  enabled: boolean;
  port: number;
  /**
   * Per-tool allowlist, ENFORCED by the Rust router (`mcp_server_start`) at
   * both `tools/list` and `tools/call` — a name absent from this list is
   * neither advertised nor callable.
   *
   * `null` means "no allowlist decided yet"; it is reconciled to the full
   * backend catalogue on the first successful `syncAvailableTools`, which
   * preserves the pre-enforcement behaviour (everything served) while making
   * every subsequent toggle real.
   *
   * NOTE: `scope` used to live here too. It was removed rather than enforced:
   * it had no backend meaning at all — the provider server reads the single
   * global `state.v1.json` and its resources (all flights, all workspaces) are
   * inherently global, so there was no "project" reading of it to implement.
   * Inventing one would have been a new feature, not a fix, and leaving it
   * would have kept a setting that implied a confinement nothing applied.
   */
  allowedTools: string[] | null;
  /** Opt-in: allow the append-only handoff write tool. Default false keeps the
   *  server strictly read-only. */
  allowWrites: boolean;
}
