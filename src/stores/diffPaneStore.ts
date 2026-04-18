import { create } from "zustand";

/**
 * Right-side slide-out diff pane state.
 *
 * Mirrors the Claude Code Desktop pattern: a persistent pane that aggregates
 * all `write_file` tool calls from a single conversation into a per-file diff
 * browser. State is intentionally ephemeral (not persisted) — the pane should
 * always reopen closed when the app restarts.
 */
interface DiffPaneStore {
  open: boolean;
  conversationId: string | null;
  selectedFilePath: string | null;
  openForConversation: (conversationId: string, path?: string) => void;
  close: () => void;
  selectFile: (path: string) => void;
}

export const useDiffPaneStore = create<DiffPaneStore>((set) => ({
  open: false,
  conversationId: null,
  selectedFilePath: null,
  openForConversation: (conversationId, path) =>
    set({
      open: true,
      conversationId,
      selectedFilePath: path ?? null,
    }),
  close: () =>
    set({
      open: false,
      // Keep conversationId/selectedFilePath so re-opening returns to the same
      // place during the session; only `open` flips.
    }),
  selectFile: (path) => set({ selectedFilePath: path }),
}));
