import * as Diff from "diff";
import { readFileForDiff } from "@/lib/tauri";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

/**
 * Parse the latest `write_file` tool call per path from a conversation.
 * Tolerant of both stringified-JSON and structured `input` shapes — same
 * logic as `aggregateConversationDiffs.collectLatestWrites`, duplicated here
 * to keep this module independent.
 */
function collectLatestWrites(conv: AgentConversation): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of conv.messages) {
    if (!msg.toolCalls?.length) continue;
    for (const tc of msg.toolCalls) {
      if (tc.name !== "write_file") continue;
      const raw = (tc as AgentToolCall & { input?: unknown }).input;
      if (raw == null) continue;
      try {
        let obj: unknown = raw;
        if (typeof raw === "string") obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          const path =
            typeof rec.path === "string"
              ? rec.path
              : typeof rec.file_path === "string"
                ? rec.file_path
                : undefined;
          const content =
            typeof rec.content === "string" ? rec.content : undefined;
          if (path && content != null) map.set(path, content);
        }
      } catch {
        // skip malformed
      }
    }
  }
  return map;
}

/** Limit to keep prompts under model context windows for big sweeps. */
const MAX_REVIEW_BYTES = 60_000;

/**
 * Build a unified-diff prompt body for the Reviewer subagent. Walks every
 * pending write_file in the conversation, reads the on-disk version for
 * the "before" side, and stitches them into a single markdown blob the
 * reviewer can read in one pass.
 *
 * Returns null when there's nothing staged to review (so the caller can
 * surface a friendly "no diff" message instead of opening an empty
 * conversation).
 */
export async function buildReviewPrompt(
  conversation: AgentConversation,
): Promise<string | null> {
  const writes = collectLatestWrites(conversation);
  if (writes.size === 0) return null;

  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const [path, newContent] of writes) {
    let orig: string | null;
    try {
      orig = await readFileForDiff(conversation.projectPath, path);
    } catch {
      orig = null;
    }
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

  const header = `Review the following staged changes from conversation "${conversation.title}". Files: ${writes.size}.${truncated ? " (truncated to fit context)" : ""}\n\nReturn 🛑 Blockers / ⚠️ Concerns / 💡 Nits with file:line citations.`;

  return header + sections.join("");
}
