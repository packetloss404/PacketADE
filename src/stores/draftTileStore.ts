/**
 * Draft conversation tiles (tile program, P3-S4).
 *
 * A DRAFT tile is the first-run face a chat agent drops into a workspace mosaic
 * BEFORE any conversation exists: sparkle avatar, "Describe the task to start",
 * and model/mode/worktree footer chips. Its lifecycle is deliberately EPHEMERAL
 * and lives OUTSIDE the persisted workspace schema:
 *
 *   - Picking a chat agent in `AddAgentPicker` calls `addDraft`, which mints a
 *     synthetic pane id and stores the picked runtime (agent/model/mode/worktree).
 *     `WorkspaceMosaicContainer` renders a `DraftTile` for that id.
 *   - The user's task text is held in `agentDraftStore` keyed by the draft id, so
 *     it survives tile switches and app restarts exactly like a conversation draft.
 *   - On FIRST SEND the draft calls `launchConversation` (which creates the
 *     conversation in agentTaskStore) and only THEN materializes a real
 *     conversation pane (`addConversationPane`) — the created-before-insert
 *     ordering invariant — before removing the draft. No conversation record and
 *     therefore NO orphaned "working" row ever exists before send.
 *   - Abandoning a draft (closing the tile, closing the workspace) removes it with
 *     zero persisted residue: this store is NOT written to localStorage, so an
 *     abandoned draft simply vanishes (features.md draft-abandon semantics).
 *
 * Kept separate from `workspaceStore` on purpose: draft tiles must never round-
 * trip through the persisted pane schema (a half-born pane pointing at a
 * nonexistent conversation is exactly what the ordering invariant forbids).
 */
import { create } from "zustand";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { AgentMode } from "@/components/agents/AgentModeChip";
import type { ComposerMode } from "@/components/agents/composer/utils";

let draftCounter = 0;

export interface DraftTile {
  /** Synthetic mosaic pane id — never collides with `ws-pane-*` ids. */
  id: string;
  workspaceId: string;
  agent: AgentCli;
  /** Selected model value (defaults to the provider's first model). */
  model: string;
  /** Capability-filtered safety posture (header AgentMode; P1-S4 vocabulary). */
  mode: AgentMode;
  /** Where the agent runs on launch: local tree vs a fresh worktree. */
  composerMode: ComposerMode;
}

export interface DraftTilePatch {
  model?: string;
  mode?: AgentMode;
  composerMode?: ComposerMode;
}

interface DraftTileStore {
  drafts: DraftTile[];
  /** Create a draft tile; returns its synthetic pane id. */
  addDraft: (
    workspaceId: string,
    agent: AgentCli,
    model: string,
    mode?: AgentMode,
  ) => string;
  updateDraft: (id: string, patch: DraftTilePatch) => void;
  removeDraft: (id: string) => void;
  /** Remove every draft for a workspace (e.g. when it is archived/closed). */
  removeDraftsForWorkspace: (workspaceId: string) => void;
  draftsForWorkspace: (workspaceId: string) => DraftTile[];
}

export const useDraftTileStore = create<DraftTileStore>((set, get) => ({
  drafts: [],

  addDraft: (workspaceId, agent, model, mode = "default") => {
    const id = `ws-draft-${++draftCounter}`;
    set((s) => ({
      drafts: [...s.drafts, { id, workspaceId, agent, model, mode, composerMode: "local" }],
    }));
    return id;
  },

  updateDraft: (id, patch) => {
    set((s) => ({
      drafts: s.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }));
  },

  removeDraft: (id) => {
    set((s) => {
      if (!s.drafts.some((d) => d.id === id)) return s;
      return { drafts: s.drafts.filter((d) => d.id !== id) };
    });
  },

  removeDraftsForWorkspace: (workspaceId) => {
    set((s) => {
      if (!s.drafts.some((d) => d.workspaceId === workspaceId)) return s;
      return { drafts: s.drafts.filter((d) => d.workspaceId !== workspaceId) };
    });
  },

  draftsForWorkspace: (workspaceId) =>
    get().drafts.filter((d) => d.workspaceId === workspaceId),
}));
