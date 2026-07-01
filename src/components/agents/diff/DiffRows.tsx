import { memo, type ReactNode } from "react";
import * as Diff from "diff";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import type { Hunk } from "@/lib/hunkDiff";

/*
 * Shared diff rendering engine used by both HunkSelectableDiff and
 * ToolDiffView. Produces interleaved unified-diff rows (a removed line is
 * immediately followed by its added counterpart), tracks old/new line
 * numbers for the gutter, and renders each row with a background-only tint
 * (never full-line colored text) plus a colored +/- gutter marker.
 *
 * Syntax highlighting reuses the app's existing react-syntax-highlighter
 * (Prism) setup — the same one MarkdownRenderer registers — so no new
 * dependency is introduced. Colors are token-based; the diff tint lives on
 * the row background, orthogonal to the syntax colors.
 */

// Reuse the same Prism languages MarkdownRenderer registers. Registration is
// idempotent across modules that share the singleton PrismLight instance.
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("markdown", markdown);

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  css: "css",
  scss: "css",
  md: "markdown",
  markdown: "markdown",
};

/**
 * Resolve a Prism language key from a file path's extension. Returns
 * `undefined` for unknown extensions so callers fall back to plain
 * (un-highlighted) monospace text.
 */
export function languageForPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()];
}

/**
 * Above this many rows we skip per-line syntax highlighting to keep large
 * whole-file diffs responsive; the diff still renders (gutter + tint) as
 * plain monospace text.
 */
export const MAX_HIGHLIGHT_ROWS = 800;

export type DiffRowKind = "add" | "del" | "context";

export interface DiffRow {
  /** Stable key within a single diff for React reconciliation. */
  key: string;
  kind: DiffRowKind;
  text: string;
  /** 1-based line number in the OLD file, or null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the NEW file, or null for removed lines. */
  newLine: number | null;
}

/** The comment anchor a row maps to: removed lines belong to the OLD file,
 * added + context lines to the NEW file (matches the prior ToolDiffView
 * semantics so queued diff comments keep the same coordinates). */
export function rowAnchor(row: DiffRow): { side: "old" | "new"; line: number } {
  if (row.kind === "del") return { side: "old", line: row.oldLine ?? 0 };
  return { side: "new", line: row.newLine ?? 0 };
}

function splitLines(value: string): string[] {
  const parts = value.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

type Seg = { kind: DiffRowKind; lines: string[] };

function segmentsFromParts(parts: Diff.Change[]): Seg[] {
  return parts.map((part) => ({
    kind: part.added ? "add" : part.removed ? "del" : "context",
    lines: splitLines(part.value),
  }));
}

/**
 * Emit interleaved rows for `segments` starting at the given 1-based
 * old/new line cursors. A run of consecutive add/del segments is coalesced
 * and then interleaved line-by-line (del[0], add[0], del[1], add[1]…) so a
 * "replace" reads as removed-then-its-replacement rather than all-removed
 * followed by all-added.
 */
function emitRows(
  segments: Seg[],
  keyPrefix: string,
  startOldLine: number,
  startNewLine: number,
): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = startOldLine;
  let newLine = startNewLine;
  let counter = 0;

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.kind === "context") {
      for (const line of seg.lines) {
        rows.push({
          key: `${keyPrefix}-${counter++}`,
          kind: "context",
          text: line,
          oldLine: oldLine++,
          newLine: newLine++,
        });
      }
      i += 1;
      continue;
    }

    // Coalesce a run of consecutive change segments, then interleave.
    const removed: string[] = [];
    const added: string[] = [];
    let j = i;
    while (j < segments.length && segments[j].kind !== "context") {
      if (segments[j].kind === "del") removed.push(...segments[j].lines);
      else added.push(...segments[j].lines);
      j += 1;
    }
    const max = Math.max(removed.length, added.length);
    for (let k = 0; k < max; k++) {
      if (k < removed.length) {
        rows.push({
          key: `${keyPrefix}-${counter++}`,
          kind: "del",
          text: removed[k],
          oldLine: oldLine++,
          newLine: null,
        });
      }
      if (k < added.length) {
        rows.push({
          key: `${keyPrefix}-${counter++}`,
          kind: "add",
          text: added[k],
          oldLine: null,
          newLine: newLine++,
        });
      }
    }
    i = j;
  }

  return rows;
}

