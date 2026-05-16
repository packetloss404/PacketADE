import { create } from "zustand";
import type { PaneConfig } from "@/types/layout";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { saveWorkspacesSlice } from "@/lib/tauri";

interface LayoutStore {
  panes: PaneConfig[];
  activePaneId: string;
  /**
   * Cached project path for downstream selector consumers (e.g. git
   * pollers, MCP store, deploy store). v0.8.8: the **canonical** source of
   * truth is the active workspace's `projectPath` on `useWorkspaceStore`.
   * This field is kept in sync via a `useWorkspaceStore.subscribe(...)`
   * registered at module init — see below. Consumers should keep reading
   * `useLayoutStore((s) => s.projectPath)` exactly as before.
   */
  projectPath: string;
  /**
   * Fallback used when no workspace is active (cold start before
   * hydration, or all workspaces archived/deleted). Not surfaced as a
   * public API — read via `projectPath` instead.
   */
  fallbackProjectPath: string;

  setProjectPath: (path: string) => void;
  addPane: (opts?: { cliCommand?: string; cliArgs?: string[]; initialPrompt?: string; projectPath?: string; agentConfigId?: string; taskId?: string; flightId?: string; issueId?: string }) => string;
  removePane: (paneId: string) => void;
  setActivePaneId: (paneId: string) => void;
  setPaneSession: (paneId: string, sessionId: string | null) => void;
  getActivePane: () => PaneConfig | undefined;
}

let paneCounter = 0;
function createPaneId(): string {
  return `pane_${++paneCounter}`;
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  panes: [],
  activePaneId: "",
  projectPath: "",
  fallbackProjectPath: "",

  setProjectPath: (path) => {
    // Write-through: if there's an active local workspace, the workspace
    // record is the canonical source. We update it directly via setState
    // (workspaceStore exposes no general `updateWorkspace` action) and let
    // the subscription below mirror the new value back into `projectPath`.
    // We also always update `fallbackProjectPath` so that:
    //   - a `setProjectPath` call before any workspace exists is still
    //     readable via `projectPath` (subscription falls back to it), and
    //   - if all workspaces are later archived, the last-set value
    //     survives.
    set({ fallbackProjectPath: path });

    const ws = useWorkspaceStore.getState();
    const active = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (active && !active.serverId) {
      // Mutate via setState directly — see workspaceStore for the
      // canonical write paths used internally; we deliberately avoid
      // adding a new action surface here.
      if (active.projectPath !== path) {
        const nextWorkspaces = ws.workspaces.map((w) =>
          w.id === active.id ? { ...w, projectPath: path, updatedAt: Date.now() } : w
        );
        useWorkspaceStore.setState({ workspaces: nextWorkspaces });
        // Mirror the persistence that workspaceStore's own actions do via
        // `commitWorkspaces` → `syncToBackend`. We re-implement it here
        // (write-through to disk + localStorage cache) rather than adding
        // a new public action on workspaceStore.
        try {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("packetade:workspaces-cache", JSON.stringify(nextWorkspaces));
          }
        } catch {
          // quota / storage unavailable — backend persistence below still
          // covers the canonical record.
        }
        saveWorkspacesSlice(nextWorkspaces).catch(() => {});
      }
      // Update the cached `projectPath` immediately so synchronous
      // readers (e.g. the very next `useLayoutStore.getState().projectPath`
      // call) see the new value without waiting on the subscription tick.
      set({ projectPath: path });
    } else {
      // No active workspace (or remote) — `projectPath` reflects the
      // fallback so existing consumers continue to read a value.
      set({ projectPath: path });
    }
  },

  addPane: (opts) => {
    const id = createPaneId();
    set((state) => ({
      panes: [
        ...state.panes,
        {
          id,
          sessionId: null,
          cliCommand: opts?.cliCommand ?? "claude",
          cliArgs: opts?.cliArgs,
          initialPrompt: opts?.initialPrompt,
          projectPath: opts?.projectPath,
          agentConfigId: opts?.agentConfigId,
          taskId: opts?.taskId,
          flightId: opts?.flightId,
          issueId: opts?.issueId,
        },
      ],
      activePaneId: id,
    }));
    return id;
  },

  removePane: (paneId) => {
    set((state) => {
      const panes = state.panes.filter((p) => p.id !== paneId);
      const activePaneId =
        state.activePaneId === paneId
          ? (panes[panes.length - 1]?.id ?? "")
          : state.activePaneId;
      return { panes, activePaneId };
    });
  },

  setActivePaneId: (paneId) => set({ activePaneId: paneId }),

  setPaneSession: (paneId, sessionId) => {
    set((state) => ({
      panes: state.panes.map((p) =>
        p.id === paneId ? { ...p, sessionId } : p
      ),
    }));
  },

  getActivePane: () => {
    const state = get();
    return state.panes.find((p) => p.id === state.activePaneId);
  },

}));

/**
 * Mirror workspaceStore's "active workspace projectPath" into
 * `useLayoutStore.projectPath`. Deferred via `queueMicrotask` so that the
 * subscription is registered after both module evaluations complete (the
 * two stores import each other lazily inside function bodies, so the
 * circular dep is safe at runtime, but the subscription call itself must
 * wait until `useWorkspaceStore` is fully defined).
 *
 * The subscription fires on **any** workspaceStore mutation and computes
 * the effective local projectPath from scratch — we don't bother with a
 * shallow equality optimisation because the dominant cost is the React
 * re-render of selector consumers, which already short-circuits when the
 * value is unchanged.
 */
function installWorkspaceProjectPathSync() {
  if (typeof useWorkspaceStore?.subscribe !== "function") return;
  useWorkspaceStore.subscribe((state) => {
    const layout = useLayoutStore.getState();
    const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId);

    let next: string;
    if (!active) {
      // No active workspace at all (cold start, or every workspace was
      // archived/deleted). Fall back to whatever was last written via
      // `setProjectPath` — that's the "explicit user-set path" channel.
      next = layout.fallbackProjectPath;
    } else if (active.serverId) {
      // Active workspace is remote — its `projectPath` lives on the remote
      // host and would confuse local-only features (git pollers, file
      // watcher, MCP, deploy). Preserve whatever local path is currently
      // showing so the UI doesn't flicker to blank when the user switches
      // to a remote workspace.
      return;
    } else {
      next = active.projectPath ?? "";
    }

    if (next !== layout.projectPath) {
      useLayoutStore.setState({ projectPath: next });
    }
  });
}

if (typeof queueMicrotask === "function") {
  queueMicrotask(installWorkspaceProjectPathSync);
} else {
  // Test/SSR environments may lack queueMicrotask — fall back to a
  // resolved-promise microtask.
  Promise.resolve().then(installWorkspaceProjectPathSync);
}
