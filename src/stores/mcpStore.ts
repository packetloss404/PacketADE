import { create } from "zustand";
import type { McpServerEntry } from "@/types/mcp";
import { readMcpServers, writeMcpServer, deleteMcpServer } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";

interface McpStore {
  servers: McpServerEntry[];
  loading: boolean;
  error: string | null;

  fetchServers: () => Promise<void>;
  addServer: (
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    scope: "global" | "project"
  ) => Promise<void>;
  /**
   * Edit an existing server.
   *
   * `previousScope` is where the entry currently lives. Global and project
   * servers are separate FILES (`~/.claude/settings.json` vs `<project>/.mcp.json`),
   * so an edit that changes the scope has to remove the old row — without it,
   * `write_mcp_server` just upserts into the other file and the user ends up
   * with the same server name defined twice, in two scopes, differing only in
   * whatever they just edited. Omit it when the scope cannot have changed.
   */
  updateServer: (
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    scope: "global" | "project",
    previousScope?: "global" | "project"
  ) => Promise<void>;
  removeServer: (name: string, scope: "global" | "project") => Promise<void>;
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  loading: false,
  error: null,

  fetchServers: async () => {
    set({ loading: true, error: null });
    try {
      const projectPath = useLayoutStore.getState().projectPath;
      const servers = await readMcpServers(projectPath);
      set({ servers, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  addServer: async (name, command, args, env, scope) => {
    const projectPath = useLayoutStore.getState().projectPath;
    await writeMcpServer(projectPath, name, command, args, env, scope);
    await get().fetchServers();
  },

  updateServer: async (name, command, args, env, scope, previousScope) => {
    const projectPath = useLayoutStore.getState().projectPath;
    // Write the destination FIRST. If the delete then fails the user has a
    // duplicate, which is recoverable; the other order can lose the server.
    await writeMcpServer(projectPath, name, command, args, env, scope);
    if (previousScope && previousScope !== scope) {
      await deleteMcpServer(projectPath, name, previousScope);
    }
    await get().fetchServers();
  },

  removeServer: async (name, scope) => {
    const projectPath = useLayoutStore.getState().projectPath;
    await deleteMcpServer(projectPath, name, scope);
    await get().fetchServers();
  },
}));
