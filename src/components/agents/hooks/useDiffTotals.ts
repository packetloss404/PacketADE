import { useEffect, useState } from "react";
import { aggregateConversationDiffs } from "@/lib/aggregateConversationDiffs";
import type { AgentConversation } from "@/types/agent-conversation";

interface DiffTotals {
  fileCount: number;
  totalAdds: number;
  totalDels: number;
}

const EMPTY: DiffTotals = { fileCount: 0, totalAdds: 0, totalDels: 0 };

/**
 * Aggregates `+adds / -dels` totals across the API conversation's write_file
 * tool calls. Recomputes whenever streaming tool calls arrive.
 */
export function useDiffTotals(
  conversation: AgentConversation | undefined,
): DiffTotals {
  const messageCount = conversation?.messages.length ?? 0;
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
        });
      } catch {
        if (!cancelled) setTotals(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Key on identity + mode + message count: streaming tool-call arrivals
    // bump the count, which is exactly when totals can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.mode, messageCount]);

  return totals;
}
