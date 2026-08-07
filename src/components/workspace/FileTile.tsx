/**
 * File viewer tile — a `kind: "file"` pane rendered inside the workspace
 * mosaic, so a README or a config can sit beside a Claude Code terminal
 * instead of only in the right-dock Editor.
 *
 * It is deliberately a THIN wrapper: the buffer lives in `editorStore`, which
 * means the same path opened in the dock and in a tile is one buffer with one
 * dirty flag and one save path. `EditorPane` is reused unforked, so the
 * markdown preview/raw toggle, Ctrl+S, and the load/error states are the ones
 * already shipped and tested.
 *
 * The pane persists only `filePath` (+ optional `fileView`); the buffer id is
 * resolved at mount, because `editorStore` is runtime-only.
 */
import { useEffect, useState } from "react";
import { FileWarning } from "lucide-react";
import { EditorPane } from "@/components/editor/EditorPane";
import { EmptyState } from "@/components/ui/EmptyState";
import { useEditorStore } from "@/stores/editorStore";
import type { WorkspacePane } from "@/types/workspace";

interface FileTileProps {
  pane: WorkspacePane;
  /** Project root the Tauri FS commands scope this read/write to. */
  projectPath: string;
  /** SSH workspaces have no local FS to read — state that instead of failing. */
  remote?: boolean;
}

export function FileTile({ pane, projectPath, remote = false }: FileTileProps) {
  const openFile = useEditorStore((s) => s.openFile);
  const setView = useEditorStore((s) => s.setView);
  const [bufferId, setBufferId] = useState<string | null>(null);
  const openFiles = useEditorStore((s) => s.openFiles);
  const filePath = pane.filePath ?? "";

  // Resolve (or create) the shared buffer once per path. `openFile` re-activates
  // an existing buffer for the same path, so tiling a file that is already open
  // in the dock adopts that buffer — including its unsaved edits.
  useEffect(() => {
    if (remote || !filePath) return;
    const id = openFile(filePath, projectPath);
    setBufferId(id);
    // A pane that asked for an explicit initial view (the "Markdown Viewer"
    // picker row) applies it once at adoption. Later manual toggles win — this
    // effect is keyed on the path, not on the buffer's current view.
    if (pane.fileView) setView(id, pane.fileView);
  }, [filePath, projectPath, remote, pane.fileView, openFile, setView]);

  if (remote) {
    return (
      <div className="flex h-full flex-col bg-bg-primary">
        <EmptyState
          className="h-full"
          icon={<FileWarning size={22} />}
          title="File viewer is local-only"
          description="This workspace runs over SSH. Browse remote files from the agent's tools instead."
        />
      </div>
    );
  }

  const file = bufferId ? (openFiles.find((f) => f.id === bufferId) ?? null) : null;

  if (!filePath || !file) {
    return (
      <div className="flex h-full flex-col bg-bg-primary">
        <EmptyState
          className="h-full"
          icon={<FileWarning size={22} />}
          title="No file"
          description="This viewer tile lost its file. Close it and open the file again."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorPane key={file.id} file={file} />
    </div>
  );
}
