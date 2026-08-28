import { useMemo } from "react";
import { deriveMemoryScope, type MemoryScope } from "@/lib/memoryScope";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/**
 * The scope the Memory pane should use. Follows the same pattern as
 * `useGitInfo`: read the local-only `layoutStore.projectPath` mirror, but
 * resolve against the active workspace so a remote workspace is never
 * silently scoped to a stale local project path.
 */
export function useMemoryScope(): MemoryScope {
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const fallbackLocalPath = useLayoutStore((s) => s.projectPath);
  const servers = useServerStore((s) => s.servers);

  return useMemo(
    () =>
      deriveMemoryScope({
        workspace,
        fallbackLocalPath,
        lookupServer: (id) => servers.find((s) => s.id === id),
      }),
    [workspace, fallbackLocalPath, servers],
  );
}
