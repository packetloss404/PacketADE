import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpTrustSnapshot } from "./protocol.js";

const MUTATING_TOOL =
  /(?:write|create|update|delete|remove|move|rename|post|send|merge|push|publish|archive|close|reopen|assign|set|execute|run)/i;
const CREDENTIAL_TOOL = /(?:credential|secret|token|password|keyring|private[_-]?key|auth)/i;
const PROTECTED_PUBLISH_TOOL = /(?:push|publish|merge|release|deploy|tag|pull[_-]?request)/i;
const PATH_KEY = /(?:path|file|folder|directory|dir|root|cwd|workspace)/i;

type ServerConfig = Record<string, unknown>;

function transportOf(server: ServerConfig): "stdio" | "http" | "sse" {
  return server.type === "http" || server.type === "sse" ? server.type : "stdio";
}

function defaultSnapshot(
  serverName: string,
  server: ServerConfig,
  projectPath: string,
): McpTrustSnapshot {
  return {
    schemaVersion: 1,
    serverId: `runtime:${serverName}`,
    serverName,
    workspacePath: projectPath || null,
    allowReads: true,
    allowWrites: false,
    // A stdio process is locally owned. This is not an OS network sandbox;
    // remote HTTP/SSE transports remain denied until explicitly granted.
    allowNetwork: transportOf(server) === "stdio",
    allowedRoots: projectPath ? [projectPath] : [],
    allowedToolNames: [],
    denialFloors: ["credentials", "outside_workspace", "protected_publish"],
    revision: 1,
    updatedAt: Date.now(),
  };
}

export function applyMcpTrustSnapshot(
  servers: Record<string, unknown>,
  supplied: McpTrustSnapshot[] | undefined,
  projectPath: string,
): {
  servers: Record<string, unknown>;
  snapshots: McpTrustSnapshot[];
} {
  const entries = Object.entries(servers).filter(
    (entry): entry is [string, ServerConfig] =>
      Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
  );
  const byName = new Map((supplied ?? []).map((snapshot) => [snapshot.serverName, snapshot]));
  const snapshots =
    supplied === undefined
      ? entries.map(([name, server]) => defaultSnapshot(name, server, projectPath))
      : supplied;
  const filtered = Object.fromEntries(
    entries.filter(([name, server]) => {
      const snapshot =
        byName.get(name) ?? snapshots.find((candidate) => candidate.serverName === name);
      if (!snapshot?.allowReads) return false;
      return transportOf(server) === "stdio" || snapshot.allowNetwork;
    }),
  );
  return { servers: filtered, snapshots };
}

function flattenPathArguments(value: unknown, key = "", output: string[] = []): string[] {
  if (typeof value === "string" && PATH_KEY.test(key)) {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenPathArguments(item, key, output);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      flattenPathArguments(child, childKey, output);
    }
  }
  return output;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  let normalizedCandidate = candidate;
  if (candidate.startsWith("file:")) {
    try {
      normalizedCandidate = fileURLToPath(candidate);
    } catch {
      return false;
    }
  }
  const resolvedCandidate = path.resolve(resolvedRoot, normalizedCandidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function mcpPathDenial(snapshot: McpTrustSnapshot, input: unknown): string | null {
  if (!snapshot.denialFloors.includes("outside_workspace")) return null;
  const roots = snapshot.allowedRoots.filter(Boolean);
  const paths = flattenPathArguments(input);
  if (
    paths.some(
      (candidate) => roots.length === 0 || !roots.some((root) => isInsideRoot(candidate, root)),
    )
  ) {
    return "MCP path access outside the frozen workspace roots is blocked.";
  }
  return null;
}

export function mcpToolDenial(
  serverName: string,
  toolName: string,
  input: unknown,
  snapshots: McpTrustSnapshot[] | undefined,
): string | null {
  const snapshot = snapshots?.find((candidate) => candidate.serverName === serverName);
  if (!snapshot || !snapshot.allowReads) {
    return `MCP server '${serverName}' is not granted to this session.`;
  }
  if (snapshot.capabilityCheckedAt !== undefined && !snapshot.allowedToolNames.includes(toolName)) {
    return `MCP tool '${serverName}/${toolName}' was not in the session's frozen capability allowlist.`;
  }
  if (snapshot.denialFloors.includes("credentials") && CREDENTIAL_TOOL.test(toolName)) {
    return "MCP credential access is blocked by a non-overridable denial floor.";
  }
  if (
    snapshot.denialFloors.includes("protected_publish") &&
    PROTECTED_PUBLISH_TOOL.test(toolName)
  ) {
    return "MCP publish/merge/deploy operations are blocked by a non-overridable denial floor.";
  }
  if (!snapshot.allowWrites && MUTATING_TOOL.test(toolName)) {
    return `MCP tool '${serverName}/${toolName}' looks mutating, but this session is read-only.`;
  }
  return mcpPathDenial(snapshot, input);
}

export function parseAnthropicMcpToolName(
  name: string,
): { serverName: string; toolName: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const separator = name.indexOf("__", "mcp__".length);
  if (separator < 0) return null;
  return {
    serverName: name.slice("mcp__".length, separator),
    toolName: name.slice(separator + 2),
  };
}

export function allowedMcpToolNames(
  snapshot: McpTrustSnapshot,
  discoveredNames?: string[],
): string[] | undefined {
  const candidates =
    snapshot.capabilityCheckedAt !== undefined ? snapshot.allowedToolNames : discoveredNames;
  if (!candidates) return undefined;
  return candidates.filter(
    (name) => mcpToolDenial(snapshot.serverName, name, {}, [snapshot]) === null,
  );
}
