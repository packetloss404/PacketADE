/**
 * Per-conversation sidebar preferences: pinning + tags, plus a global
 * sort mode for the Agents sidebar list.
 *
 * Kept deliberately separate from `agentTaskStore` (which owns the
 * conversations themselves) so the two lanes don't collide — this store
 * only holds lightweight, UI-local metadata keyed by conversation id.
 * Persisted to localStorage via the shared `loadFromStorage`/`saveToStorage`
 * helpers, following the same pattern as the other small stores.
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

const STORAGE_KEY = "packetade:agent-sidebar-prefs";

/** Sidebar list ordering (applied within each group). */
export type SidebarSortMode = "recent" | "created" | "alpha";

export interface ConversationPrefs {
  pinned?: boolean;
  tags?: string[];
}

interface PersistedState {
  /** conversationId -> { pinned?, tags? } */
  prefs: Record<string, ConversationPrefs>;
  sortMode: SidebarSortMode;
}

interface AgentSidebarPrefsStore extends PersistedState {
  setSortMode: (mode: SidebarSortMode) => void;
  togglePinned: (conversationId: string) => void;
  addTag: (conversationId: string, tag: string) => void;
  removeTag: (conversationId: string, tag: string) => void;
}

function load(): PersistedState {
  const raw = loadFromStorage<Partial<PersistedState>>(STORAGE_KEY, {});
  const sortMode: SidebarSortMode =
    raw?.sortMode === "created" || raw?.sortMode === "alpha" ? raw.sortMode : "recent";
  // Defensive: reduce persisted prefs to the documented shape so a stale /
  // malformed entry can't leak into the sidebar render.
  const prefs: Record<string, ConversationPrefs> = {};
  for (const [id, entry] of Object.entries(raw?.prefs ?? {})) {
    const e = entry as { pinned?: unknown; tags?: unknown };
    const clean: ConversationPrefs = {};
    if (e?.pinned === true) clean.pinned = true;
    if (Array.isArray(e?.tags)) {
      const tags = (e.tags as unknown[]).filter(
        (t): t is string => typeof t === "string" && t.trim().length > 0,
      );
      if (tags.length > 0) clean.tags = tags;
    }
    if (clean.pinned || clean.tags) prefs[id] = clean;
  }
  return { prefs, sortMode };
}

function persist(state: PersistedState) {
  saveToStorage(STORAGE_KEY, { prefs: state.prefs, sortMode: state.sortMode });
}

const initial = load();

export const useAgentSidebarPrefsStore = create<AgentSidebarPrefsStore>((set) => ({
  prefs: initial.prefs,
  sortMode: initial.sortMode,

  setSortMode: (sortMode) => {
    set((s) => {
      persist({ prefs: s.prefs, sortMode });
      return { sortMode };
    });
  },

  togglePinned: (conversationId) => {
    if (!conversationId) return;
    set((s) => {
      const current = s.prefs[conversationId] ?? {};
      const next: ConversationPrefs = { ...current, pinned: !current.pinned };
      if (!next.pinned) delete next.pinned;
      const prefs = { ...s.prefs };
      if (next.pinned || (next.tags && next.tags.length > 0)) prefs[conversationId] = next;
      else delete prefs[conversationId];
      persist({ prefs, sortMode: s.sortMode });
      return { prefs };
    });
  },

  addTag: (conversationId, tag) => {
    const trimmed = tag.trim();
    if (!conversationId || !trimmed) return;
    set((s) => {
      const current = s.prefs[conversationId] ?? {};
      const tags = current.tags ?? [];
      if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return s;
      const prefs = { ...s.prefs, [conversationId]: { ...current, tags: [...tags, trimmed] } };
      persist({ prefs, sortMode: s.sortMode });
      return { prefs };
    });
  },

  removeTag: (conversationId, tag) => {
    set((s) => {
      const current = s.prefs[conversationId];
      if (!current?.tags) return s;
      const tags = current.tags.filter((t) => t !== tag);
      const next: ConversationPrefs = { ...current };
      if (tags.length > 0) next.tags = tags;
      else delete next.tags;
      const prefs = { ...s.prefs };
      if (next.pinned || (next.tags && next.tags.length > 0)) prefs[conversationId] = next;
      else delete prefs[conversationId];
      persist({ prefs, sortMode: s.sortMode });
      return { prefs };
    });
  },
}));
