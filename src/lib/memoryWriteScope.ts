// Resolving the scope for a memory WRITE.
//
// `useMemoryScope` derives the Memory pane's read scope from the active
// workspace. Writers are not components — they are store actions and PTY exit
// handlers — so they need the same derivation without a hook. This is that,
// and it is the only thing capture sites should call: given whichever
// workspace the work happened in, it produces the `MemoryBriefScope` that
// `memoryStore.memoryWriteKey` turns into the stamped scope key.
//
// Every writer resolves scope from a workspace id it already holds rather than
// from "whatever workspace is active right now", so a session that ends after
// the user has switched workspaces is still filed against the workspace it
// actually ran in.

import { deriveMemoryScope } from "@/lib/memoryScope";
import type { MemoryBriefScope } from "@/stores/memoryStore";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { Workspace } from "@/types/workspace";

/** Pure core: the brief scope for a workspace (or a bare path when there is none). */
export function writeScopeForWorkspace(input: {
  workspace: Workspace | undefined | null;
  fallbackProjectPath: string;
  lookupServer: (id: string) => { name: string } | undefined;
}): MemoryBriefScope {
  const scope = deriveMemoryScope({
    workspace: input.workspace,
    fallbackLocalPath: input.fallbackProjectPath,
    // `deriveMemoryScope` only reads `.name` off the server record.
    lookupServer: (id) => input.lookupServer(id) as never,
  });
  if (scope.kind === "none") {
    return { kind: "local", projectPath: input.fallbackProjectPath, workspaceId: null };
  }
  return scope.briefScope;
}

/**
 * Store-reading wrapper. `workspaceId` is what the caller knows about where
 * the work ran; `fallbackProjectPath` covers a workspace that has since been
 * deleted, or a capture with no workspace at all (a standalone conversation).
 */
export function memoryScopeForWorkspace(
  workspaceId: string | null | undefined,
  fallbackProjectPath: string,
): MemoryBriefScope {
  const workspace = workspaceId
    ? useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
    : undefined;
  return writeScopeForWorkspace({
    workspace,
    fallbackProjectPath,
    lookupServer: (id) => useServerStore.getState().servers.find((s) => s.id === id),
  });
}
