import { useState, useEffect, useCallback, useRef } from "react";
import { X, Save, Circle } from "lucide-react";
import { readFileContents, writeFileContents } from "@/lib/tauri";

interface EditorPaneProps {
  filePath: string;
  workspace: string;
  onClose: () => void;
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function EditorPane({ filePath, workspace, onClose }: EditorPaneProps) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = content !== originalContent;

  const lineCount = content.split("\n").length;
  const charCount = content.length;

  // Load file on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    readFileContents(filePath, workspace)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setOriginalContent(text);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath, workspace]);

  const handleSave = useCallback(async () => {
    if (!isDirty || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await writeFileContents(filePath, workspace, content);
      setOriginalContent(content);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSaving(false);
    }
  }, [filePath, workspace, content, isDirty, isSaving]);

  // Ctrl+S handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Focus textarea on load
  useEffect(() => {
    if (!loading && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [loading]);

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-bg-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-text-primary truncate">
            {fileName(filePath)}
          </span>
          {isDirty && (
            <Circle size={8} className="text-accent-green fill-accent-green shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded
              bg-bg-tertiary border border-bg-border
              text-text-secondary hover:text-text-primary
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors"
            title="Save (Ctrl+S)"
          >
            <Save size={11} />
            {isSaving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-hidden relative">
        {loading && (
          <div className="flex items-center justify-center h-full text-text-muted text-xs">
            Loading...
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border-b border-red-500/20">
            {error}
          </div>
        )}
        {!loading && (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="w-full h-full resize-none p-3 bg-bg-primary text-text-primary
              font-mono text-xs leading-5 outline-none
              selection:bg-accent-green/20"
            style={{ tabSize: 2 }}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-1 bg-bg-secondary border-t border-bg-border shrink-0">
        <span className="text-[10px] text-text-muted truncate" title={filePath}>
          {filePath}
        </span>
        <div className="flex items-center gap-3 text-[10px] text-text-muted shrink-0">
          <span>{lineCount} lines</span>
          <span>{charCount} chars</span>
        </div>
      </div>
    </div>
  );
}
