// Rendering a memory record's scope.
//
// A memory record's `projectPath` used to always be a filesystem path, so
// every surface that displayed it just took the last path segment. Since
// remote capture landed it can also be a synthetic scope key —
// `ssh:<serverId>:<remotePath>` — and a raw `ssh:srv-1:/srv/app` must never
// reach a human. This module is the single place that turns a stored key into
// something readable ("build-box · app"), and it degrades gracefully when the
// server no longer exists (an imported export from another machine, or a
// deleted connection): the id stands in for the name rather than the label
// collapsing to the raw key.

import { scopeBasename } from "@/lib/memoryScope";

export type ParsedMemoryProjectKey =
  | { kind: "ssh"; serverId: string; remotePath: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "path"; path: string };

/**
 * Split a stored scope key into its parts.
 *
 * The remote form is `ssh:<serverId>:<path>`. Server ids never contain `:`,
 * but a path can (a Windows drive letter), so only the FIRST separator after
 * the prefix is structural and everything after it is the path.
 */
export function parseMemoryProjectKey(key: string): ParsedMemoryProjectKey {
  if (key.startsWith("ssh:")) {
    const rest = key.slice(4);
    const split = rest.indexOf(":");
    if (split > 0) {
      return {
        kind: "ssh",
        serverId: rest.slice(0, split),
        remotePath: rest.slice(split + 1),
      };
    }
    // Malformed (`ssh:` with no second separator). Treat the whole thing as a
    // path so it still renders as *something* rather than throwing.
    return { kind: "path", path: key };
  }
  if (key.startsWith("workspace:")) {
    return { kind: "workspace", workspaceId: key.slice("workspace:".length) };
  }
  return { kind: "path", path: key };
}

export interface MemoryProjectLabel {
  /** Compact chip text, e.g. "build-box · app". */
  label: string;
  /** Full text for a `title` tooltip. */
  title: string;
  kind: ParsedMemoryProjectKey["kind"];
  /** True when the key names a server this install no longer knows about. */
  unresolvedServer: boolean;
}

export interface MemoryProjectLabelLookups {
  serverName?: (serverId: string) => string | undefined;
  workspaceName?: (workspaceId: string) => string | undefined;
}

/** Human-facing rendering of one stored scope key. Pure. */
export function memoryProjectLabel(
  key: string,
  lookups: MemoryProjectLabelLookups = {},
): MemoryProjectLabel {
  const parsed = parseMemoryProjectKey(key);

  if (parsed.kind === "ssh") {
    const name = lookups.serverName?.(parsed.serverId);
    const unresolvedServer = !name;
    const shown = name ?? parsed.serverId;
    return {
      label: `${shown} · ${scopeBasename(parsed.remotePath)}`,
      title: unresolvedServer
        ? `Remote workspace on an unknown server (${parsed.serverId}) — ${parsed.remotePath}`
        : `Remote workspace on ${shown} — ${parsed.remotePath}`,
      kind: "ssh",
      unresolvedServer,
    };
  }

  if (parsed.kind === "workspace") {
    const name = lookups.workspaceName?.(parsed.workspaceId);
    return {
      label: name ?? `Workspace ${parsed.workspaceId.slice(-6)}`,
      title: name
        ? `Workspace "${name}" (${parsed.workspaceId})`
        : `Workspace ${parsed.workspaceId}`,
      kind: "workspace",
      unresolvedServer: false,
    };
  }

  return {
    label: scopeBasename(parsed.path) || parsed.path,
    title: parsed.path,
    kind: "path",
    unresolvedServer: false,
  };
}

/** Convenience for the many places that only need the chip text. */
export function memoryProjectLabelText(
  key: string,
  lookups: MemoryProjectLabelLookups = {},
): string {
  return memoryProjectLabel(key, lookups).label;
}
