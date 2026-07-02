import * as Diff from "diff";
import { readFileForDiff } from "@/lib/tauri";
import { parseWriteFileInput } from "@/lib/parseToolInput";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

/* -------------------------------------------------------------------------- */
/*                              Tool-call parsing                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse a `write_file` tool call into `{ path, content }`. Tolerant of both
 * stringified-JSON `input` and structured `{ input: {...} }` shapes.
 */
function parseWriteFile(
  tc: AgentToolCall,
): { path: string; content: string } | null {
  if (tc.name !== "write_file") return null;
  return parseWriteFileInput(tc);
}

/**
 * Walk a conversation and reduce all `write_file` tool calls into the latest
 * proposed content per path (latest-wins, in chronological order).
 */
function collectLatestWrites(
  conv: AgentConversation,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of conv.messages) {
    if (!msg.toolCalls?.length) continue;
    for (const tc of msg.toolCalls) {
      const parsed = parseWriteFile(tc);
      if (!parsed) continue;
      // Latest wins.
      map.set(parsed.path, parsed.content);
    }
  }
  return map;
}

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
 * Aggregate per-file `+adds / -dels` totals across every `write_file` tool
 * call in a conversation. For each path the latest proposed content is
 * compared against the on-disk file (via the `read_file_for_diff` Tauri
 * command). Files missing on disk are treated as new (all lines counted as
 * additions).
 *
 * Errors reading individual files are swallowed and that file is skipped from
 * the totals (it still appears in `perFile` with zero counts so the caller
 * can render it sensibly).
 */
export async function aggregateConversationDiffs(
  conversation: AgentConversation,
): Promise<ConversationDiffAggregate> {
  const writes = collectLatestWrites(conversation);
  const perFile: PerFileDiffStat[] = [];
  let totalAdds = 0;
  let totalDels = 0;

  // Sequential awaits keep things simple; conversations rarely contain more
  // than a handful of distinct write_file paths and `read_file_for_diff` is
  // already cheap on the Rust side.
  for (const [path, newContent] of writes) {
    let orig: string | null = null;
    let readFailed = false;
    try {
      orig = await readFileForDiff(conversation.projectPath, path);
    } catch {
      readFailed = true;
    }

    if (readFailed) {
      perFile.push({ path, adds: 0, dels: 0, isNew: false });
      continue;
    }

    if (orig === null || orig === undefined) {
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
    fileCount: writes.size,
    totalAdds,
    totalDels,
    perFile,
  };
}
