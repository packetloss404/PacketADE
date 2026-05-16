import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Diamond,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { analyzeCodeQuality, writePty } from "@/lib/tauri";
import type { CodeQualityReport } from "@/lib/tauri";
import {
  calcCommentScore,
  calcTestScore,
  calcComplexityScore,
  getLetterGrade,
  getComplexityLabel,
} from "./codeQualityUtils";
import { OverviewTab } from "./OverviewTab";
import { LanguagesTab } from "./LanguagesTab";
import { ComplexityTab } from "./ComplexityTab";
import { TestsTab } from "./TestsTab";
// v0.8.8 quality autofix — actionable fixer buttons (eslint --fix,
// prettier --write, cargo fix, pnpm audit --fix). Self-discovers which
// fixers apply for the current project. Rendered as an additive section
// inside the Overview tab so it doesn't conflict with q2's tab layout.
import { AutoFixPanel } from "./AutoFixPanel";
// v0.8.8 quality ai — AI-powered run summary. Streams a structured
// Markdown summary of every failing check (lint / typecheck / tests /
// build) using the same Claude OAuth sidecar one-shot pattern as the
// GitHub PR review feature. Rendered as an additive section below the
// AutoFixPanel; coordinates with q1's quality runner via
// `quality:check-done` / `quality:done` events.
import { QualityAIRunSummaryPanel } from "./QualityAIRunSummaryPanel";
import {
  appendQualityHistory,
  clearQualityHistory,
  loadQualityHistory,
  type CodeQualityHistoryEntry,
} from "./codeQualityHistory";
import { CodeQualityHistoryDropdown } from "./CodeQualityHistoryDropdown";

type TabKey = "overview" | "languages" | "complexity" | "tests";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "languages", label: "Languages" },
  { key: "complexity", label: "Complexity" },
  { key: "tests", label: "Tests" },
];

const TAB_PREF_KEY = "packetade:quality:last-tab";

type FetchState =
  | { kind: "loading" }
  | { kind: "ready"; report: CodeQualityReport; historicalIndex: number }
  | { kind: "error"; message: string };

interface CodeQualityModalProps {
  onClose: () => void;
}

/**
 * Code Quality modal — fronts `analyze_code_quality` and renders the report
 * across four tabs (Overview / Languages / Complexity / Tests).
 *
 * UX improvements over the prior version:
 *   - Modal is now wider by default and supports a Maximize toggle for
 *     dense report viewing.
 *   - Run controls in the header: Refresh, Maximize, History dropdown.
 *   - Empty / loading / error states all have a Retry path; the analyzer
 *     no longer wedges a closed modal in a stale state.
 *   - Stale fetches are dropped via a generation counter so a slow analyze
 *     can't overwrite a fresher result.
 *   - Last-5 ring buffer of historical runs per project (localStorage). The
 *     history dropdown lets the user diff against prior snapshots.
 *   - Keyboard shortcuts: Esc closes, Ctrl/Cmd+R refreshes, Ctrl/Cmd+F
 *     focuses the in-modal filter.
 *   - Last-active tab persisted across sessions.
 *   - Per-tab filtering (lifted into the modal so Ctrl+F always lands here).
 *   - Click-to-copy file paths in the Complexity tab.
 *   - Preserves q3's AutoFixPanel integration on the Overview tab and the
 *     `reanalyzeNonce` bump trigger after a successful fixer run.
 *
 * Streaming hook: when the backend (agent q1) ships `quality:chunk:<runId>`
 * + `quality:done:<runId>` events, see `CodeQualityCheckPanel` and
 * `subscribeQualityStream` for the wiring scaffold. This modal still fronts
 * the synchronous `analyze_code_quality` analyzer; the streaming runner is
 * intended for a sibling diagnostics view, not this report panel.
 */
