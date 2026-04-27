import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Diff from "diff";

interface ToolDiffViewProps {
  projectPath: string;
  filePath: string;
  newContent: string;
  /** Pre-resolved prior file content. When provided, skip the disk read.
   * Pass null/empty string for new files; pass undefined to fall back to disk. */
  oldContent?: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "new" }
  | { kind: "existing"; oldContent: string }
  | { kind: "error" };

export function ToolDiffView({
  projectPath,
  filePath,
  newContent,
  oldContent,
}: ToolDiffViewProps) {
  const [state, setState] = useState<LoadState>(() => {
    if (oldContent === null) return { kind: "new" };
    if (typeof oldContent === "string") return { kind: "existing", oldContent };
    return { kind: "loading" };
  });

  useEffect(() => {
    if (oldContent === null) {
      setState({ kind: "new" });
      return;
    }
    if (typeof oldContent === "string") {
      setState({ kind: "existing", oldContent });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<string | null>("read_file_for_diff", {
          projectPath,
          relPath: filePath,
        });
        if (cancelled) return;
        if (result === null || result === undefined) {
          setState({ kind: "new" });
        } else {
          setState({ kind: "existing", oldContent: result });
        }
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, oldContent]);

  const diffParts = useMemo(() => {
    if (state.kind !== "existing") return null;
    return Diff.diffLines(state.oldContent, newContent);
  }, [state, newContent]);

  const counts = useMemo(() => {
    if (!diffParts) return { added: 0, removed: 0 };
    let added = 0;
    let removed = 0;
    for (const part of diffParts) {
      const lineCount = part.value.split("\n").length - 1 || 0;
      const lines = part.value.endsWith("\n")
        ? lineCount
        : part.value.split("\n").length;
      if (part.added) added += lines;
      else if (part.removed) removed += lines;
    }
    return { added, removed };
  }, [diffParts]);

  if (state.kind === "loading") {
    return (
      <div className="text-[11px] text-text-secondary italic px-2 py-1">
        Loading diff...
      </div>
    );
  }

  if (state.kind === "new") {
    return (
      <div className="border border-bg-border rounded overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border">
          <span className="text-[11px] font-mono text-text-primary truncate">
            {filePath}
          </span>
          <span className="text-accent-green border border-accent-green/30 bg-accent-green/10 text-[11px] px-2 py-0.5 rounded">
            New file
          </span>
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words px-2 py-1 bg-bg-primary text-text-primary overflow-x-auto">
          {newContent}
        </pre>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="border border-bg-border rounded overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border">
          <span className="text-[11px] font-mono text-text-primary truncate">
            {filePath}
          </span>
          <span className="text-[11px] text-text-secondary italic">
            Could not read original file
          </span>
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words px-2 py-1 bg-bg-primary text-text-primary overflow-x-auto">
          {newContent}
        </pre>
      </div>
    );
  }

  // existing + diff
  return (
    <div className="border border-bg-border rounded overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border">
        <span className="text-[11px] font-mono text-text-primary truncate flex-1">
          {filePath}
        </span>
        <span className="text-[11px] font-mono text-accent-green">
          +{counts.added}
        </span>
        <span className="text-[11px] font-mono text-accent-red">
          -{counts.removed}
        </span>
      </div>
      <div className="bg-bg-primary">
        {diffParts?.map((part, idx) => {
          const lines = part.value.split("\n");
          // Remove trailing empty string caused by final newline
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          const gutter = part.added ? "+" : part.removed ? "-" : " ";
          const rowClass = part.added
            ? "bg-accent-green/10 text-accent-green"
            : part.removed
              ? "bg-accent-red/10 text-accent-red"
              : "text-text-primary";
          return (
            <pre
              key={idx}
              className={`text-[11px] font-mono whitespace-pre-wrap break-words ${rowClass}`}
            >
              {lines.map((line, li) => (
                <div key={li} className="px-2">
                  <span className="inline-block w-4 text-text-secondary select-none">
                    {gutter}
                  </span>
                  {line}
                </div>
              ))}
            </pre>
          );
        })}
      </div>
    </div>
  );
}
