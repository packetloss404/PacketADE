import { create } from "zustand";

/**
 * Recorded pre-edit file baselines, keyed per conversation.
 *
 * Every edit-bearing tool call captures the file content as it was BEFORE
 * the edit ran (the runtime-side `readBefore` generalization: the sidecars
 * emit `edit_baseline` for auto-applied writes and `pending_edit.before`
 * for gated ones). Review surfaces diff proposed/applied content against
 * these baselines instead of live disk, so an applied edit keeps showing
 * its real +X/-Y instead of degrading to a +0/-0 whole-file dump.
 *
 * Two indexes:
 * - per (conversationId, path): FIRST-wins — the true pre-turn content for
 *   whole-conversation review aggregation (later calls see intermediate
 *   states, not the reviewable "before").
 * - per toolCallId: the content immediately before THAT call, for truthful
 *   per-card diffs when the same file is edited repeatedly in a turn.
 *
 * `content === null` means the file did not exist before the edit (new
 * file). Intentionally in-memory only: baselines are captured live from
 * runtime events; after an app restart consumers fall back to live disk
 * (the pre-P1-7 behavior).
 */
export interface ToolCallBaseline {
  conversationId: string;
  path: string;
  content: string | null;
}

interface EditBaselineState {
  /** conversationId → path → first-recorded pre-edit content. */
  byConversation: Map<string, Map<string, string | null>>;
  /** toolCallId → pre-edit content for that specific call. */
  byToolCall: Map<string, ToolCallBaseline>;

  /** Record a baseline. First-wins per (conversation, path) and per
   * toolCallId; later records for the same key are ignored. */
  recordBaseline: (
    conversationId: string,
    path: string,
    content: string | null,
    toolCallId?: string,
  ) => void;
  /** The conversation-level (first recorded) baseline for a path.
   * `undefined` = never recorded; `{ content: null }` = new file. */
  getBaseline: (
    conversationId: string,
    path: string,
  ) => { content: string | null } | undefined;
  /** The pre-edit content captured for one specific tool call. */
  getToolCallBaseline: (toolCallId: string) => ToolCallBaseline | undefined;

  clearConversation: (conversationId: string) => void;
}

export const useEditBaselineStore = create<EditBaselineState>((set, get) => ({
  byConversation: new Map(),
  byToolCall: new Map(),

  recordBaseline: (conversationId, path, content, toolCallId) => {
    set((s) => {
      const existingPaths = s.byConversation.get(conversationId);
      const havePath = existingPaths?.has(path) === true;
      const haveCall =
        toolCallId !== undefined && s.byToolCall.has(toolCallId);
      if (havePath && (toolCallId === undefined || haveCall)) return s;

      const next: Partial<EditBaselineState> = {};
      if (!havePath) {
        const byConversation = new Map(s.byConversation);
        const paths = new Map(existingPaths ?? []);
        paths.set(path, content);
        byConversation.set(conversationId, paths);
        next.byConversation = byConversation;
      }
      if (toolCallId !== undefined && !haveCall) {
        const byToolCall = new Map(s.byToolCall);
        byToolCall.set(toolCallId, { conversationId, path, content });
        next.byToolCall = byToolCall;
      }
      return next;
    });
  },

  getBaseline: (conversationId, path) => {
    const paths = get().byConversation.get(conversationId);
    if (!paths || !paths.has(path)) return undefined;
    return { content: paths.get(path) ?? null };
  },

  getToolCallBaseline: (toolCallId) => get().byToolCall.get(toolCallId),

  clearConversation: (conversationId) => {
    set((s) => {
      const hasConv = s.byConversation.has(conversationId);
      let hasCalls = false;
      for (const entry of s.byToolCall.values()) {
        if (entry.conversationId === conversationId) {
          hasCalls = true;
          break;
        }
      }
      if (!hasConv && !hasCalls) return s;
      const byConversation = new Map(s.byConversation);
      byConversation.delete(conversationId);
      const byToolCall = new Map(s.byToolCall);
      for (const [id, entry] of s.byToolCall) {
        if (entry.conversationId === conversationId) byToolCall.delete(id);
      }
      return { byConversation, byToolCall };
    });
  },
}));
