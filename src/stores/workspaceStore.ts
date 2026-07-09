import { create } from "zustand";
import type { Workspace, WorkspacePane, WorkspaceAgentSlot } from "@/types/workspace";
import { saveWorkspacesSlice } from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";


export interface WorkspaceSessionConfig {
  prompt?: string;
  modelOverrides?: Record<string, string | null>;
  effortOverrides?: Record<string, string | null>;
  bypassPermissions?: boolean;
  serverId?: string;
  remoteProjectPath?: string;
  /**
   * v0.8-15: auto-bound GitHub repo, derived from `git remote get-url
   * origin` at workspace-creation time. Stamped onto `Workspace.githubRepo`.
   */
  githubRepo?: { owner: string; repo: string };
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /**
   * v0.8 setting: when true, the New Workspace modal pre-checks the
   * "Bypass permission prompts" toggle. Per-workspace state is still
   * stored on the Workspace itself; this only affects the initial
   * value at creation time.
   */
  defaultBypassPermissions: boolean;
  /**
   * v0.8 setting: when true (default), workspace creation runs
   * `git remote get-url origin` against the local project path and
   * stamps the parsed `{owner, repo}` onto the workspace as
   * `githubRepo`. Disable to skip the probe entirely (the user can
   * still bind manually later).
   */
  autoBindGithubRepo: boolean;
  zoomedPaneId: string | null;

  createWorkspace: (name: string, agents: WorkspaceAgentSlot[], projectPath: string, sessionConfig?: WorkspaceSessionConfig) => string;
  archiveWorkspace: (id: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  getActiveWorkspace: () => Workspace | undefined;
  setBypassPermissions: (workspaceId: string, bypass: boolean) => void;
  setPaneSession: (workspaceId: string, paneId: string, sessionId: string | null) => void;
  updatePane: (workspaceId: string, paneId: string, updates: Partial<WorkspacePane>) => void;
  addPinnedCommand: (workspaceId: string, paneId: string, command: string) => void;
  setModelOverride: (workspaceId: string, agentId: string, model: string | null) => void;
  removePinnedCommand: (workspaceId: string, paneId: string, index: number) => void;
  addPane: (workspaceId: string, agentId: WorkspaceAgentSlot) => string | null;
  removePane: (workspaceId: string, paneId: string) => void;
  /**
   * Tile program (P1-S2): prune every conversation pane referencing
   * `conversationId` across all workspaces. Drives the one-directional GC in
   * `sessionGlue`: deleting a conversation removes its tiles, but closing a
   * tile (`removePane`) NEVER deletes the conversation. Reference direction is
   * pane→conversationId only.
   */
  removeConversationPanes: (conversationId: string) => void;
  /**
   * Tile program (P1-S2): idempotently materialize the conversation wrapper
   * workspace for `conversationId`. Uses the deterministic id
   * `ws-wrap-<convId>` and stamps `origin: "conversation"`, so calling twice
   * yields exactly one workspace. Returns the wrapper id. Does NOT activate the
   * workspace — `sessionGlue.openSession` orchestrates activation. Conversation
   * panes carry the inert carrier `agentId: "terminal"` and are never pushed
   * into `agents`.
   */
  ensureConversationWorkspace: (opts: {
    conversationId: string;
    name: string;
    projectPath: string;
  }) => string;
  setDefaultBypassPermissions: (value: boolean) => void;
  setAutoBindGithubRepo: (value: boolean) => void;
  setZoomedPane: (paneId: string | null) => void;
  hydrateFromBackend: (workspaces?: Workspace[]) => void;
}

const DEFAULT_BYPASS_KEY = "packetade:workspace-default-bypass";
const AUTO_BIND_GITHUB_KEY = "packetade:workspace-auto-bind-github";

function readBooleanFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

function writeBooleanFlag(key: string, value: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Best-effort — runtime state still updates.
  }
}

let wsCounter = 0;

function buildPanes(agents: WorkspaceAgentSlot[]): WorkspacePane[] {
  return agents.map((agent) => ({
    id: `ws-pane-${++wsCounter}`,
    agentId: agent,
    sessionId: null,
  }));
}

const WORKSPACES_CACHE_KEY = "packetade:workspaces-cache";

