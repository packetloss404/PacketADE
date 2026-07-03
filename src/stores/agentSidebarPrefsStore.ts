/**
 * Per-conversation sidebar preferences: pinning only.
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

export interface ConversationPrefs {
  pinned?: boolean;
}

interface PersistedState {
  /** conversationId -> { pinned? } */
  prefs: Record<string, ConversationPrefs>;
}

interface AgentSidebarPrefsStore extends PersistedState {
  togglePinned: (conversationId: string) => void;
}

function load(): PersistedState {
  const raw = loadFromStorage<Partial<PersistedState>>(STORAGE_KEY, {});
  // Defensive: reduce persisted prefs to the documented shape so a stale /
  // malformed entry (e.g. dropped `tags`/`sortMode` fields) can't leak into
  // the sidebar render. Those stale fields are silently dropped here and
  // will not be written back on the next persist().
  const prefs: Record<string, ConversationPrefs> = {};
  for (const [id, entry] of Object.entries(raw?.prefs ?? {})) {
    const e = entry as { pinned?: unknown };
    if (e?.pinned === true) prefs[id] = { pinned: true };
  }
  return { prefs };
}

function persist(state: PersistedState) {
  saveToStorage(STORAGE_KEY, { prefs: state.prefs });
}

const initial = load();

export const useAgentSidebarPrefsStore = create<AgentSidebarPrefsStore>((set) => ({
  prefs: initial.prefs,

  togglePinned: (conversationId) => {
    if (!conversationId) return;
    set((s) => {
      const current = s.prefs[conversationId] ?? {};
      const nextPinned = !current.pinned;
      const prefs = { ...s.prefs };
      if (nextPinned) prefs[conversationId] = { pinned: true };
      else delete prefs[conversationId];
      persist({ prefs });
      return { prefs };
    });
  },
}));
