import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BookOpen, ClipboardList, PanelRightClose } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { readFileContents } from "@/lib/tauri";
import {
  usePreviewPaneStore,
  type PreviewPaneTab,
} from "@/stores/previewPaneStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";

interface AgentPreviewPaneProps {
  projectPath: string;
  /** When true, the pane is rendered inside the InspectorPane's tab and drops
   *  the standalone aside chrome (fixed width, close button). */
  embedded?: boolean;
  /** Called when the header close button is clicked. Used in embedded mode to
   *  switch the parent tab back to Inspector instead of closing the global
   *  preview-pane store. Ignored when `embedded` is false. */
  onRequestClose?: () => void;
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function resolveProjectPath(projectPath: string, path: string): string {
  if (isAbsolutePath(path)) return path;
  const sep = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  const root = projectPath.replace(/[\\/]+$/, "");
  const rel = path.replace(/^[\\/]+/, "");
  return `${root}${sep}${sep === "\\" ? rel.replace(/\//g, "\\") : rel.replace(/\\/g, "/")}`;
}

function fileLabel(path: string | null): string {
  if (!path) return "Markdown";
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const TAB_META: Record<PreviewPaneTab, { label: string; icon: typeof BookOpen }> = {
  markdown: { label: "Markdown", icon: BookOpen },
  plan: { label: "Plan", icon: ClipboardList },
};

export function AgentPreviewPane({
  projectPath,
  embedded = false,
  onRequestClose,
}: AgentPreviewPaneProps) {
  const { activeTab, markdownPath, planTitle, planContent, close, setActiveTab } =
    usePreviewPaneStore();

  const handleClose = () => {
    if (embedded) {
      onRequestClose?.();
    } else {
      close();
    }
  };

  const [markdownContent, setMarkdownContent] = useState("");
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [markdownError, setMarkdownError] = useState<string | null>(null);

  const absoluteMarkdownPath = useMemo(
    () => (markdownPath ? resolveProjectPath(projectPath, markdownPath) : null),
    [markdownPath, projectPath],
  );

  useEffect(() => {
    if (!absoluteMarkdownPath) {
      setMarkdownContent("");
      setMarkdownError(null);
      setMarkdownLoading(false);
      return;
    }

    let cancelled = false;
    setMarkdownLoading(true);
    setMarkdownError(null);
    readFileContents(absoluteMarkdownPath, projectPath)
      .then((content) => {
        if (!cancelled) setMarkdownContent(content);
      })
      .catch((err) => {
        if (!cancelled) {
          setMarkdownContent("");
          setMarkdownError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setMarkdownLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [absoluteMarkdownPath, projectPath]);

  // In embedded mode we drop the standalone aside chrome (fixed width,
  // bordered left edge) because the InspectorPane already supplies them.
  const containerClass = embedded
    ? "flex-1 min-h-0 flex flex-col bg-bg-primary"
    : "w-[460px] max-w-[45vw] min-w-[360px] h-full shrink-0 border-l border-bg-border bg-bg-primary flex flex-col";

  return (
    <aside
      className={containerClass}
      aria-label="Agent preview pane"
    >
      {!embedded && (
        <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-bg-border shrink-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <BookOpen size={14} className="text-text-secondary shrink-0" />
            <span className="text-ui font-medium text-text-primary truncate">
              {activeTab === "markdown" ? fileLabel(markdownPath) : planTitle}
            </span>
          </div>
          <Tooltip content="Collapse preview">
            <button
              type="button"
              onClick={handleClose}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              aria-label="Collapse preview"
            >
              <PanelRightClose size={14} />
            </button>
          </Tooltip>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Preview views"
        className="flex items-center gap-1 px-2 py-1.5 border-b border-bg-border bg-bg-primary shrink-0"
      >
        {(Object.keys(TAB_META) as PreviewPaneTab[]).map((tab) => {
          const meta = TAB_META[tab];
          const Icon = meta.icon;
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              role="tab"
              aria-selected={active}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-ui transition-colors ${
                active
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
              }`}
            >
              <Icon size={12} />
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "markdown" && (
          <div className="h-full overflow-y-auto px-5 py-4">
            {!markdownPath && (
              <EmptyState
                className="h-full"
                icon={<BookOpen size={24} />}
                title="Open a Markdown file from the file pane or click a .md path in chat."
              />
            )}
            {markdownLoading && (
              <div className="flex items-center gap-2 text-ui text-text-muted">
                <Spinner size={12} />
                Loading markdown…
              </div>
            )}
            {markdownError && (
              <div className="flex items-start gap-2 text-ui text-accent-red bg-accent-red/10 border border-accent-red/30 rounded p-2">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span className="break-words">{markdownError}</span>
              </div>
            )}
            {!markdownLoading && !markdownError && markdownPath && (
              <MarkdownRenderer
                content={markdownContent}
                className="text-sm leading-relaxed"
              />
            )}
          </div>
        )}

        {activeTab === "plan" && (
          <div className="h-full overflow-y-auto px-5 py-4">
            {planContent ? (
              <MarkdownRenderer
                content={planContent}
                className="text-sm leading-relaxed"
              />
            ) : (
              <EmptyState
                className="h-full"
                icon={<ClipboardList size={24} />}
                title="Plan-mode responses will appear here for review."
              />
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
