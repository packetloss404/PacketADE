import { useCallback, useState } from "react";
import { AlertCircle } from "lucide-react";
import { writeFileContents } from "@/lib/tauri";
import { Spinner } from "@/components/ui/Spinner";
import { HunkSelectableDiff } from "@/components/agents/HunkSelectableDiff";
import { autoFormatFile } from "@/lib/autoFormat";
import { useFileDisk } from "@/components/agents/hooks/useFileDisk";
import { joinAbsolutePath, type WriteFileEntry } from "@/lib/diffUtils";

export interface DiffBodyProps {
  projectPath: string;
  entry: WriteFileEntry;
  /**
   * Run the project's auto-formatter against the file immediately after the
   * user accepts a hunk. The slide-out DiffPane opts in; the embedded
   * inspector variant leaves it off so it stays a pure preview surface.
   */
  autoFormat?: boolean;
}

/**
 * Renders the actual hunk-selectable diff for one file. Owns the
 * disk-read lifecycle (via `useFileDisk`) and, when applicable, the
 * auto-format error banner. Pure presentational otherwise — the parent
 * decides which file is active.
 */
export function DiffBody({ projectPath, entry, autoFormat }: DiffBodyProps) {
  const { state: disk, refresh } = useFileDisk(projectPath, entry.path);
  const [formatError, setFormatError] = useState<string | null>(null);

  const handleApply = useCallback(
    async (finalContent: string) => {
      const absolutePath = joinAbsolutePath(projectPath, entry.path);
      await writeFileContents(absolutePath, projectPath, finalContent);
      if (autoFormat) {
        // Best-effort auto-format. Soft-fails when the formatter binary is
        // missing or no formatter matches the file extension.
        const fmt = await autoFormatFile(absolutePath, projectPath);
        setFormatError(
          fmt.ok ? null : `${fmt.formatter}: ${fmt.error ?? "format failed"}`,
        );
      }
      await refresh();
    },
    [projectPath, entry.path, autoFormat, refresh],
  );

  if (disk.kind === "loading") {
    return (
      <div className="px-3 py-4 flex items-center gap-1.5 text-[11px] text-text-secondary">
        <Spinner size={12} className="text-text-muted" />
        Loading file from disk…
      </div>
    );
  }

  if (disk.kind === "error") {
    return (
      <div className="px-3 py-4 text-[11px] text-accent-red flex items-center gap-2">
        <AlertCircle size={12} />
        Could not read original file from disk.
      </div>
    );
  }

  const originalContent = disk.kind === "existing" ? disk.oldContent : null;

  return (
    <div className="flex flex-col">
      {formatError && (
        <div className="text-[10px] text-accent-amber bg-accent-amber/10 border border-accent-amber/30 rounded px-2 py-1 mx-2 mt-2">
          Auto-format: {formatError}
        </div>
      )}
      <HunkSelectableDiff
        originalContent={originalContent}
        newContent={entry.content}
        filePath={entry.path}
        onApplySelection={handleApply}
      />
    </div>
  );
}
