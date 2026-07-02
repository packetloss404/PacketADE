import { useEffect, useState } from "react";
import { aggregateConversationDiffs } from "@/lib/aggregateConversationDiffs";
import type { AgentConversation } from "@/types/agent-conversation";

export interface DiffTotals {
  fileCount: number;
  totalAdds: number;
  totalDels: number;
  /** Project-relative paths behind `fileCount`. Gated tool calls are in the
   * transcript before approval (sidecar runtimes deliver input on
   * tool_start), so pending edits usually already count here — callers must
   * union pending paths against this set instead of adding
   * `pendingEdits.length`, or one gated file displays as two. */
  paths: ReadonlySet<string>;
}

const EMPTY: DiffTotals = {
  fileCount: 0,
  totalAdds: 0,
  totalDels: 0,
  paths: new Set(),
};

/** `fileCount` plus the pending gated edits NOT already in the aggregate
 * (in-process providers deliver tool input only on tool_result, so their
 * gated edits are invisible to the transcript aggregate until applied). */
export function countReviewFiles(
  totals: DiffTotals,
  pendingEdits: readonly { path: string }[],
): number {
  let extra = 0;
  for (const edit of pendingEdits) {
    if (!totals.paths.has(edit.path)) extra += 1;
  }
  return totals.fileCount + extra;
}

/**
 * Aggregates `+adds / -dels` totals across the API conversation's write_file
 * tool calls. Recomputes whenever streaming tool calls arrive.
 */
export function useDiffTotals(
  conversation: AgentConversation | undefined,
): DiffTotals {
  // Signature that grows as write_file tool calls stream in — including extra
  // calls landing on an EXISTING assistant message, which message count alone
  // (messages.length) would miss.
  const toolCallSig =
    conversation?.messages.reduce(
      (n, m) => n + (m.toolCalls?.length ?? 0),
      0,
    ) ?? 0;
  const [totals, setTotals] = useState<DiffTotals>(EMPTY);

  useEffect(() => {
    if (!conversation || conversation.mode !== "api") {
      setTotals(EMPTY);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await aggregateConversationDiffs(conversation);
        if (cancelled) return;
        setTotals({
          fileCount: result.fileCount,
          totalAdds: result.totalAdds,
          totalDels: result.totalDels,
          paths: new Set(result.perFile.map((f) => f.path)),
        });
      } catch {
        if (!cancelled) setTotals(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Key on identity + mode + tool-call signature: streaming tool-call
    // arrivals bump the signature, which is exactly when totals can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.mode, toolCallSig]);

  return totals;
}
