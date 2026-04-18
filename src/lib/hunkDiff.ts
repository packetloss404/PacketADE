import * as Diff from "diff";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface Hunk {
  /** Stable identifier within a single (original, new) pair. */
  id: string;
  /** 1-based line number in the original content where the hunk's change begins. */
  startLine: number;
  /** Lines being removed from the original. */
  originalLines: string[];
  /** Lines being added to produce the new content. */
  newLines: string[];
  /** A few lines of unchanged context surrounding the hunk (display-only). */
  context: { before: string[]; after: string[] };
}

const CONTEXT_LINES = 3;

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split a diff `Change.value` into individual lines without dropping empty
 * trailing lines that came from the source. The `diff` package keeps a
 * trailing newline on the last segment when present; we strip the empty
 * sentinel that `String.split("\n")` produces in that case.
 */
function splitLines(value: string): string[] {
  const parts = value.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/* -------------------------------------------------------------------------- */
/*                                  parseHunks                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a unified-style hunk list from two strings. Adjacent +/- segments
 * are coalesced into a single hunk so a "replace these N lines with these M
 * lines" change is a single accept/reject unit.
 */
export function parseHunks(
  originalContent: string,
  newContent: string,
): Hunk[] {
  const parts = Diff.diffLines(originalContent, newContent);

  // Materialize each part into line arrays alongside its kind for easier
  // lookahead/lookbehind across "context" boundaries.
  type Segment = {
    kind: "context" | "added" | "removed";
    lines: string[];
  };
  const segments: Segment[] = parts.map((part) => ({
    kind: part.added ? "added" : part.removed ? "removed" : "context",
    lines: splitLines(part.value),
  }));

  const hunks: Hunk[] = [];
  let originalLineCursor = 1; // 1-based
  let hunkCounter = 0;

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];

    if (seg.kind === "context") {
      originalLineCursor += seg.lines.length;
      i += 1;
      continue;
    }

    // Coalesce a run of consecutive non-context segments into one hunk.
    const removed: string[] = [];
    const added: string[] = [];
    const hunkStartLine = originalLineCursor;
    let j = i;
    while (j < segments.length && segments[j].kind !== "context") {
      const s = segments[j];
      if (s.kind === "removed") removed.push(...s.lines);
      else if (s.kind === "added") added.push(...s.lines);
      j += 1;
    }

    // Context lines for display: the tail of the preceding context segment
    // and the head of the following one (if any).
    const beforeSeg = i > 0 ? segments[i - 1] : null;
    const afterSeg = j < segments.length ? segments[j] : null;
    const before =
      beforeSeg && beforeSeg.kind === "context"
        ? beforeSeg.lines.slice(-CONTEXT_LINES)
        : [];
    const after =
      afterSeg && afterSeg.kind === "context"
        ? afterSeg.lines.slice(0, CONTEXT_LINES)
        : [];

    hunks.push({
      id: `hunk-${hunkCounter++}-${hunkStartLine}`,
      startLine: hunkStartLine,
      originalLines: removed,
      newLines: added,
      context: { before, after },
    });

    // Advance the original-line cursor past the removed lines and skip the
    // coalesced range.
    originalLineCursor += removed.length;
    i = j;
  }

  return hunks;
}

/* -------------------------------------------------------------------------- */
/*                              applyAcceptedHunks                            */
/* -------------------------------------------------------------------------- */

/**
 * Reconstruct a final file by walking the diff in order and emitting either
 * the new lines (when a hunk is accepted) or the original lines (when a
 * hunk is rejected). Unchanged context is always preserved verbatim.
 */
export function applyAcceptedHunks(
  originalContent: string,
  hunks: Hunk[],
  acceptedIds: Set<string>,
): string {
  // Walk the original line-by-line and substitute `newLines` for any hunk
  // whose id is in `acceptedIds`. Hunks are sorted by startLine; each
  // hunk's `originalLines.length` dictates how many original lines to skip.
  const sorted = [...hunks].sort((a, b) => a.startLine - b.startLine);
  const originalLines = originalContent.split("\n");
  const hadTrailingNewline = originalContent.endsWith("\n");
  // `String.split("\n")` produces an extra empty element when the input ends
  // with "\n"; drop it so line indexing matches `startLine` (1-based) and
  // restore the trailing newline at the end if needed.
  if (hadTrailingNewline && originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const out: string[] = [];
  let cursor = 0; // 0-based index into originalLines

  for (const hunk of sorted) {
    const hunkStartIdx = hunk.startLine - 1;
    // Copy unchanged lines up to this hunk.
    while (cursor < hunkStartIdx && cursor < originalLines.length) {
      out.push(originalLines[cursor]);
      cursor += 1;
    }
    // Emit either the new or the original lines for this hunk.
    if (acceptedIds.has(hunk.id)) {
      out.push(...hunk.newLines);
    } else {
      out.push(...hunk.originalLines);
    }
    cursor += hunk.originalLines.length;
  }

  // Trailing context after the last hunk.
  while (cursor < originalLines.length) {
    out.push(originalLines[cursor]);
    cursor += 1;
  }

  return out.join("\n") + (hadTrailingNewline ? "\n" : "");
}
