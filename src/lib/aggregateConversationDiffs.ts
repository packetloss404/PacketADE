import * as Diff from "diff";
import { readFileForDiff } from "@/lib/tauri";
import { materializeEdits } from "@/lib/parseToolInput";
import { collectConversationEditGroups } from "@/lib/diffUtils";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import type { AgentConversation } from "@/types/agent-conversation";

/* -------------------------------------------------------------------------- */
/*                                 Line counts                                */
/* -------------------------------------------------------------------------- */

function countDiffLines(parts: Diff.Change[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lines = part.value.endsWith("\n")
      ? part.value.split("\n").length - 1
      : part.value.split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

/* -------------------------------------------------------------------------- */
/*                                Public API                                  */
/* -------------------------------------------------------------------------- */

export interface PerFileDiffStat {
  path: string;
  adds: number;
  dels: number;
  isNew: boolean;
}

export interface ConversationDiffAggregate {
  fileCount: number;
  totalAdds: number;
  totalDels: number;
  perFile: PerFileDiffStat[];
}

/**
 * Aggregate per-file `+adds / -dels` totals across every edit-bearing tool
 * call in a conversation (write_file / Write / Edit / MultiEdit /
 * NotebookEdit / apply_patch, via the shared canonical-edit collector).
 *
 * The "before" side is the recorded pre-edit baseline (editBaselineStore)
 * when one exists — never live disk — so applied edits keep their real
 * counts instead of degrading to +0/-0 once the file is written. Disk (via
 * `read_file_for_diff`) is only a fallback: for "before" when no baseline
 * was recorded (legacy sessions, app restarts) and for "after" when the
 * transcript can't reproduce the final content (Codex apply_patch), in
 * which case the applied on-disk result IS the after.
 *
 * Errors reading individual files are swallowed and that file is skipped
 * from the totals (it still appears in `perFile` with zero counts so the
 * caller can render it sensibly).
 */
export async function aggregateConversationDiffs(
  conversation: AgentConversation,
): Promise<ConversationDiffAggregate> {
  const groups = collectConversationEditGroups(conversation);
  const getBaseline = useEditBaselineStore.getState().getBaseline;
  const perFile: PerFileDiffStat[] = [];
  let totalAdds = 0;
  let totalDels = 0;

  // Sequential awaits keep things simple; conversations rarely contain more
  // than a handful of distinct edited paths and `read_file_for_diff` is
  // already cheap on the Rust side.
  for (const [path, group] of groups) {
    const baseline = getBaseline(conversation.id, path);
    let orig: string | null = null;
    let readFailed = false;
    if (baseline !== undefined) {
      orig = baseline.content;
    } else {
      try {
        orig = (await readFileForDiff(conversation.projectPath, path)) ?? null;
      } catch {
        readFailed = true;
      }
    }

    let newContent = materializeEdits(group.edits, orig);
    if (newContent === null && !readFailed) {
      // Transcript can't reproduce the content (e.g. Codex apply_patch):
      // the applied on-disk result is the truthful "after".
      try {
        newContent =
          (await readFileForDiff(conversation.projectPath, path)) ?? null;
      } catch {
        readFailed = true;
      }
    }

    if (readFailed || newContent === null) {
      perFile.push({ path, adds: 0, dels: 0, isNew: false });
      continue;
    }

    if (orig === null) {
      // New file — every line is an addition.
      const adds = newContent.split("\n").length;
      perFile.push({ path, adds, dels: 0, isNew: true });
      totalAdds += adds;
      continue;
    }

    const parts = Diff.diffLines(orig, newContent);
    const { added, removed } = countDiffLines(parts);
    perFile.push({ path, adds: added, dels: removed, isNew: false });
    totalAdds += added;
    totalDels += removed;
  }

  perFile.sort((a, b) => a.path.localeCompare(b.path));

  return {
    fileCount: groups.size,
    totalAdds,
    totalDels,
    perFile,
  };
}
