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

export type McpProviderScope = "project" | "global";

export interface McpProviderConfig {
  enabled: boolean;
  port: number;
  allowedTools: string[];
  scope: McpProviderScope;
  /** Opt-in: allow the append-only handoff write tool. Default false keeps the
   *  server strictly read-only. */
  allowWrites: boolean;
}