export function CodeQualityModal({ onClose }: CodeQualityModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window === "undefined") return "overview";
    const stored = window.localStorage.getItem(TAB_PREF_KEY) as TabKey | null;
    return stored && TABS.some((t) => t.key === stored) ? stored : "overview";
  });
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [history, setHistory] = useState<CodeQualityHistoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  // v0.8.8 quality autofix: bumped on each successful fixer run so the
  // analyzer re-runs and the user sees the post-fix metrics immediately.
  const [reanalyzeNonce, setReanalyzeNonce] = useState(0);

  // Tracks whether the modal is still mounted so the async analyze promise
  // doesn't setState on a torn-down component. React 18 silences the warning
  // but the underlying backend work would still complete; we want at least
  // the UI side to be predictable.
  const mountedRef = useRef(true);
  // Generation counter — each fetch increments. Stale fetches are ignored
  // when their generation no longer matches.
  const fetchGenRef = useRef(0);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  // Subscribe to layoutStore so the path tracks changes (the old code read
  // via `useLayoutStore.getState()` which doesn't re-render).
  const layoutProjectPath = useLayoutStore((s) => s.projectPath);
  const projectPath = workspace?.projectPath ?? layoutProjectPath;
  const isRemote = Boolean(workspace?.serverId);

  // Load persisted history for this project when the path changes.
  useEffect(() => {
    if (!projectPath) {
      setHistory([]);
      return;
    }
    setHistory(loadQualityHistory(projectPath));
  }, [projectPath]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Persist the last-active tab so reopening the modal lands the user back
  // where they were.
  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_PREF_KEY, activeTab);
    } catch {
      // ignore quota / sandboxing
    }
  }, [activeTab]);

  const runAnalyzer = useCallback(async () => {
    if (!projectPath) {
      setState({ kind: "error", message: "No project path detected — open a workspace first." });
      return;
    }
    if (isRemote) {
      setState({
        kind: "error",
        message:
          "Code Quality analysis is not yet supported on remote workspaces. Open the workspace locally to run it.",
      });
      return;
    }

    const gen = ++fetchGenRef.current;
    setState({ kind: "loading" });
    setShowWorkspacePicker(false);

    try {
      const report = await analyzeCodeQuality(projectPath);
      if (!mountedRef.current || gen !== fetchGenRef.current) return;

      const totalScore = computeTotalScore(report);
      const entry: CodeQualityHistoryEntry = {
        projectPath,
        ranAt: Date.now(),
        totalScore,
        totalFiles: report.total_files,
        totalCodeLines: report.total_code_lines,
        testFiles: report.test_files,
        report,
      };
      const next = appendQualityHistory(entry);
      setHistory(next);
      setState({ kind: "ready", report, historicalIndex: 0 });
    } catch (err) {
      if (!mountedRef.current || gen !== fetchGenRef.current) return;
      setState({ kind: "error", message: String(err) });
    }
  }, [projectPath, isRemote]);

  // Initial load + reanalyzeNonce trigger from AutoFixPanel.
  useEffect(() => {
    void runAnalyzer();
  }, [runAnalyzer, reanalyzeNonce]);

  // Keyboard shortcuts. Esc is owned by the Modal itself (`closeOnEscape`).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd+R → refresh report
      if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        if (state.kind !== "loading") void runAnalyzer();
        return;
      }
      // Ctrl/Cmd+F → focus the in-modal filter input (first one wins)
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        const target = document.querySelector<HTMLInputElement>(`[data-quality-filter]`);
        if (target) {
          e.preventDefault();
          target.focus();
          target.select();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runAnalyzer, state.kind]);

  // Pick the report to render: live (state.report) or a historical snapshot
  // when the user has selected one from the history dropdown.
  const displayedReport: CodeQualityReport | null = useMemo(() => {
    if (state.kind === "ready") {
      if (state.historicalIndex > 0 && history[state.historicalIndex]) {
        return history[state.historicalIndex].report;
      }
      return state.report;
    }
    return null;
  }, [state, history]);

  const historicalIndex = state.kind === "ready" ? state.historicalIndex : 0;

  const commentScore = displayedReport ? calcCommentScore(displayedReport.comment_ratio) : 0;
  const testScore = displayedReport ? calcTestScore(displayedReport.test_ratio) : 0;
  const complexityScore = displayedReport ? calcComplexityScore(displayedReport.avg_complexity) : 0;
  const orgScore = displayedReport ? displayedReport.org_score : 50;
  const totalScore = displayedReport ? computeTotalScore(displayedReport) : 0;

  const isLoading = state.kind === "loading";

  const buildInsightPrompt = useCallback((): string => {
    if (!displayedReport) return "";
    const lines: string[] = [];
    lines.push("Analyze this codebase's code quality and give specific, actionable recommendations:");
    lines.push("");
    lines.push(`## Code Quality Report`);
    lines.push(`- **Score**: ${totalScore}/100 (${getLetterGrade(totalScore).letter})`);
    lines.push(`- **Files**: ${displayedReport.total_files} across ${displayedReport.language_count} languages`);
    lines.push(`- **Lines of Code**: ${displayedReport.total_code_lines} (${displayedReport.total_lines} total)`);
    lines.push(`- **Comment Ratio**: ${(displayedReport.comment_ratio * 100).toFixed(1)}%`);
    lines.push(`- **Avg Complexity**: ${displayedReport.avg_complexity.toFixed(1)} (${getComplexityLabel(displayedReport.avg_complexity)})`);
    lines.push(`- **Test Files**: ${displayedReport.test_files} (${(displayedReport.test_ratio * 100).toFixed(1)}% of files)`);
    lines.push(`- **Organization Score**: ${orgScore}/100`);
    lines.push("");
    lines.push("### Scores");
    lines.push(`- Comment Ratio: ${commentScore}/100`);
    lines.push(`- Test Coverage: ${testScore}/100`);
    lines.push(`- Complexity: ${complexityScore}/100`);
    lines.push(`- Organization: ${orgScore}/100`);
    if (displayedReport.top_complex_files.length > 0) {
      lines.push("");
      lines.push("### Most Complex Files");
      for (const f of displayedReport.top_complex_files.slice(0, 5)) {
        lines.push(`- ${f.path} (complexity: ${f.complexity}, ${f.lines} lines)`);
      }
    }
    lines.push("");
    lines.push("### Languages");
    for (const lang of displayedReport.languages.slice(0, 5)) {
      lines.push(`- ${lang.name}: ${lang.files} files, ${lang.code_lines} code lines`);
    }
    lines.push("");
    lines.push("Please provide 5-7 specific, prioritized recommendations to improve this codebase's quality.");
    return lines.join("\n");
  }, [displayedReport, totalScore, commentScore, testScore, complexityScore, orgScore]);

  async function handleSendToWorkspace(workspaceId: string) {
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const paneWithSession = ws.panes.find((p) => p.sessionId);
    if (!paneWithSession?.sessionId) return;
    await writePty(paneWithSession.sessionId, buildInsightPrompt() + "\r");
    useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  function handleCreateAndSend() {
    if (!projectPath) return;
    const projectName = projectPath.split(/[/\\]/).pop() || "Workspace";
    const wsId = useWorkspaceStore.getState().createWorkspace(
      projectName,
      ["claude-code"],
      projectPath,
      { prompt: buildInsightPrompt() },
    );
    useWorkspaceStore.getState().setActiveWorkspace(wsId);
    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  const headerExtra = (
    <div className="flex items-center gap-1">
      {history.length > 0 && (
        <CodeQualityHistoryDropdown
          entries={history}
          selectedIndex={historicalIndex}
          onSelect={(idx) => {
            if (state.kind === "ready") {
              setState({ ...state, historicalIndex: idx });
            } else if (history[idx]) {
              setState({ kind: "ready", report: history[idx].report, historicalIndex: idx });
            }
          }}
          onClear={() => {
            if (projectPath) clearQualityHistory(projectPath);
            setHistory([]);
          }}
        />
      )}
      <button
        type="button"
        onClick={() => void runAnalyzer()}
        disabled={isLoading}
        title="Re-run analysis (Ctrl/Cmd+R)"
        aria-label="Re-run analysis"
        className="p-1 text-text-muted hover:text-text-primary transition-colors disabled:opacity-40"
      >
        <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
      </button>
      <button
        type="button"
        onClick={() => setFullscreen((v) => !v)}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        className="p-1 text-text-muted hover:text-text-primary transition-colors"
      >
        {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
    </div>
  );

  const footerContent =
    displayedReport && !isLoading ? (
      !showWorkspacePicker ? (
        <button
          onClick={() => setShowWorkspacePicker(true)}
          className="flex items-center justify-center gap-2 w-full py-2.5 bg-accent-green/10 border border-accent-green/20 rounded-lg text-accent-green text-xs font-medium hover:bg-accent-green/20 transition-colors"
        >
          <Diamond size={12} />
          Get AI Insight
        </button>
      ) : (
        <InsightWorkspacePicker
          projectPath={projectPath ?? ""}
          onSelect={(wsId) => void handleSendToWorkspace(wsId)}
          onCreate={handleCreateAndSend}
          onCancel={() => setShowWorkspacePicker(false)}
        />
      )
    ) : undefined;

  return (
    <Modal
      onClose={onClose}
      title={`Code Quality${workspace ? ` — ${workspace.name}` : ""}`}
      icon={<Diamond size={14} className="text-accent-amber" />}
      width="w-[760px]"
      fullscreen={fullscreen}
      footer={footerContent}
      headerExtra={headerExtra}
      closeOnEscape
    >
      {historicalIndex > 0 && state.kind === "ready" && (
        <div className="px-5 pt-3">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded border border-accent-amber/30 bg-accent-amber/10 text-[10px] text-accent-amber">
            <span>
              Viewing historical snapshot from{" "}
              {new Date(history[historicalIndex]?.ranAt ?? 0).toLocaleString()}. Re-run for fresh data.
            </span>
            <button
              type="button"
              onClick={() => setState({ ...state, historicalIndex: 0 })}
              className="underline hover:text-accent-amber/80 transition-colors"
            >
              Show latest
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1 px-5 pt-3">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-[11px] rounded-t transition-colors ${
              activeTab === tab.key
                ? "text-accent-green bg-bg-primary border border-bg-border border-b-0"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="px-5 py-4 bg-bg-primary mx-0 min-h-[320px]">
        {state.kind === "loading" && <LoadingState projectPath={projectPath} />}
        {state.kind === "error" && (
          <ErrorState
            message={state.message}
            onRetry={() => void runAnalyzer()}
            isRemote={isRemote}
          />
        )}
        {state.kind === "ready" && displayedReport && (
          <>
            {displayedReport.total_files === 0 ? (
              <EmptyReportState onRetry={() => void runAnalyzer()} />
            ) : (
              <>
                {activeTab === "overview" && (
                  <>
                    <OverviewTab
                      report={displayedReport}
                      totalScore={totalScore}
                      commentScore={commentScore}
                      testScore={testScore}
                      complexityScore={complexityScore}
                      orgScore={orgScore}
                    />
                    {/* v0.8.8 quality autofix — actionable fixers below the
                        score breakdown. Re-runs the analyzer after each
                        successful fix so the user sees the updated score.
                        Hidden when viewing a historical snapshot to avoid
                        confusion. */}
                    {!isRemote && historicalIndex === 0 && projectPath && (
                      <div className="mt-5 pt-4 border-t border-bg-border">
                        <AutoFixPanel
                          projectPath={projectPath}
                          onFixApplied={() => setReanalyzeNonce((n) => n + 1)}
                        />
                      </div>
                    )}
                    {/* v0.8.8 quality ai — AI run summary. Same gating as
                        AutoFixPanel: local projects only, latest snapshot
                        only, requires a project path to invoke the runner. */}
                    {!isRemote && historicalIndex === 0 && projectPath && (
                      <div className="mt-5 pt-4 border-t border-bg-border">
                        <QualityAIRunSummaryPanel
                          projectPath={projectPath}
                          projectName={
                            workspace?.name ||
                            projectPath.split(/[/\\]/).pop() ||
                            "Project"
                          }
                        />
                      </div>
                    )}
                  </>
                )}
                {activeTab === "languages" && <LanguagesTab report={displayedReport} />}
                {activeTab === "complexity" && (
                  <ComplexityTab
                    report={displayedReport}
                    filter={filter}
                    onFilterChange={setFilter}
                  />
                )}
                {activeTab === "tests" && <TestsTab report={displayedReport} />}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function computeTotalScore(report: CodeQualityReport): number {
  const cs = calcCommentScore(report.comment_ratio);
  const ts = calcTestScore(report.test_ratio);
  const cx = calcComplexityScore(report.avg_complexity);
  const org = report.org_score;
  return Math.round(cs * 0.2 + ts * 0.3 + cx * 0.3 + org * 0.2);
}

function LoadingState({ projectPath }: { projectPath: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      <div className="w-8 h-8 border-2 border-accent-amber/30 border-t-accent-amber rounded-full animate-spin" />
      <span className="text-xs text-text-muted">Analyzing codebase…</span>
      {projectPath && (
        <span className="text-[10px] text-text-muted font-mono truncate max-w-full px-4">
          {projectPath}
        </span>
      )}
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
  isRemote,
}: {
  message: string;
  onRetry: () => void;
  isRemote: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
      <AlertTriangle size={28} className="text-accent-red" />
      <div className="text-xs text-text-primary font-medium">
        {isRemote ? "Remote workspaces not supported yet" : "Analysis failed"}
      </div>
      <div className="text-[11px] text-text-muted max-w-md leading-relaxed">{message}</div>
      {!isRemote && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-bg-secondary border border-bg-border rounded hover:border-accent-amber/40 hover:text-accent-amber transition-colors"
        >
          <RefreshCw size={11} /> Try again
        </button>
      )}
    </div>
  );
}

function EmptyReportState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
      <Diamond size={28} className="text-text-muted" />
      <div className="text-xs text-text-primary font-medium">No source files detected</div>
      <div className="text-[11px] text-text-muted max-w-md leading-relaxed">
        The analyzer didn't find any files in supported languages. If you just cloned the project
        or restored a worktree, try refreshing.
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-bg-secondary border border-bg-border rounded hover:border-accent-amber/40 hover:text-accent-amber transition-colors"
      >
        <RefreshCw size={11} /> Refresh
      </button>
    </div>
  );
}

function InsightWorkspacePicker({
  projectPath,
  onSelect,
  onCreate,
  onCancel,
}: {
  projectPath: string;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectName = projectPath.split(/[/\\]/).pop() || "Workspace";

  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const activeWorkspaces = workspaces.filter(
    (w) => w.status === "active" && norm(w.projectPath) === norm(projectPath),
  );
  const workspacesWithSessions = activeWorkspaces.filter((w) =>
    w.panes.some((p) => p.sessionId),
  );

  return (
    <div className="bg-bg-primary border border-bg-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-text-muted uppercase tracking-wider font-medium">
          Send insight to workspace
        </span>
        <button onClick={onCancel} className="text-text-muted hover:text-text-primary">
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {workspacesWithSessions.map((ws) => (
          <button
            key={ws.id}
            onClick={() => onSelect(ws.id)}
            className="flex items-center gap-2 w-full px-3 py-2 text-left bg-bg-secondary border border-bg-border rounded-lg hover:border-accent-green/30 hover:bg-bg-hover transition-colors"
          >
            <LayoutGrid size={12} className="text-text-muted flex-shrink-0" />
            <span className="text-[11px] text-text-primary font-medium truncate">{ws.name}</span>
            <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
              {ws.panes.filter((p) => p.sessionId).length} active
            </span>
          </button>
        ))}
        <button
          onClick={onCreate}
          className="flex items-center gap-2 w-full px-3 py-2 text-left bg-accent-green/5 border border-accent-green/20 rounded-lg hover:bg-accent-green/10 transition-colors"
        >
          <Plus size={12} className="text-accent-green flex-shrink-0" />
          <span className="text-[11px] text-accent-green font-medium truncate">
            Create workspace "{projectName}"
          </span>
        </button>
      </div>
    </div>
  );
}
