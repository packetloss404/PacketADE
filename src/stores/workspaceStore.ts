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

/**
 * Tile program (P4-S1): a transient focus+flash request. `requestPaneFocus`
 * publishes one; the target tile (ConversationTile / WorkspacePane) reads it to
 * render a brief flash. `token` makes each request distinct so re-focusing the
 * SAME pane re-triggers the flash, and the auto-clear only nulls the request it
 * itself scheduled (never a newer one). Never carries zoom — focus+flash only.
 */
export interface PaneFocusRequest {
  workspaceId: string;
  paneId: string;
  token: number;
}

/**
 * Tile program (P4-S1): how long a focus flash lingers before the store clears
 * the request. The tile derives its flash purely from the live request, so this
 * governs the flash duration everywhere.
 */
export const PANE_FLASH_MS = 1200;

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /**
   * Tile program (P4-S1): the current focus+flash request, or null. Set by
   * {@link WorkspaceStore.requestPaneFocus} (needs-you clicks, P5 deep links);
   * auto-cleared after {@link PANE_FLASH_MS}. NEVER touches zoom.
   */
  focusPaneRequest: PaneFocusRequest | null;
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

  createWorkspace: (
    name: string,
    agents: WorkspaceAgentSlot[],
    projectPath: string,
    sessionConfig?: WorkspaceSessionConfig,
  ) => string;
  archiveWorkspace: (id: string) => void;
  restoreWorkspace: (id: string) => void;
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
  setDefaultBypassPermissions: (value: boolean) => void;
  setAutoBindGithubRepo: (value: boolean) => void;
  setZoomedPane: (paneId: string | null) => void;
  /**
   * Tile program (P4-S1): NET-NEW focus+flash plumbing (no such symbol existed
   * before). Activates `workspaceId`, sets `layoutStore.activePaneId` to
   * `paneId`, and publishes a transient {@link PaneFocusRequest} that the target
   * tile flashes. NEVER auto-zooms, NEVER rearranges. The request auto-clears
   * after {@link PANE_FLASH_MS}. Drives needs-you clicks (P4-S2) and notification
   * deep links (P5).
   */
  requestPaneFocus: (workspaceId: string, paneId: string) => void;
  /**
   * Tile program (P4-S1): clear the focus request. Pass the `token` of the
   * request you intend to clear so a stale auto-clear can't null a newer
   * request; omit to clear unconditionally.
   */
  clearPaneFocusRequest: (token?: number) => void;
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

/**
 * F50: mint a collision-safe pane id. The prior `ws-pane-${++counter}` scheme
 * restarted from 0 on every reload, so a freshly-minted pane could collide with
 * a persisted pane that had claimed the same low number in an earlier session
 * (duplicate keys → React reconciliation clobbering the wrong pane). Minting
 * from `crypto.randomUUID()` — the same source the workspace id uses — makes the
 * id unique across reloads. The `ws-pane-` prefix is retained so old persisted
 * ids (opaque strings) keep working untouched.
 */
function mintPaneId(): string {
  return `ws-pane-${crypto.randomUUID()}`;
}

/**
 * Tile program (P4-S1): monotonic token source for {@link PaneFocusRequest}.
 * Module-scoped so tokens stay unique across the store's lifetime (a fresh
 * token every request re-triggers the flash even for the same pane).
 */
let focusToken = 0;

function buildPanes(agents: WorkspaceAgentSlot[]): WorkspacePane[] {
  return agents.map((agent) => ({
    id: mintPaneId(),
    agentId: agent,
    sessionId: null,
  }));
}

const WORKSPACES_CACHE_KEY = "packetade:workspaces-cache";

