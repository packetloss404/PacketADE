/**
 * Per-conversation composer drafts, keyed by conversation id.
 *
 * Replaces the old Ctrl+S one-slot draft stash: the chat composer writes
 * through here on every keystroke, so switching conversations never bleeds
 * a half-typed draft into another chat and never loses it. Persisted to
 * localStorage so drafts also survive an app restart. Entries are removed
 * when the draft empties (send / manual clear) and when the conversation
 * is deleted, so the persisted map stays bounded.
 *
 * Kept deliberately separate from `agentTaskStore` so per-keystroke writes
 * don't churn the store that owns the conversations themselves.
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

const STORAGE_KEY = "packetade:agent-drafts";

interface AgentDraftStore {
  /** conversationId -> in-progress composer text */
  drafts: Record<string, string>;
  setDraft: (conversationId: string, text: string) => void;
  clearDraft: (conversationId: string) => void;
}

function load(): Record<string, string> {
  const raw = loadFromStorage<Record<string, unknown>>(STORAGE_KEY, {});
  // Defensive: only accept non-empty string entries so a stale / malformed
  // payload can't leak into the composer.
  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(raw ?? {})) {
    if (typeof text === "string" && text.length > 0) drafts[id] = text;
  }
  return drafts;
}

export const useAgentDraftStore = create<AgentDraftStore>((set) => ({
  drafts: load(),

  setDraft: (conversationId, text) => {
    if (!conversationId) return;
    set((s) => {
      const drafts = { ...s.drafts };
      if (text.length === 0) delete drafts[conversationId];
      else drafts[conversationId] = text;
      saveToStorage(STORAGE_KEY, drafts);
      return { drafts };
    });
  },

  clearDraft: (conversationId) => {
    set((s) => {
      if (!(conversationId in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[conversationId];
      saveToStorage(STORAGE_KEY, drafts);
      return { drafts };
    });
  },
}));
