import * as Diff from "diff";
import { readFileForDiff } from "@/lib/tauri";
import { materializeEdits } from "@/lib/parseToolInput";
import { collectConversationEditGroups } from "@/lib/diffUtils";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import type { AgentConversation } from "@/types/agent-conversation";

/** Limit to keep prompts under model context windows for big sweeps. */
const MAX_REVIEW_BYTES = 60_000;

/**
 * Build a unified-diff prompt body for the Reviewer subagent. Walks every
 * edit-bearing tool call in the conversation (all providers, via the shared
 * canonical-edit collector), takes the recorded pre-edit baseline for the
 * "before" side (falling back to disk when none was recorded), and stitches
 * the diffs into a single markdown blob the reviewer can read in one pass.
 *
 * Returns null when there's nothing staged to review (so the caller can
 * surface a friendly "no diff" message instead of opening an empty
 * conversation).
 */
export async function buildReviewPrompt(
  conversation: AgentConversation,
): Promise<string | null> {
  const groups = collectConversationEditGroups(conversation);
  if (groups.size === 0) return null;
  const getBaseline = useEditBaselineStore.getState().getBaseline;

  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const [path, group] of groups) {
    const baseline = getBaseline(conversation.id, path);
    let orig: string | null;
    if (baseline !== undefined) {
      orig = baseline.content;
    } else {
      try {
        orig = (await readFileForDiff(conversation.projectPath, path)) ?? null;
      } catch {
        orig = null;
      }
    }
    let newContent = materializeEdits(group.edits, orig);
    if (newContent === null) {
      // Transcript can't reproduce the content (e.g. Codex apply_patch) —
      // the applied on-disk result is the truthful "after".
      try {
        newContent =
          (await readFileForDiff(conversation.projectPath, path)) ?? null;
      } catch {
        newContent = null;
      }
    }
    if (newContent === null) continue;
    const beforeLabel = orig === null ? "(new file)" : path;
    const patch = Diff.createPatch(
      path,
      orig ?? "",
      newContent,
      beforeLabel,
      path,
    );
    const block = `\n\n### ${path}\n\n\`\`\`diff\n${patch}\n\`\`\``;
    if (totalBytes + block.length > MAX_REVIEW_BYTES) {
      truncated = true;
      break;
    }
    sections.push(block);
    totalBytes += block.length;
  }

  if (sections.length === 0) return null;

  const header = `Review the following staged changes from conversation "${conversation.title}". Files: ${groups.size}.${truncated ? " (truncated to fit context)" : ""}\n\nReturn 🛑 Blockers / ⚠️ Concerns / 💡 Nits with file:line citations.`;

  return header + sections.join("");
}