/**
 * Historical deterministic wrapper-workspace id for a conversation. New
 * attachments are retired, but migration and cleanup tests still recognize
 * this shape so saved `ws-wrap-<convId>` layouts remain safe.
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

  const isConversation = pane.kind === "conversation" && typeof pane.conversationId === "string";

  // Preserve unknown fields, then override the discriminant pair so the
  // invariant always holds regardless of what was on disk. PTY ids are
  // runtime-only: the owning OS processes died with the previous app process,
  // so hydrating a persisted id would expose a stale write/kill target.
  const normalized = { ...pane } as Record<string, unknown>;
  normalized.sessionId = null;
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
  updater: (
    state: Pick<WorkspaceStore, "workspaces" | "activeWorkspaceId">,
  ) => Partial<WorkspaceStore>,
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
  focusPaneRequest: null,
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
        throw new Error(
          `createWorkspace: serverId "${serverId}" does not match any registered server`,
        );
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
    set(
      commitWorkspaces((s) => {
        const workspaces = [...s.workspaces, workspace];
        return { workspaces, activeWorkspaceId: id };
      }),
    );
    return id;
  },

  archiveWorkspace: (id) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) =>
          w.id === id ? { ...w, status: "archived" as const, updatedAt: Date.now() } : w,
        );
        const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
        return { workspaces, activeWorkspaceId };
      }),
    );
  },

  restoreWorkspace: (id) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((workspace) =>
          workspace.id === id
            ? { ...workspace, status: "active" as const, updatedAt: Date.now() }
            : workspace,
        );
        return { workspaces, activeWorkspaceId: id };
      }),
    );
  },

  deleteWorkspace: (id) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== id);
        const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
        return { workspaces, activeWorkspaceId };
      }),
    );
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
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, bypassPermissions: bypass, updatedAt: Date.now() } : w,
        );
        return { workspaces };
      }),
    );
  },

  setPaneSession: (workspaceId, paneId, sessionId) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            panes: w.panes.map((p) => (p.id === paneId ? { ...p, sessionId } : p)),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
  },

  updatePane: (workspaceId, paneId, updates) => {
    set(
      commitWorkspaces((s) => {
        const workspaces = s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            panes: w.panes.map((p) => (p.id === paneId ? { ...p, ...updates } : p)),
            updatedAt: Date.now(),
          };
        });
        return { workspaces };
      }),
    );
  },

  setModelOverride: (workspaceId, agentId, model) => {
    set(
      commitWorkspaces((s) => {
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
      }),
    );
  },

  addPinnedCommand: (workspaceId, paneId, command) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    set(
      commitWorkspaces((s) => {
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
      }),
    );
  },

  removePinnedCommand: (workspaceId, paneId, index) => {
    set(
      commitWorkspaces((s) => {
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
      }),
    );
  },

  addPane: (workspaceId, agentId) => {
    const newPaneId = mintPaneId();
    set(
      commitWorkspaces((s) => {
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
      }),
    );
    return newPaneId;
  },

  removePane: (workspaceId, paneId) => {
    set(
      commitWorkspaces((s) => {
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
      }),
    );
    // Clear zoom if the zoomed pane was removed
    if (get().zoomedPaneId === paneId) {
      set({ zoomedPaneId: null });
    }
  },

  removeConversationPanes: (conversationId) => {
    const removedPaneIds: string[] = [];
    set(
      commitWorkspaces((s) => {
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
      }),
    );
    // Clear zoom if the zoomed pane was one of the pruned conversation panes.
    if (get().zoomedPaneId && removedPaneIds.includes(get().zoomedPaneId as string)) {
      set({ zoomedPaneId: null });
    }
  },

  setZoomedPane: (paneId) => {
    set({ zoomedPaneId: paneId });
  },

  requestPaneFocus: (workspaceId, paneId) => {
    // Activate the workspace and set mosaic focus through the EXISTING
    // mechanisms — no new focus machinery (setActiveWorkspace syncs projectPath;
    // layoutStore.activePaneId is the real mosaic focus). Zoom is deliberately
    // untouched: focus+flash only, never auto-zoom, never rearrange.
    get().setActiveWorkspace(workspaceId);
    useLayoutStore.getState().setActivePaneId(paneId);
    const token = ++focusToken;
    set({ focusPaneRequest: { workspaceId, paneId, token } });
    // Transient: the flash clears itself so a stale highlight never lingers.
    // The token guard means a newer request supersedes rather than being
    // cancelled by this timer.
    if (typeof setTimeout === "function") {
      setTimeout(() => {
        get().clearPaneFocusRequest(token);
      }, PANE_FLASH_MS);
    }
  },

  clearPaneFocusRequest: (token) => {
    set((s) => {
      if (!s.focusPaneRequest) return {};
      // Only clear the matching request when a token is supplied, so a
      // late-firing auto-clear can't wipe a fresher focus.
      if (token !== undefined && s.focusPaneRequest.token !== token) return {};
      return { focusPaneRequest: null };
    });
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
