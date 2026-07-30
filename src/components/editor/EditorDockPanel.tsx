/**
 * D5 — the Editor as a first-class `RightDock` panel.
 *
 * Owns the open-buffer tab strip and the dirty-buffer guard. Switching tabs or
 * dock panels is lossless (the buffer lives in `editorStore`), so the only
 * action that can destroy unsaved work is closing a file — and that goes
 * through the codebase's inline styled confirm strip, never `window.confirm`.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, FileText, X } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { EditorPane } from "@/components/editor/EditorPane";
import { isFileDirty, useEditorStore } from "@/stores/editorStore";

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
}

export function EditorDockPanel() {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);
  const closeFile = useEditorStore((s) => s.closeFile);

  // Id of the buffer awaiting a discard confirmation.
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const confirmTarget = openFiles.find((f) => f.id === confirmCloseId) ?? null;

  // Never leave a confirm strip pointing at a buffer that is already gone.
  useEffect(() => {
    if (confirmCloseId && !confirmTarget) setConfirmCloseId(null);
  }, [confirmCloseId, confirmTarget]);

  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null;

  const requestClose = (id: string) => {
    const file = openFiles.find((f) => f.id === id);
    if (isFileDirty(file)) {
      setConfirmCloseId(id);
      return;
    }
    closeFile(id);
  };

  if (openFiles.length === 0 || !activeFile) {
    return (
      <div className="flex h-full flex-col bg-bg-primary">
        <EmptyState
          className="h-full"
          icon={<FileText size={24} />}
          title="No file open."
          description="Open a file from the Files tab, or right-click a path in chat and choose “Open in editor”."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div
        role="tablist"
        aria-label="Open files"
        className="flex shrink-0 items-center overflow-x-auto border-b border-bg-border bg-bg-secondary"
      >
        {openFiles.map((f) => {
          const active = f.id === activeFile.id;
          const dirty = isFileDirty(f);
          return (
            <div
              key={f.id}
              className={`flex shrink-0 items-center border-r border-bg-border ${
                active ? "bg-bg-primary" : ""
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveFile(f.id)}
                title={f.path}
                className={`flex items-center gap-1 whitespace-nowrap py-1 pl-2 text-[11px] transition-colors ${
                  active
                    ? "text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                <FileText size={10} />
                {basename(f.path)}
                {dirty && <span className="text-accent-green">•</span>}
              </button>
              <button
                type="button"
                onClick={() => requestClose(f.id)}
                aria-label={`Close ${basename(f.path)}`}
                title={`Close ${basename(f.path)}`}
                className="px-1.5 py-1 text-text-muted transition-colors hover:text-text-primary"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
      </div>

      {confirmTarget && (
        <div className="border-accent-amber/30 bg-accent-amber/5 flex shrink-0 items-center gap-2 border-b px-2 py-1.5 text-meta">
          <AlertTriangle size={12} className="shrink-0 text-accent-amber" />
          <span className="flex-1 text-text-secondary">
            <span className="font-mono">{basename(confirmTarget.path)}</span> has
            unsaved changes. Closing discards them.
          </span>
          <button
            type="button"
            onClick={() => setConfirmCloseId(null)}
            className="rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              closeFile(confirmTarget.id);
              setConfirmCloseId(null);
            }}
            className="bg-accent-red/20 hover:bg-accent-red/30 rounded px-1.5 py-0.5 font-medium text-accent-red transition-colors"
          >
            Discard changes
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <EditorPane key={activeFile.id} file={activeFile} />
      </div>
    </div>
  );
}
