import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeMcpServerCapabilities,
  type McpCapabilityProbe,
} from "./mcp-capability.js";
import type { McpTrustSnapshot } from "./protocol.js";

// F6 — read-only enforcement is an ALLOWLIST, not a denylist.
//
// A read-only session (`allowWrites === false`) runs a tool only when the tool
// is known to be safe: either the MCP server annotated it `readOnlyHint: true`
// (folded into `allowedToolNames` by `applyMcpTrustSnapshot`) or the user
// explicitly granted it in the MCP Hub. Anything else — including every tool
// the session has never heard of — is denied. Unknown is not read-only.
//
// The verb denylist below survives as an additional FLOOR beneath that
// allowlist: it catches unambiguously mutating names even when they somehow
// reach the allowlist. It is deliberately not the primary gate, because a
// substring blocklist can only ever describe the mutations someone remembered
// to name (`edit_file`, `apply_patch`, `commit`, `chmod`, `put_object`, … all
// sailed through the original 19-word list).

/** Legacy substring pass. Catches glued-together names like `rewriteFile`. */
const MUTATING_TOOL =
  /(?:write|create|update|delete|remove|move|rename|post|send|merge|push|publish|archive|close|reopen|assign|set|execute|run)/i;

/** Token pass. Matched against `read_file` / `readFile` / `read-file` parts. */
const MUTATING_TOKENS = new Set([
  "write",
  "create",
  "update",
  "delete",
  "remove",
  "move",
  "rename",
  "post",
  "send",
  "merge",
  "push",
  "publish",
  "archive",
  "close",
  "reopen",
  "assign",
  "set",
  "execute",
  "run",
  "exec",
  "edit",
  "patch",
  "apply",
  "commit",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "append",
  "prepend",
  "put",
  "save",
  "store",
  "modify",
  "insert",
  "upsert",
  "drop",
  "truncate",
  "alter",
  "upload",
  "install",
  "uninstall",
  "mutate",
  "destroy",
  "purge",
  "wipe",
  "overwrite",
  "replace",
  "unlink",
  "mount",
  "unmount",
  "format",
  "kill",
  "terminate",
  "revoke",
  "grant",
  "restart",
  "reset",
]);

const CREDENTIAL_TOOL = /(?:credential|secret|token|password|keyring|private[_-]?key|auth)/i;
const PROTECTED_PUBLISH_TOOL = /(?:push|publish|merge|release|deploy|tag|pull[_-]?request)/i;
const PATH_KEY = /(?:path|file|folder|directory|dir|root|cwd|workspace)/i;

type ServerConfig = Record<string, unknown>;

/** Split a tool name into lowercase word tokens (`getFooBar` → get/foo/bar). */
function toolNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function suspectedMutation(toolName: string): boolean {
  if (MUTATING_TOOL.test(toolName)) return true;
  return toolNameTokens(toolName).some((token) => MUTATING_TOKENS.has(token));
}

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

/**
 * Filter the forwarded MCP servers down to the ones this session's frozen
 * authority grants, then interrogate each survivor for its real tool surface.
 *
 * For a read-only server the probe's `readOnlyHint: true` tools are unioned
 * into `allowedToolNames`, which is what `mcpToolDenial` gates on. A server
 * that cannot be probed contributes nothing, so its tools stay denied — the
 * failure mode is a session that can't reach the server, never a session that
 * reaches it with unchecked authority.
 */
export async function applyMcpTrustSnapshot(
  servers: Record<string, unknown>,
  supplied: McpTrustSnapshot[] | undefined,
  projectPath: string,
  probe: McpCapabilityProbe = probeMcpServerCapabilities,
): Promise<{
  servers: Record<string, unknown>;
  snapshots: McpTrustSnapshot[];
}> {
  const entries = Object.entries(servers).filter(
    (entry): entry is [string, ServerConfig] =>
      Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
  );
  const byName = new Map((supplied ?? []).map((snapshot) => [snapshot.serverName, snapshot]));
  const snapshots =
    supplied === undefined
      ? entries.map(([name, server]) => defaultSnapshot(name, server, projectPath))
      : supplied;
  const granted = entries.filter(([name, server]) => {
    const snapshot =
      byName.get(name) ?? snapshots.find((candidate) => candidate.serverName === name);
    if (!snapshot?.allowReads) return false;
    return transportOf(server) === "stdio" || snapshot.allowNetwork;
  });
  const filtered = Object.fromEntries(granted);

  // Probe only the servers this session can actually reach, and only when the
  // read-only allowlist depends on the answer.
  const grantedByName = new Map(granted);
  const resolved = await Promise.all(
    snapshots.map(async (snapshot) => {
      const server = grantedByName.get(snapshot.serverName);
      if (!server || snapshot.allowWrites) return snapshot;
      const result = await probe(snapshot.serverName, server, projectPath);
      if (!result.ok) {
        process.stderr.write(
          `[sidecar] MCP capability probe failed for '${snapshot.serverName}' (${result.error}); ` +
            `no tools from it will run in this read-only session\n`,
        );
        return snapshot;
      }
      const readOnly = result.tools
        .filter((tool) => tool.readOnlyHint)
        .map((tool) => tool.name);
      const allowedToolNames = Array.from(
        new Set([...snapshot.allowedToolNames, ...readOnly]),
      );
      return { ...snapshot, allowedToolNames, capabilityCheckedAt: Date.now() };
    }),
  );

  return { servers: filtered, snapshots: resolved };
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
  if (!snapshot.allowWrites) {
    // Floor first: an unambiguously mutating name is refused even when it
    // somehow reached the allowlist.
    if (suspectedMutation(toolName)) {
      return `MCP tool '${serverName}/${toolName}' looks mutating, but this session is read-only.`;
    }
    // Then the allowlist. Reaching here means the tool is neither annotated
    // `readOnlyHint: true` by its server nor granted by the user, so we cannot
    // show it is safe — and "cannot show it is safe" is a denial.
    if (!snapshot.allowedToolNames.includes(toolName)) {
      return (
        `MCP tool '${serverName}/${toolName}' is not verified read-only: its server publishes no ` +
        `readOnlyHint annotation for it and it is not in this session's allowed tool list. ` +
        `Allow the tool or enable writes for '${serverName}' in Settings → MCP Hub.`
      );
    }
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
