/**
 * D5 — the lightweight editor body.
 *
 * The buffer lives in `editorStore` (so nothing is lost when the file tab, the
 * dock panel, or the Workspace changes); this component is the view + save
 * path. Markdown buffers render through the shared `MarkdownRenderer` with a
 * raw/preview toggle (the D5 same-day amendment, which also closes P1-5).
 */
import { useCallback, useEffect, useRef } from "react";
import { AlertCircle, BookOpen, Circle, Code2, Save } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { readFileContents, writeFileContents } from "@/lib/tauri";
import {
  isFileDirty,
  isMarkdownPath,
  useEditorStore,
  type EditorViewMode,
  type OpenFile,
} from "@/stores/editorStore";

interface EditorPaneProps {
  file: OpenFile;
}

const VIEW_OPTIONS = [
  { value: "preview" as EditorViewMode, label: "Preview", icon: BookOpen },
  { value: "raw" as EditorViewMode, label: "Raw", icon: Code2 },
];

export function EditorPane({ file }: EditorPaneProps) {
  const beginLoad = useEditorStore((s) => s.beginLoad);
  const loadSucceeded = useEditorStore((s) => s.loadSucceeded);
  const loadFailed = useEditorStore((s) => s.loadFailed);
  const setContent = useEditorStore((s) => s.setContent);
  const markSaved = useEditorStore((s) => s.markSaved);
  const setView = useEditorStore((s) => s.setView);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const savingRef = useRef(false);

  const dirty = isFileDirty(file);
  const markdown = isMarkdownPath(file.path);
  const rendered = markdown && file.view === "preview";
  const content = file.content ?? "";

  // Read once per buffer. Re-opening the same path re-activates the existing
  // buffer, so an unsaved edit is never clobbered by a re-read. The guard is a
  // ref (not the store's `loading` flag) because flipping that flag would
  // otherwise re-run and cancel this very effect. The panel keys `EditorPane`
  // on the buffer id, so the ref resets per file.
  const loadStartedRef = useRef(false);
  useEffect(() => {
    if (loadStartedRef.current) return;
    if (file.content !== null || file.error) return;
    loadStartedRef.current = true;
    beginLoad(file.id);
    readFileContents(file.path, file.workspace)
      .then((text) => loadSucceeded(file.id, text))
      .catch((err) => loadFailed(file.id, err instanceof Error ? err.message : String(err)));
  }, [
    file.id,
    file.path,
    file.workspace,
    file.content,
    file.error,
    beginLoad,
    loadSucceeded,
    loadFailed,
  ]);

  const handleSave = useCallback(async () => {
    if (!dirty || savingRef.current) return;
    savingRef.current = true;
    try {
      await writeFileContents(file.path, file.workspace, content);
      markSaved(file.id, content);
    } catch (err) {
      loadFailed(file.id, err instanceof Error ? err.message : String(err));
    } finally {
      savingRef.current = false;
    }
  }, [dirty, file.id, file.path, file.workspace, content, markSaved, loadFailed]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  useEffect(() => {
    if (!file.loading && !rendered) textareaRef.current?.focus();
  }, [file.loading, rendered]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary"
          title={file.path}
        >
          {file.path}
        </span>
        {dirty && (
          <Circle
            size={8}
            aria-label="Unsaved changes"
            className="shrink-0 fill-accent-green text-accent-green"
          />
        )}
        {markdown && (
          <SegmentedControl
            size="xs"
            aria-label="Markdown view mode"
            options={VIEW_OPTIONS}
            value={file.view}
            onChange={(v) => setView(file.id, v)}
          />
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty}
          className="flex shrink-0 items-center gap-1 rounded border border-bg-border bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          title="Save (Ctrl+S)"
        >
          <Save size={11} />
          Save
        </button>
      </div>

      {file.error && (
        <div className="border-accent-red/30 bg-accent-red/10 flex shrink-0 items-start gap-2 border-b px-3 py-2 text-[11px] text-accent-red">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{file.error}</span>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {file.loading && (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-text-muted">
            <Spinner size={12} />
            Loading…
          </div>
        )}
        {!file.loading && rendered && (
          <div className="h-full overflow-y-auto px-4 py-3">
            <MarkdownRenderer content={content} className="text-sm leading-relaxed" />
          </div>
        )}
        {!file.loading && !rendered && (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(file.id, e.target.value)}
            spellCheck={false}
            aria-label={`Editing ${file.path}`}
            className="h-full w-full resize-none bg-bg-primary p-3 font-mono text-xs leading-5 text-text-primary outline-none selection:bg-accent-green/20"
            style={{ tabSize: 2 }}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-bg-border bg-bg-secondary px-3 py-1">
        <span className="truncate text-[10px] text-text-muted">
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <div className="flex shrink-0 items-center gap-3 text-[10px] text-text-muted">
          <span>{content.split("\n").length} lines</span>
          <span>{content.length} chars</span>
        </div>
      </div>
    </div>
  );
}
