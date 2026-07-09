import { create } from "zustand";

/**
 * DISPOSABLE (P2-S3) — delete in P5-S2 together with the Agents-tab modal
 * host (`WorktreeCommitHost.tsx`).
 *
 * A one-field trigger that lets the deep-in-the-tree ReviewBar "Finish →
 * Commit…" CTA open the throwaway modal host without importing the host (and
 * therefore GitDashboard) into ReviewBar's module graph — the protected
 * ReviewBar test must stay green with only `appStore` mocked, so ReviewBar
 * carries no heavy transitive imports. The host subscribes to
 * `hostConversationId`; the CTA sets it.
 *
 * In the tile world (Phase 3+) the CTA opens GitDashboard inside the mosaic
 * workspace instead, and this store + host are removed. Kept intentionally
 * tiny so that removal is a two-file delete plus one import line in ReviewBar.
 */
interface FinishCommitHostState {
  /** The conversation whose worktree/commit surface the host is showing, or
   * null when the host is closed. */
  hostConversationId: string | null;
  /** Open the Agents-tab commit host for a conversation (called by the
   * ReviewBar CTA). */
  openFinishCommit: (conversationId: string) => void;
  /** Close the host (host backdrop / X / Escape). */
  closeFinishCommit: () => void;
}

export const useFinishCommitHost = create<FinishCommitHostState>((set) => ({
  hostConversationId: null,
  openFinishCommit: (conversationId) => set({ hostConversationId: conversationId }),
  closeFinishCommit: () => set({ hostConversationId: null }),
}));
