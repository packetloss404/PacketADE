import { useMemo } from "react";
import { FileDiff, Check, X } from "lucide-react";
import * as Diff from "diff";
import type { PendingEdit } from "@/types/agent-conversation";
import { useDiffPaneStore } from "@/stores/diffPaneStore";

interface TurnDiffSummaryProps {
  conversationId: string;
  pendingEdits: PendingEdit[];
  onApplyAll: () => void;
  onDiscardAll: () => void;
}

/**
 * Count line additions / deletions across one PendingEdit. Mirrors
 * PendingEditPrompt's quick-diff counter so this banner stays consistent
 * with the per-file display.
 */
function countQuickDiff(
  before: string | undefined,
  after: string,
): { added: number; removed: number } {
  if (before === undefined) return { added: 0, removed: 0 };
  if (before === "") {
    const lines = after.length === 0 ? 0 : after.split("\n").length;
    return { added: lines, removed: 0 };
  }
  const parts = Diff.diffLines(before, after);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const trimmed = part.value.endsWith("\n")
      ? part.value.slice(0, -1)
      : part.value;
    const lines = trimmed.length === 0 ? 0 : trimmed.split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

/**
 * End-of-turn aggregate banner — appears when the agent stacks up multi-file
 * edits awaiting approval. Shows `N files · +X -Y` and three batch actions:
 *
 *  - Review all   → opens the right slide-out diff pane scoped to this convo
 *  - Accept all   → applies every staged write in one go
 *  - Discard all  → rejects every staged write
 *
 * Suppressed for single-edit turns since the per-file PendingEditPrompt
 * card already covers that case without ceremony.
 */
export function TurnDiffSummary({
  conversationId,
  pendingEdits,
  onApplyAll,
  onDiscardAll,
}: TurnDiffSummaryProps) {
  const openForConversation = useDiffPaneStore((s) => s.openForConversation);

  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const e of pendingEdits) {
      const { added, removed } = countQuickDiff(e.before, e.content);
      adds += added;
      dels += removed;
    }
    return { adds, dels, count: pendingEdits.length };
  }, [pendingEdits]);

  if (totals.count < 2) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded border-l-2 border-l-accent-green border border-bg-border bg-bg-secondary">
      <FileDiff size={12} className="text-accent-green shrink-0" />
      <span className="text-[11px] text-text-secondary flex-1 font-mono">
        {totals.count} file{totals.count === 1 ? "" : "s"} changed
        <span className="text-accent-green ml-2">+{totals.adds}</span>
        <span className="text-accent-red ml-1">-{totals.dels}</span>
      </span>
      <button
        type="button"
        onClick={() => openForConversation(conversationId)}
        className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
        title="Open the side diff pane to review every pending change"
      >
        <FileDiff size={11} /> Review all
      </button>
      <button
        type="button"
        onClick={onApplyAll}
        className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        title="Apply every staged write_file in one go"
      >
        <Check size={11} /> Accept all
      </button>
      <button
        type="button"
        onClick={onDiscardAll}
        className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        title="Reject every staged write_file"
      >
        <X size={11} /> Discard all
      </button>
    </div>
  );
}
