import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ClipboardList,
  ExternalLink,
  Globe2,
  Loader2,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { readFileContents } from "@/lib/tauri";
import {
  usePreviewPaneStore,
  type PreviewPaneTab,
} from "@/stores/previewPaneStore";

interface AgentPreviewPaneProps {
  projectPath: string;
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

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const TAB_META: Record<PreviewPaneTab, { label: string; icon: typeof BookOpen }> = {
  markdown: { label: "Markdown", icon: BookOpen },
  browser: { label: "Browser", icon: Globe2 },
  plan: { label: "Plan", icon: ClipboardList },
};

export function AgentPreviewPane({ projectPath }: AgentPreviewPaneProps) {
  const {
    activeTab,
    markdownPath,
    planTitle,
    planContent,
    browserUrl,
    close,
    setActiveTab,
    setBrowserUrl,
  } = usePreviewPaneStore();

  const [markdownContent, setMarkdownContent] = useState("");
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [markdownError, setMarkdownError] = useState<string | null>(null);
  const [browserDraft, setBrowserDraft] = useState(browserUrl);

  const absoluteMarkdownPath = useMemo(
    () => (markdownPath ? resolveProjectPath(projectPath, markdownPath) : null),
    [markdownPath, projectPath],
  );

  useEffect(() => {
    setBrowserDraft(browserUrl);
  }, [browserUrl]);

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

  const loadBrowser = () => {
    setBrowserUrl(normalizeUrl(browserDraft));
  };

  const activeBrowserUrl = normalizeUrl(browserUrl);

  return (
    <aside
      className="w-[460px] max-w-[45vw] min-w-[360px] h-full shrink-0 border-l border-bg-border bg-bg-primary flex flex-col"
      aria-label="Agent preview pane"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-bg-border shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <BookOpen size={13} className="text-text-secondary shrink-0" />
          <span className="text-xs font-medium text-text-primary truncate">
            {activeTab === "markdown"
              ? fileLabel(markdownPath)
              : activeTab === "plan"
                ? planTitle
                : "Browser"}
          </span>
        </div>
        <button
          type="button"
          onClick={close}
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Collapse preview"
          aria-label="Collapse preview"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-bg-border bg-bg-primary shrink-0">
        {(Object.keys(TAB_META) as PreviewPaneTab[]).map((tab) => {
          const meta = TAB_META[tab];
          const Icon = meta.icon;
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors ${
                active
                  ? "bg-bg-hover text-text-primary"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-hover/60"
              }`}
            >
              <Icon size={12} />
              {meta.label}
            </button>
          );
        })}
      </div>

      {activeTab === "browser" && (
        <form
          className="flex items-center gap-1.5 px-2 py-2 border-b border-bg-border bg-bg-secondary/50 shrink-0"
          onSubmit={(event) => {
            event.preventDefault();
            loadBrowser();
          }}
        >
          <input
            value={browserDraft}
            onChange={(event) => setBrowserDraft(event.target.value)}
            placeholder="https://example.com"
            className="flex-1 min-w-0 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
          />
          <button
            type="submit"
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Load"
          >
            <RefreshCw size={12} />
          </button>
          {activeBrowserUrl && (
            <a
              href={activeBrowserUrl}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Open externally"
            >
              <ExternalLink size={12} />
            </a>
          )}
        </form>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "markdown" && (
          <div className="h-full overflow-y-auto px-5 py-4">
            {!markdownPath && (
              <div className="h-full flex items-center justify-center text-center">
                <div className="max-w-xs">
                  <BookOpen size={20} className="text-text-muted mx-auto mb-2" />
                  <p className="text-[11px] text-text-secondary">
                    Open a Markdown file from the file pane or click a .md path in chat.
                  </p>
                </div>
              </div>
            )}
            {markdownLoading && (
              <div className="flex items-center gap-2 text-[11px] text-text-muted">
                <Loader2 size={12} className="animate-spin" />
                Loading markdown…
              </div>
            )}
            {markdownError && (
              <div className="flex items-start gap-2 text-[11px] text-accent-red bg-accent-red/10 border border-accent-red/30 rounded p-2">
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
              <div className="h-full flex items-center justify-center text-center">
                <div className="max-w-xs">
                  <ClipboardList size={20} className="text-text-muted mx-auto mb-2" />
                  <p className="text-[11px] text-text-secondary">
                    Plan-mode responses will appear here for review.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "browser" && (
          <div className="h-full bg-bg-secondary/40">
            {activeBrowserUrl ? (
              <iframe
                key={activeBrowserUrl}
                src={activeBrowserUrl}
                title="Preview browser"
                className="w-full h-full bg-bg-primary"
                sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              />
            ) : (
              <div className="h-full flex items-center justify-center text-center px-6">
                <div className="max-w-xs">
                  <Globe2 size={20} className="text-text-muted mx-auto mb-2" />
                  <p className="text-[11px] text-text-secondary">
                    Enter a URL above to browse inside the preview pane.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
