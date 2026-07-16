import * as Diff from "diff";
import {
  materializeEdits,
  parseEditToolCalls,
  parseWriteFileInput,
  type CanonicalEdit,
} from "@/lib/parseToolInput";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

/**
 * Latest-wins aggregate entry for a single file in a conversation.
 * `content` is the final proposed content for `path` after replaying every
 * edit-bearing tool call (Write/Edit/MultiEdit/NotebookEdit/apply_patch/
 * write_file) on top of the recorded baseline.
 */
export interface WriteFileEntry {
  path: string;
  content: string;
  writeCount: number;
}

/**
 * Parse a `write_file` tool call into `{ path, content }`. Tolerant of both
 * stringified-JSON `input` and structured `{ input: {...} }` shapes. Returns
 * null when the call isn't a recognizable `write_file`.
 */
export function parseWriteFile(
  tc: AgentToolCall,
): { path: string; content: string } | null {
  if (tc.name !== "write_file") return null;
  return parseWriteFileInput(tc);
}

/** All canonical edits touching one path, in chronological order. */
export interface FileEditGroup {
  path: string;
  /** Chronological canonical edits (one call can contribute several paths;
   * each entry here is the slice of a call that touched THIS path). */
  edits: CanonicalEdit[];
  /** Number of edit-bearing tool calls that touched this path. */
  writeCount: number;
  /** Id of the first tool call in this run that touched the path — the key
   * for the per-call baseline (content immediately before this run's first
   * edit), which turn-scoped surfaces prefer over the conversation-level
   * first-wins baseline. */
  firstToolCallId: string;
}

/**
 * Group an ordered run of tool calls into per-path canonical edit chains.
 * This is THE transcript edit-layer walk: it fires for every provider's
 * edit tools (via `parseEditToolCalls`), not just the legacy `write_file`.
 * Pass `projectPath` so group keys are project-relative.
 */
export function collectEditGroups(
  toolCalls: Iterable<AgentToolCall>,
  projectPath?: string,
): Map<string, FileEditGroup> {
  const map = new Map<string, FileEditGroup>();
  for (const tc of toolCalls) {
    for (const edit of parseEditToolCalls(tc, projectPath)) {
      const existing = map.get(edit.path);
      if (existing) {
        existing.edits.push(edit);
        existing.writeCount += 1;
      } else {
        map.set(edit.path, {
          path: edit.path,
          edits: [edit],
          writeCount: 1,
          firstToolCallId: tc.id,
        });
      }
    }
  }
  return map;
}

/** `collectEditGroups` over every tool call in a conversation. */
export function collectConversationEditGroups(
  conv: AgentConversation | undefined,
): Map<string, FileEditGroup> {
  if (!conv) return new Map();
  return collectEditGroups(
    (function* () {
      for (const msg of conv.messages) {
        if (!msg.toolCalls?.length) continue;
        yield* msg.toolCalls;
      }
    })(),
    conv.projectPath,
  );
}

/**
 * Walk a conversation and reduce all edit-bearing tool calls into a per-path
 * map of final proposed content. Edit/MultiEdit replacement chains replay on
 * top of the recorded pre-edit baseline (editBaselineStore); paths whose
 * content can't be reproduced from the transcript (replacements with no
 * recorded baseline, or Codex patch sections that only name the path) are
 * omitted — async surfaces (`aggregateConversationDiffs`) still count them
 * by reading the applied result from disk.
 */
export function aggregateWriteFiles(
  conv: AgentConversation | undefined,
): Map<string, WriteFileEntry> {
  const map = new Map<string, WriteFileEntry>();
  if (!conv) return map;
  const getBaseline = useEditBaselineStore.getState().getBaseline;
  for (const [path, group] of collectConversationEditGroups(conv)) {
    const baseline = getBaseline(conv.id, path);
    const content = materializeEdits(group.edits, baseline?.content ?? null);
    if (content === null) continue;
    map.set(path, { path, content, writeCount: group.writeCount });
  }
  return map;
}

/**
 * Count added/removed lines between two file contents. THE shared quick
 * +N/-M counter for compact chips and summaries (one counting convention,
 * matching how the review surface's hunk engine sees the change).
 */
export function countLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
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
 * Combine a project root with a relative file path to produce the absolute
 * path expected by `writeFileContents`. Preserves the project's existing
 * separator style ('\\' on Windows project paths, '/' otherwise).
 */
export function joinAbsolutePath(
  projectPath: string,
  relPath: string,
): string {
  const usesBackslash =
    projectPath.includes("\\") && !projectPath.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const trimmedRoot = projectPath.replace(/[\\/]+$/, "");
  const trimmedRel = relPath.replace(/^[\\/]+/, "");
  const normalizedRel = usesBackslash
    ? trimmedRel.replace(/\//g, "\\")
    : trimmedRel.replace(/\\/g, "/");
  return `${trimmedRoot}${sep}${normalizedRel}`;
}
