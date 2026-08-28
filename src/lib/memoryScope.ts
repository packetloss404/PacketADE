// What the Memory pane is scoped to.
//
// `layoutStore.projectPath` is a LOCAL-only mirror: when the active workspace
// is remote, the sync in `layoutStore.ts` deliberately early-returns and keeps
// the previously-open local project's path, so local-only features (git
// pollers, file watcher, MCP, deploy) don't get handed a remote path. That is
// correct for those consumers — `useGitInfo` reads the mirror and checks
// `isLocalWorkspace` before trusting it.
//
// The Memory pane never made that check, so on a remote workspace it silently
// scoped patterns, the brief, Ask, and project notes to a DIFFERENT project,
// and its writes stamped that other project's path. This module derives the
// scope from the active workspace instead, and never falls back to the local
// mirror for a remote workspace.

import type { MemoryBriefScope } from "@/stores/memoryStore";
import { remoteMemoryProjectKey } from "@/stores/memoryStore";
import type { ServerConfig } from "@/types/server";
import {
  executionTargetForWorkspace,
  isLocalWorkspace,
  type Workspace,
} from "@/types/workspace";

export type MemoryScope =
  | { kind: "none" }
  | {
      kind: "local";
      projectPath: string;
      workspaceId: string | null;
      briefScope: MemoryBriefScope;
    }
  | {
      kind: "ssh";
      serverId: string;
      serverName: string;
      remotePath: string;
      workspaceId: string;
      memoryProjectKey: string;
      briefScope: MemoryBriefScope;
    };

/** Last path segment, separator-agnostic, tolerating trailing separators. */
export function scopeBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

export function deriveMemoryScope(input: {
  workspace: Workspace | undefined | null;
  fallbackLocalPath: string;
  lookupServer: (id: string) => ServerConfig | undefined;
}): MemoryScope {
  const { workspace, fallbackLocalPath, lookupServer } = input;

  // No active workspace (cold start, everything archived). The explicit
  // user-set path channel is still authoritative.
  if (!workspace) {
    if (!fallbackLocalPath) return { kind: "none" };
    return {
      kind: "local",
      projectPath: fallbackLocalPath,
      workspaceId: null,
      briefScope: { kind: "local", projectPath: fallbackLocalPath, workspaceId: null },
    };
  }

  if (isLocalWorkspace(workspace)) {
    const projectPath = workspace.projectPath || fallbackLocalPath;
    if (!projectPath) return { kind: "none" };
    return {
      kind: "local",
      projectPath,
      workspaceId: workspace.id,
      briefScope: { kind: "local", projectPath, workspaceId: workspace.id },
    };
  }

  // Remote. Never fall back to the local mirror — that fallback IS the bug.
  const target = executionTargetForWorkspace(workspace);
  const serverId = target.kind === "ssh" ? target.serverId : "";
  const remotePath = workspace.remoteProjectPath ?? workspace.projectPath ?? "";
  return {
    kind: "ssh",
    serverId,
    serverName: lookupServer(serverId)?.name ?? serverId,
    remotePath,
    workspaceId: workspace.id,
    memoryProjectKey: remoteMemoryProjectKey(serverId, remotePath),
    briefScope: {
      kind: "ssh",
      projectPath: remotePath,
      workspaceId: workspace.id,
      serverId,
      remotePath,
    },
  };
}
