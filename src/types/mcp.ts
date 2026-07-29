export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpTransport = "stdio" | "http" | "sse";
export type McpExecutionOwner = "local" | "ssh" | "packetade-provider";

export interface McpCapabilitySnapshot {
  schemaVersion: 1;
  state: "unknown" | "connected" | "degraded" | "failed";
  transport: McpTransport;
  latencyMs?: number;
  tools: Array<{ name: string; description: string }>;
  compatibilityVersion: string;
  checkedAt: number;
  message: string;
}

export interface McpTrustProfile {
  schemaVersion: 1;
  serverId: string;
  workspacePath: string | null;
  allowReads: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  /** Absolute roots the server may receive in path-like tool arguments.
   * Empty means no filesystem roots are granted. */
  allowedRoots: string[];
  allowedToolNames: string[];
  denialFloors: Array<"credentials" | "outside_workspace" | "protected_publish">;
  revision: number;
  updatedAt: number;
}

export interface McpTrustSnapshot extends McpTrustProfile {
  serverName: string;
  capabilityCheckedAt?: number;
}

export interface McpCatalogManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  officialSource: string;
  platforms: Array<"windows" | "macos" | "linux">;
  transport: McpTransport;
  command: string;
  args: string[];
  requiredSecrets: string[];
  capabilitySummary: string[];
  removal: string;
  needsNetwork: boolean;
  /** Exact install/runtime reason the reviewed entry may use the network. */
  networkUse: string;
}

export interface McpServerDiagnostic {
  state: "connected" | "degraded" | "failed";
  transport: McpTransport;
  latencyMs?: number;
  tools: Array<{ name: string; description: string }>;
  message: string;
  compatibilityVersion: string;
  checkedAt: number;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  rawConfig?: Record<string, unknown>;
  scope: "global" | "project";
  disabled: boolean;
}

export function mcpServerId(server: Pick<McpServerEntry, "scope" | "name">): string {
  return `${server.scope}:${server.name}`;
}

export function mcpServerTransport(server: McpServerEntry): McpTransport {
  const type = server.rawConfig?.type;
  if (type === "http" || type === "sse") return type;
  return "stdio";
}
