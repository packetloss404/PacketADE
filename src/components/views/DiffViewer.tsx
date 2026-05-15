import { useMemo, useRef } from "react";
import { FileText, FilePlus, FileMinus, FileEdit } from "lucide-react";

interface DiffViewerProps {
  diff: string;
  className?: string;
}

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  fileIndex?: number;
}

/**
 * v0.8-G: parsed-file summary for the file-tree side panel.
 * `lineIndex` is the index into the flat `lines[]` array — the tree
 * clicks into this position to scroll the diff viewport.
 */
interface DiffFile {
  /** Display path, with the `a/` or `b/` prefix stripped. */
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Position of this file's first header line in the flat `lines[]`. */
  lineIndex: number;
}

interface ParsedDiff {
  lines: DiffLine[];
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Strip the `a/` or `b/` prefix from a diff path like `a/src/foo.ts`.
 * Returns the input unchanged when no recognisable prefix is found.
 */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function parseDiff(diff: string): ParsedDiff {
  const rawLines = diff.split("\n");
  const lines: DiffLine[] = [];
  const files: DiffFile[] = [];
  let currentFileIdx = -1;
  let pendingFile: { path?: string; status?: DiffFile["status"]; lineIndex?: number } | null = null;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of rawLines) {
    let entry: DiffLine;
    if (line.startsWith("diff --git ")) {
      // `diff --git a/PATH b/PATH` — start of a new file. Defer file
      // registration until we see `+++`/`---` so we can resolve the
      // status correctly.
      pendingFile = { lineIndex: lines.length };
      entry = { type: "header", content: line };
    } else if (line.startsWith("--- ")) {
      // `--- /dev/null` = added file (no source). Otherwise it's
      // modified or deleted — we'll determine after seeing `+++`.
      if (pendingFile && line === "--- /dev/null") {
        pendingFile.status = "added";
      }
      entry = { type: "header", content: line };
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (pendingFile) {
        if (target === "/dev/null") {
          pendingFile.status = "deleted";
          // path comes from the previous `--- a/PATH`
        } else {
          pendingFile.path = pendingFile.path ?? stripPrefix(target);
          if (!pendingFile.status) pendingFile.status = "modified";
        }
        const path = pendingFile.path ?? stripPrefix(target);
        files.push({
          path,
          status: pendingFile.status ?? "modified",
          additions: 0,
          deletions: 0,
          lineIndex: pendingFile.lineIndex ?? lines.length,
        });
        currentFileIdx = files.length - 1;
        pendingFile = null;
      }
      entry = { type: "header", content: line };
    } else if (line.startsWith("@@")) {
      entry = { type: "header", content: line };
    } else if (line.startsWith("index ")) {
      entry = { type: "header", content: line };
    } else if (line.startsWith("+")) {
      entry = { type: "add", content: line };
      if (currentFileIdx >= 0) {
        files[currentFileIdx].additions++;
        totalAdditions++;
      }
    } else if (line.startsWith("-")) {
      entry = { type: "remove", content: line };
      if (currentFileIdx >= 0) {
        files[currentFileIdx].deletions++;
        totalDeletions++;
      }
    } else {
      entry = { type: "context", content: line };
    }
    entry.fileIndex = currentFileIdx >= 0 ? currentFileIdx : undefined;
    lines.push(entry);
  }

  // Fallback when the diff doesn't include `+++` headers (e.g. partial
  // input). We still register a single anonymous file so the file-tree
  // doesn't render empty.
  if (files.length === 0 && lines.some((l) => l.type === "add" || l.type === "remove")) {
    files.push({
      path: "(unknown)",
      status: "modified",
      additions: totalAdditions,
      deletions: totalDeletions,
      lineIndex: 0,
    });
  }

  return { lines, files, totalAdditions, totalDeletions };
}

const lineStyles: Record<DiffLine["type"], string> = {
  add: "bg-accent-green/10 text-accent-green",
  remove: "bg-accent-red/10 text-accent-red",
  context: "text-text-secondary",
  header: "text-accent-blue bg-accent-blue/5 font-semibold",
};

/** v0.8-G: status glyph + colour per file. */
function StatusIcon({ status }: { status: DiffFile["status"] }) {
  if (status === "added") {
    return <FilePlus size={11} className="text-accent-green" />;
  }
  if (status === "deleted") {
    return <FileMinus size={11} className="text-accent-red" />;
  }
  return <FileEdit size={11} className="text-accent-blue" />;
}

export function DiffViewer({ diff, className = "" }: DiffViewerProps) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});

  function scrollToFile(file: DiffFile) {
    const el = lineRefs.current[file.lineIndex];
    if (el && scrollRef.current) {
      // Anchor the line at the top of the visible diff area.
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {/* v0.8-G: counts header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-1.5 text-[11px] text-text-secondary">
        <FileText size={11} className="text-text-muted" />
        <span>
          <span className="font-semibold text-text-primary">
            {parsed.files.length}
          </span>{" "}
          {parsed.files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="text-text-muted">·</span>
        <span className="text-accent-green">
          +{parsed.totalAdditions} additions
        </span>
        <span className="text-text-muted">·</span>
        <span className="text-accent-red">
          -{parsed.totalDeletions} deletions
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* v0.8-G: file-tree sidebar */}
        {parsed.files.length > 0 && (
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r border-bg-border bg-bg-secondary/60">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
              Files
            </div>
            <ul className="flex flex-col">
              {parsed.files.map((f, i) => (
                <li key={`${f.path}-${i}`}>
                  <button
                    type="button"
                    onClick={() => scrollToFile(f)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-text-primary hover:bg-bg-tertiary"
                    title={f.path}
                  >
                    <StatusIcon status={f.status} />
                    <span className="truncate flex-1">{shortenPath(f.path)}</span>
                    <span className="flex items-center gap-1 text-[9px] text-text-muted">
                      <span className="text-accent-green">+{f.additions}</span>
                      <span className="text-accent-red">-{f.deletions}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Diff content */}
        <div
          ref={scrollRef}
          className="font-mono text-[11px] flex-1 overflow-auto"
        >
          {parsed.lines.map((line, i) => (
            <div
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className={`px-3 py-0.5 whitespace-pre ${lineStyles[line.type]}`}
            >
              {line.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Trim long file paths in the sidebar so they fit without wrapping.
 * Keeps the last two path segments and prefixes with `…/` when the
 * original was deeper.
 */
function shortenPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