/**
 * Tile program (P1-S2): deterministic wrapper-workspace id for a conversation.
 * The `openSession` materialization and the reconciliation sweep both key off
 * this exact shape (`ws-wrap-<convId>`) so a conversation maps to at most one
 * wrapper and repeated opens are idempotent.
 */
export function conversationWrapperId(conversationId: string): string {
  return `ws-wrap-${conversationId}`;
}

/**
 * Tile program (P1-S1): defensive normalization of a single pane read from an
 * untrusted source (the blindly-`JSON.parse`d localStorage cache, or backend
 * hydration).
 *
 * - Missing/blank `kind` ⇒ terminal (absent kind means terminal — an old cache
 *   or an old binary that never wrote the field degrades cleanly).
 * - `kind` is the SOLE discriminant; `agentId` is never overloaded. Conversation
 *   panes carry the inert carrier `agentId: "terminal"`.
 * - Invariant `conversationId set iff kind === "conversation"` is enforced: a
 *   pane tagged conversation but missing a string `conversationId` self-heals to
 *   a plain terminal pane (the inert-carrier arm — the sweep half of self-heal
 *   lands in P1-S2). A terminal pane never keeps a stray `conversationId`.
 * - Malformed panes (not an object, or no string `id`) are dropped.
 * - Unknown fields are preserved (forward-compat with a newer build's cache).
 *
 * Returns `null` for a pane that should be dropped.
 */
function normalizePane(raw: unknown): WorkspacePane | null {
  if (!raw || typeof raw !== "object") return null;
  const pane = raw as Record<string, unknown>;
  if (typeof pane.id !== "string") return null;

  const isConversation =
    pane.kind === "conversation" && typeof pane.conversationId === "string";

  // Preserve unknown fields, then override the discriminant pair so the
  // invariant always holds regardless of what was on disk.
  const normalized = { ...pane } as Record<string, unknown>;
  if (isConversation) {
    normalized.kind = "conversation";
    normalized.conversationId = pane.conversationId;
  } else {
    normalized.kind = "terminal";
    delete normalized.conversationId;
  }
  return normalized as unknown as WorkspacePane;
}

/**
 * Tile program (P1-S1): apply {@link normalizePane} across every workspace's
 * panes, dropping any pane that fails to normalize. Applied to BOTH the
 * localStorage cache and backend hydration so a conversation pane round-trips
 * and a stripped-carrier pane self-heals to a terminal.
 */
export function normalizePanes(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((w) => ({
    ...w,
    panes: Array.isArray(w.panes)
      ? w.panes
          .map((pane) => normalizePane(pane))
          .filter((pane): pane is WorkspacePane => pane !== null)
      : [],
  }));
}

/**
 * Read the cached workspace list from localStorage. Lets the welcome screen
 * render with workspaces on day-2+ launches before the backend round-trip
 * completes — avoids the brief empty → populated flicker.
 */
function loadCachedWorkspaces(): Workspace[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const cached = localStorage.getItem(WORKSPACES_CACHE_KEY);
    if (!cached) return [];
    const parsed = JSON.parse(cached);
    return Array.isArray(parsed) ? normalizePanes(parsed as Workspace[]) : [];
  } catch {
    return [];
  }
}

function syncToLocalStorage(workspaces: Workspace[]) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WORKSPACES_CACHE_KEY, JSON.stringify(workspaces));
  } catch {
    // Quota exceeded or storage unavailable — silent fail
  }
}

function syncToBackend(workspaces: Workspace[]) {
  saveWorkspacesSlice(workspaces).catch(logSwallowed("workspaceStore.save"));
  syncToLocalStorage(workspaces);
}

