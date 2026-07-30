import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ClipboardList,
  PanelRightClose,
  Server,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { readFileContents } from "@/lib/tauri";
import { REMOTE_UNSUPPORTED_TOOLTIP } from "@/lib/remoteConversation";
import { resolveProjectPath } from "@/lib/resolveProjectPath";
import { hidePreview, setPreviewTab } from "@/lib/previewDock";
import {
  previewTargetFor,
  usePreviewPaneStore,
  type PreviewPaneTab,
} from "@/stores/previewPaneStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";

interface AgentPreviewPaneProps {
  /** P0-3: the pane renders ONLY previews opened by this conversation, so a
   * relative path opened for conversation A is never resolved against
   * conversation B's project after the selection changes. */
  conversationId: string;
  projectPath: string;
  /** D3 / P0-4: the owning conversation runs on an SSH host, so `projectPath`
   * is a REMOTE path. Markdown preview reads LOCAL disk, so it is refused
   * (with an explicit notice) instead of reading an unrelated local path. */
  remote?: boolean;
  /** When true, the pane is rendered inside the dock and drops the standalone
   *  aside chrome (fixed width, close button). */
  embedded?: boolean;
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
  conversationId,
  projectPath,
  remote = false,
  embedded = false,
}: AgentPreviewPaneProps) {
  const target = usePreviewPaneStore((s) => previewTargetFor(s.target, conversationId));
  const activeTab: PreviewPaneTab = target?.activeTab ?? "markdown";
  const markdownPath = target?.markdownPath ?? null;
  const planTitle = target?.planTitle ?? "Agent plan";
  const planContent = target?.planContent ?? "";

  // P0-3: Hide (header overflow menu) and Close (this button) are the SAME
  // verb now — both call `hidePreview`, which returns the dock to Inspector.
  const handleClose = hidePreview;
  const setActiveTab = (tab: PreviewPaneTab) => setPreviewTab(conversationId, tab);

  const [markdownContent, setMarkdownContent] = useState("");
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [markdownError, setMarkdownError] = useState<string | null>(null);

  const absoluteMarkdownPath = useMemo(
    () =>
      markdownPath && !remote
        ? resolveProjectPath(projectPath, markdownPath)
        : null,
    [markdownPath, projectPath, remote],
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
        <div className="flex-1" />
        {/* P0-3: identical behaviour to the header menu's "Hide preview" —
            both call `hidePreview`. One verb, one behaviour. */}
        <Tooltip content="Hide preview">
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            aria-label="Hide preview"
          >
            <PanelRightClose size={12} />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "markdown" && remote && (
          <div className="h-full overflow-y-auto px-5 py-4">
            <EmptyState
              className="h-full"
              icon={<Server size={24} />}
              title={`Markdown preview — ${REMOTE_UNSUPPORTED_TOOLTIP}.`}
              description="This conversation's files live on a remote SSH host; the preview only reads the local filesystem."
            />
          </div>
        )}

        {activeTab === "markdown" && !remote && (
          <div className="h-full overflow-y-auto px-5 py-4">
            {!markdownPath && (
              <EmptyState
                className="h-full"
                icon={<BookOpen size={24} />}
                title="Click a .md path in chat to preview it here."
                description="Files opened from the Files tab go to the Editor panel, which renders Markdown too."
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
