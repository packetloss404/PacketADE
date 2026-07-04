import { useMemo } from "react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import {
  EMPTY_PENDING_EDITS,
  useAgentApprovalStore,
} from "@/stores/agentApprovalStore";
import { editSignature, useReviewStore } from "@/stores/reviewStore";
import { aggregateWriteFiles } from "@/lib/diffUtils";
import type {
  AgentConversation,
  PendingEdit,
} from "@/types/agent-conversation";

/**
 * Count the review surface's outstanding items for the Diff-tab badge:
 * every reviewable changed file whose current edit signature the user has
 * not marked Viewed, plus every gated edit still awaiting a decision.
 *
 * Only files that materialize into the reviewable list
 * (`aggregateWriteFiles` — the P1-7 guard) are counted: Codex path-only
 * descriptors and baseline-less Edit chains never appear in the surface,
 * so counting them would demand attention the user has no way to clear.
 *
 * Exported for tests.
 */
export function countUnviewedFiles(
  conversation: AgentConversation | undefined,
  viewedForConversation: Record<string, string> | undefined,
  pendingEdits: PendingEdit[],
): number {
  if (!conversation) return pendingEdits.length;
  const files = aggregateWriteFiles(conversation);
  const pendingPaths = new Set(pendingEdits.map((e) => e.path));
  let unviewed = 0;
  for (const entry of files.values()) {
    if (pendingPaths.has(entry.path)) continue; // counted as pending below
    if (viewedForConversation?.[entry.path] !== editSignature(entry)) {
      unviewed += 1;
    }
  }
  return unviewed + pendingEdits.length;
}

/** Live badge count for a conversation's Diff tab. */
export function useUnviewedCount(
  conversationId: string | null | undefined,
): number {
  const conversation = useAgentTaskStore((s) =>
    conversationId
      ? s.conversations.find((c) => c.id === conversationId)
      : undefined,
  );
  // Re-run trigger: reviewability depends on recorded baselines
  // (aggregateWriteFiles reads the baseline store via getState()).
  const baselinePaths = useEditBaselineStore((s) =>
    conversationId ? s.byConversation.get(conversationId) : undefined,
  );
  const viewedForConversation = useReviewStore((s) =>
    conversationId ? s.viewed[conversationId] : undefined,
  );
  const pendingEdits = useAgentApprovalStore((s) =>
    conversationId
      ? (s.edits.get(conversationId) ?? EMPTY_PENDING_EDITS)
      : EMPTY_PENDING_EDITS,
  );

  return useMemo(
    () => countUnviewedFiles(conversation, viewedForConversation, pendingEdits),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `baselinePaths` is a re-run trigger, not read in the body.
    [conversation, viewedForConversation, pendingEdits, baselinePaths],
  );
}
