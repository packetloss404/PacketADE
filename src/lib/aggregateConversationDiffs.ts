import * as Diff from "diff";
import { readFileForDiff } from "@/lib/tauri";
import { materializeEdits } from "@/lib/parseToolInput";
import { collectConversationEditGroups } from "@/lib/diffUtils";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { isRemoteConversation } from "@/lib/remoteConversation";
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
  /**
   * D3 / P0-4: set when this file's counts could NOT be computed — the disk
   * read failed, or the conversation is SSH-backed so local disk is not its
   * filesystem at all. `adds`/`dels` are 0 in this case and MUST NOT be
   * rendered as "no changes": consumers render an explicit unavailable state.
   */
  unavailable?: "read-failed" | "remote";
}

export interface ConversationDiffAggregate {
  fileCount: number;
  totalAdds: number;
  totalDels: number;
  perFile: PerFileDiffStat[];
  /** How many entries in `perFile` carry an `unavailable` reason. `> 0` means
   * the totals are a floor, not the truth — surface that in the UI. */
  unavailableCount: number;
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
 * Files whose counts cannot be computed (disk read failed, or the transcript
 * can't reproduce the content on an SSH-backed conversation where local disk
 * is not the agent's filesystem) are reported with `unavailable` set instead
 * of silently collapsing to +0/-0 — a zero-line diff and a failed diff are
 * different facts and the UI must not conflate them (D3 / P0-4).
 */
export async function aggregateConversationDiffs(
  conversation: AgentConversation,
): Promise<ConversationDiffAggregate> {
  const groups = collectConversationEditGroups(conversation);
  const getBaseline = useEditBaselineStore.getState().getBaseline;
  // SSH conversations: `projectPath` is the REMOTE path, so `read_file_for_diff`
  // would read an unrelated (usually nonexistent) local path. Recorded
  // baselines are still truthful — they came over the wire — so remote files
  // with a baseline still get real counts; only the disk fallbacks are refused.
  const remote = isRemoteConversation(conversation);
  const perFile: PerFileDiffStat[] = [];
  let totalAdds = 0;
  let totalDels = 0;
  let unavailableCount = 0;

  // Sequential awaits keep things simple; conversations rarely contain more
  // than a handful of distinct edited paths and `read_file_for_diff` is
  // already cheap on the Rust side.
  for (const [path, group] of groups) {
    const baseline = getBaseline(conversation.id, path);
    let orig: string | null = null;
    let unavailable: PerFileDiffStat["unavailable"];
    if (baseline !== undefined) {
      orig = baseline.content;
    } else if (remote) {
      unavailable = "remote";
    } else {
      try {
        orig = (await readFileForDiff(conversation.projectPath, path)) ?? null;
      } catch {
        unavailable = "read-failed";
      }
    }

    let newContent = unavailable ? null : materializeEdits(group.edits, orig);
    if (newContent === null && !unavailable) {
      // Transcript can't reproduce the content (e.g. Codex apply_patch):
      // the applied on-disk result is the truthful "after".
      if (remote) {
        unavailable = "remote";
      } else {
        try {
          newContent =
            (await readFileForDiff(conversation.projectPath, path)) ?? null;
        } catch {
          unavailable = "read-failed";
        }
      }
    }

    if (unavailable || newContent === null) {
      perFile.push({
        path,
        adds: 0,
        dels: 0,
        isNew: false,
        unavailable: unavailable ?? "read-failed",
      });
      unavailableCount += 1;
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
    unavailableCount,
  };
}