/** Build interleaved rows for a full (old, new) content pair. */
export function buildDiffRows(
  oldContent: string,
  newContent: string,
): DiffRow[] {
  const parts = Diff.diffLines(oldContent, newContent);
  return emitRows(segmentsFromParts(parts), "d", 1, 1);
}

/**
 * Build interleaved rows for a single parsed hunk, including its display
 * context. `newLineDelta` is the cumulative (added − removed) line count of
 * all preceding hunks so the NEW gutter stays consistent with the whole
 * file even though hunks are rendered in isolation.
 */
export function buildHunkRows(hunk: Hunk, newLineDelta: number): DiffRow[] {
  const beforeStartOld = hunk.startLine - hunk.context.before.length;
  const segments: Seg[] = [];
  if (hunk.context.before.length > 0)
    segments.push({ kind: "context", lines: hunk.context.before });
  if (hunk.originalLines.length > 0)
    segments.push({ kind: "del", lines: hunk.originalLines });
  if (hunk.newLines.length > 0)
    segments.push({ kind: "add", lines: hunk.newLines });
  if (hunk.context.after.length > 0)
    segments.push({ kind: "context", lines: hunk.context.after });

  return emitRows(
    segments,
    hunk.id,
    beforeStartOld,
    beforeStartOld + newLineDelta,
  );
}

/* -------------------------------------------------------------------------- */
/*                              Row rendering                                 */
/* -------------------------------------------------------------------------- */

const HighlightedCode = memo(function HighlightedCode({
  text,
  language,
}: {
  text: string;
  language?: string;
}) {
  if (!text) return <span>&nbsp;</span>;
  if (!language) return <span>{text}</span>;
  return (
    <SyntaxHighlighter
      language={language}
      style={oneDark}
      PreTag="span"
      CodeTag="span"
      useInlineStyles
      customStyle={{
        background: "transparent",
        padding: 0,
        margin: 0,
        display: "inline",
        overflow: "visible",
        fontSize: "inherit",
        fontFamily: "inherit",
        whiteSpace: "pre",
      }}
      codeTagProps={{
        style: {
          background: "transparent",
          fontSize: "inherit",
          fontFamily: "inherit",
          whiteSpace: "pre",
        },
      }}
    >
      {text}
    </SyntaxHighlighter>
  );
});

const TINT: Record<DiffRowKind, string> = {
  add: "bg-accent-green/10",
  del: "bg-accent-red/10",
  context: "",
};

const MARKER_GLYPH: Record<DiffRowKind, string> = {
  add: "+",
  del: "-",
  context: " ",
};

const MARKER_CLASS: Record<DiffRowKind, string> = {
  add: "text-accent-green",
  del: "text-accent-red",
  context: "text-text-faint",
};

export interface DiffRowViewProps {
  row: DiffRow;
  /** Prism language key, or undefined to render plain monospace text. */
  language?: string;
  /** Trailing overlay (e.g. a hover comment button) rendered inside the row. */
  children?: ReactNode;
}

/**
 * The shared single-row renderer: an old-line gutter, a new-line gutter, a
 * colored +/- marker, then the (optionally highlighted) code. The row never
 * wraps — the parent supplies `overflow-x-auto` — and the background is the
 * only add/remove signal on the code itself.
 */
export function DiffRowView({ row, language, children }: DiffRowViewProps) {
  return (
    <div
      className={`group relative flex w-max min-w-full items-start text-[11px] font-mono leading-[1.5] text-text-primary ${TINT[row.kind]}`}
    >
      <span className="w-10 shrink-0 select-none pr-2 text-right text-text-faint">
        {row.oldLine ?? ""}
      </span>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-text-faint">
        {row.newLine ?? ""}
      </span>
      <span
        className={`w-4 shrink-0 select-none text-center ${MARKER_CLASS[row.kind]}`}
      >
        {MARKER_GLYPH[row.kind]}
      </span>
      <span className="whitespace-pre pr-4">
        <HighlightedCode text={row.text} language={language} />
      </span>
      {children}
    </div>
  );
}
