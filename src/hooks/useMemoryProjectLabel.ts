import { useCallback } from "react";
import {
  memoryProjectLabel,
  type MemoryProjectLabel,
} from "@/lib/memoryProjectLabel";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/**
 * Resolve a stored memory scope key into display text, using the live server
 * and workspace records. Every surface that shows a memory record's scope goes
 * through this so a raw `ssh:srv-1:/srv/app` can never reach a human.
 */
export function useMemoryProjectLabel(): (key: string) => MemoryProjectLabel {
  const servers = useServerStore((s) => s.servers);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useCallback(
    (key: string) =>
      memoryProjectLabel(key, {
        serverName: (id) => servers.find((s) => s.id === id)?.name,
        workspaceName: (id) => workspaces.find((w) => w.id === id)?.name,
      }),
    [servers, workspaces],
  );
}