function commitWorkspaces(
  updater: (state: Pick<WorkspaceStore, "workspaces" | "activeWorkspaceId">) => Partial<WorkspaceStore>,
) {
  return (state: WorkspaceStore): Partial<WorkspaceStore> => {
    const next = updater(state);
    if (next.workspaces) {
      syncToBackend(next.workspaces);
    }
    return next;
  };
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: loadCachedWorkspaces(),
  activeWorkspaceId: null,
  defaultBypassPermissions: readBooleanFlag(DEFAULT_BYPASS_KEY, false),
  autoBindGithubRepo: readBooleanFlag(AUTO_BIND_GITHUB_KEY, true),
  zoomedPaneId: null,

  setDefaultBypassPermissions: (value) => {
    writeBooleanFlag(DEFAULT_BYPASS_KEY, value);
    set({ defaultBypassPermissions: value });
  },

  setAutoBindGithubRepo: (value) => {
    writeBooleanFlag(AUTO_BIND_GITHUB_KEY, value);
    set({ autoBindGithubRepo: value });
  },

  createWorkspace: (name, agents, projectPath, sessionConfig) => {
    const serverId = sessionConfig?.serverId;
    const remoteProjectPath = sessionConfig?.remoteProjectPath;

    if (serverId) {
      // Remote workspace: serverId must point to a real registered server
      // and we require an explicit remote project path. The pane launch
      // code in WorkspacePane.tsx reads `workspace.remoteProjectPath` so
      // we need it stored on the workspace itself.
      const server = useServerStore.getState().getServer(serverId);
      if (!server) {
        throw new Error(`createWorkspace: serverId "${serverId}" does not match any registered server`);
      }
      if (!remoteProjectPath || !remoteProjectPath.trim()) {
        throw new Error("createWorkspace: remoteProjectPath is required when serverId is set");
      }
    }

    // For remote workspaces the legacy `projectPath` becomes the remote
    // path string so any code that reads `workspace.projectPath` without
    // checking `serverId` still gets a stable label (used in workspace
    // headers, history, etc.). Local-only operations must guard with
    // `if (!workspace.serverId)` — see e.g. `IdeationView.handleGenerate`.
    const effectiveProjectPath = serverId
      ? (remoteProjectPath ?? "").trim() || projectPath
      : projectPath;

    const id = crypto.randomUUID();
    const now = Date.now();
    const workspace: Workspace = {
      id,
      name,
      agents,
      panes: buildPanes(agents),
      projectPath: effectiveProjectPath,
      prompt: sessionConfig?.prompt,
      createdAt: now,
      updatedAt: now,
      status: "active",
      bypassPermissions: sessionConfig?.bypassPermissions ?? false,
      modelOverrides: sessionConfig?.modelOverrides,
      effortOverrides: sessionConfig?.effortOverrides,
      serverId,
      remoteProjectPath,
      githubRepo: sessionConfig?.githubRepo,
    };
    set(commitWorkspaces((s) => {
      const workspaces = [...s.workspaces, workspace];
      return { workspaces, activeWorkspaceId: id };
    }));
    return id;
  },

  archiveWorkspace: (id) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) =>
        w.id === id ? { ...w, status: "archived" as const, updatedAt: Date.now() } : w
      );
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    }));
  },

  deleteWorkspace: (id) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    }));
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    if (id) {
      const workspace = get().workspaces.find((w) => w.id === id);
      // Only sync `layoutStore.projectPath` for local workspaces — for
      // remote workspaces the path is on the remote host and would
      // confuse local-only features (file watcher, git dashboard, etc.).
      if (workspace && !workspace.serverId) {
        useLayoutStore.getState().setProjectPath(workspace.projectPath);
      }
    }
  },

  getActiveWorkspace: () => {
    const s = get();
    return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  },

  setBypassPermissions: (workspaceId, bypass) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, bypassPermissions: bypass, updatedAt: Date.now() }
          : w
      );
      return { workspaces };
    }));
  },

  setPaneSession: (workspaceId, paneId, sessionId) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) =>
            p.id === paneId ? { ...p, sessionId } : p
          ),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  updatePane: (workspaceId, paneId, updates) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) =>
            p.id === paneId ? { ...p, ...updates } : p
          ),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  setModelOverride: (workspaceId, agentId, model) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const overrides = { ...(w.modelOverrides ?? {}) };
        if (model === null) {
          delete overrides[agentId];
        } else {
          overrides[agentId] = model;
        }
        return { ...w, modelOverrides: overrides, updatedAt: Date.now() };
      });
      return { workspaces };
    }));
  },

  addPinnedCommand: (workspaceId, paneId, command) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) => {
            if (p.id !== paneId) return p;
            const existing = p.pinnedCommands ?? [];
            if (existing.includes(trimmed)) return p;
            if (existing.length >= 5) return p;
            return { ...p, pinnedCommands: [...existing, trimmed] };
          }),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  removePinnedCommand: (workspaceId, paneId, index) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) => {
            if (p.id !== paneId) return p;
            const existing = p.pinnedCommands ?? [];
            return { ...p, pinnedCommands: existing.filter((_, i) => i !== index) };
          }),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  addPane: (workspaceId, agentId) => {
    const newPaneId = `ws-pane-${++wsCounter}`;
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const newPane: WorkspacePane = {
          id: newPaneId,
          agentId,
          sessionId: null,
        };
        return {
          ...w,
          agents: [...w.agents, agentId],
          panes: [...w.panes, newPane],
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
    return newPaneId;
  },

  removePane: (workspaceId, paneId) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const pane = w.panes.find((p) => p.id === paneId);
        if (!pane) return w;
        return {
          ...w,
          panes: w.panes.filter((p) => p.id !== paneId),
          agents: (() => {
            // Tile program (P1-S1): `agents` is keyed on `kind`, not agentId.
            // Conversation panes were never pushed into `agents` (they carry the
            // inert carrier agentId "terminal"), so removing one must NOT splice
            // a real terminal out of the agents list. Skip the mutation.
            if (pane.kind === "conversation") return w.agents;
            // Remove one occurrence of this agent from the agents list
            const idx = w.agents.indexOf(pane.agentId);
            if (idx === -1) return w.agents;
            const copy = [...w.agents];
            copy.splice(idx, 1);
            return copy;
          })(),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
    // Clear zoom if the zoomed pane was removed
    if (get().zoomedPaneId === paneId) {
      set({ zoomedPaneId: null });
    }
  },

  removeConversationPanes: (conversationId) => {
    const removedPaneIds: string[] = [];
    set(commitWorkspaces((s) => {
      let changed = false;
      const workspaces = s.workspaces.map((w) => {
        const kept = w.panes.filter((p) => {
          const match = p.kind === "conversation" && p.conversationId === conversationId;
          if (match) removedPaneIds.push(p.id);
          return !match;
        });
        if (kept.length === w.panes.length) return w;
        changed = true;
        return { ...w, panes: kept, updatedAt: Date.now() };
      });
      // No referencing pane anywhere — skip the backend write entirely.
      if (!changed) return {};
      return { workspaces };
    }));
    // Clear zoom if the zoomed pane was one of the pruned conversation panes.
    if (get().zoomedPaneId && removedPaneIds.includes(get().zoomedPaneId as string)) {
      set({ zoomedPaneId: null });
    }
  },

  ensureConversationWorkspace: ({ conversationId, name, projectPath }) => {
    const id = conversationWrapperId(conversationId);
    // Idempotent: a wrapper already exists ⇒ reuse it. Never overwrite the
    // existing name (the user may have renamed it — live-follow freezes on
    // first manual rename, a Phase 4 concern) or duplicate the workspace.
    if (get().workspaces.some((w) => w.id === id)) return id;
    const now = Date.now();
    const pane: WorkspacePane = {
      id: `ws-pane-${++wsCounter}`,
      // Inert carrier — conversation panes persist agentId "terminal" so a
      // downgraded binary renders a harmless terminal pane; `kind` is the sole
      // discriminant.
      agentId: "terminal",
      sessionId: null,
      kind: "conversation",
      conversationId,
    };
    const workspace: Workspace = {
      id,
      name,
      // Conversation panes are never pushed into `agents` (P1-S1 ruling) — a
      // pure conversation wrapper starts with an empty agents list.
      agents: [],
      panes: [pane],
      projectPath,
      createdAt: now,
      updatedAt: now,
      status: "active",
      origin: "conversation",
    };
    set(commitWorkspaces((s) => ({ workspaces: [...s.workspaces, workspace] })));
    return id;
  },

  setZoomedPane: (paneId) => {
    set({ zoomedPaneId: paneId });
  },

  hydrateFromBackend: (workspaces) => {
    if (workspaces) {
      // Tile program (P1-S1): normalize on the way in from the backend too, so
      // a stripped-carrier conversation pane self-heals and missing kinds
      // default to terminal before anything renders.
      const normalized = normalizePanes(workspaces);
      set({ workspaces: normalized });
      syncToLocalStorage(normalized);
    }
  },
}));
