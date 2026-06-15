import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Diamond, LayoutGrid, Plus, RefreshCw, X } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import {
  analyzeCodeQuality,
  codeQualityProbeFixers,
  codeQualityRunFix,
  writePty,
} from "@/lib/tauri";
import type { CodeQualityReport, QualityFixer } from "@/lib/tauri";
import {
  calcCommentScore,
  calcTestScore,
  calcComplexityScore,
  getLetterGrade,
  getComplexityLabel,
} from "@/components/quality/codeQualityUtils";
import { OverviewTab } from "@/components/quality/OverviewTab";
import { LanguagesTab } from "@/components/quality/LanguagesTab";
import { ComplexityTab } from "@/components/quality/ComplexityTab";
import { TestsTab } from "@/components/quality/TestsTab";
import { AutoFixPanel } from "@/components/quality/AutoFixPanel";
import { QualityAIRunSummaryPanel } from "@/components/quality/QualityAIRunSummaryPanel";
import {
  appendQualityHistory,
  clearQualityHistory,
  loadQualityHistory,
  type CodeQualityHistoryEntry,
} from "@/components/quality/codeQualityHistory";
import { CodeQualityHistoryDropdown } from "@/components/quality/CodeQualityHistoryDropdown";
import { readAutoFixPref, writeAutoFixPref } from "@/components/quality/autoFixPrefs";

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

/**
 * Code Quality full-pane view. Fronts `analyze_code_quality` and renders
 * the report across four tabs (Overview / Languages / Complexity / Tests).
 * Replaces the prior modal — surfaced from the Toolbar's Tools dropdown
 * like Ideation Scanner.
 *
 * Behaviour preserved from the modal version:
 *   - Run controls in the header: Refresh, History dropdown.
 *   - Empty / loading / error states all have a Retry path.
 *   - Stale fetches are dropped via a generation counter.
 *   - Last-5 ring buffer of historical runs per project (localStorage).
 *   - Keyboard shortcuts: Ctrl/Cmd+R refreshes, Ctrl/Cmd+F focuses filter.
 *   - Last-active tab persisted across sessions.
 *   - Click-to-copy file paths in the Complexity tab.
 *   - AutoFixPanel + QualityAIRunSummaryPanel on the Overview tab.
 */
export function QualityView() {
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window === "undefined") return "overview";
    const stored = window.localStorage.getItem(TAB_PREF_KEY) as TabKey | null;
    return stored && TABS.some((t) => t.key === stored) ? stored : "overview";
  });
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [history, setHistory] = useState<CodeQualityHistoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [reanalyzeNonce, setReanalyzeNonce] = useState(0);

  const mountedRef = useRef(true);
  const fetchGenRef = useRef(0);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const layoutProjectPath = useLayoutStore((s) => s.projectPath);
  const projectPath = workspace?.projectPath ?? layoutProjectPath;
  const isRemote = Boolean(workspace?.serverId);

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
      if (readAutoFixPref(projectPath)) {
        writeAutoFixPref(false, projectPath);
        await runConfiguredAutoFixers(projectPath);
        if (!mountedRef.current || gen !== fetchGenRef.current) return;
      }

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

  useEffect(() => {
    void runAnalyzer();
  }, [runAnalyzer, reanalyzeNonce]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        if (state.kind !== "loading") void runAnalyzer();
        return;
      }
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
    lines.push(
      "Analyze this codebase's code quality and give specific, actionable recommendations:",
    );
    lines.push("");
    lines.push(`## Code Quality Report`);
    lines.push(`- **Score**: ${totalScore}/100 (${getLetterGrade(totalScore).letter})`);
    lines.push(
      `- **Files**: ${displayedReport.total_files} across ${displayedReport.language_count} languages`,
    );
    lines.push(
      `- **Lines of Code**: ${displayedReport.total_code_lines} (${displayedReport.total_lines} total)`,
    );
    lines.push(`- **Comment Ratio**: ${(displayedReport.comment_ratio * 100).toFixed(1)}%`);
    lines.push(
      `- **Avg Complexity**: ${displayedReport.avg_complexity.toFixed(1)} (${getComplexityLabel(displayedReport.avg_complexity)})`,
    );
    lines.push(
      `- **Test Files**: ${displayedReport.test_files} (${(displayedReport.test_ratio * 100).toFixed(1)}% of files)`,
    );
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
    lines.push(
      "Please provide 5-7 specific, prioritized recommendations to improve this codebase's quality.",
    );
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
  }

  function handleCreateAndSend() {
    if (!projectPath) return;
    const projectName = projectPath.split(/[/\\]/).pop() || "Workspace";
    const wsId = useWorkspaceStore
      .getState()
      .createWorkspace(projectName, ["claude-code"], projectPath, { prompt: buildInsightPrompt() });
    useWorkspaceStore.getState().setActiveWorkspace(wsId);
    useAppStore.getState().setActiveView("workspace");
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-bg-border bg-bg-secondary px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Diamond size={14} className="text-accent-amber" />
          <h2 className="truncate text-sm font-medium text-text-primary">
            Code Quality{workspace ? ` — ${workspace.name}` : ""}
          </h2>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
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
            className="p-1 text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {historicalIndex > 0 && state.kind === "ready" && (
          <div className="px-5 pt-3">
            <div className="border-accent-amber/30 bg-accent-amber/10 flex items-center justify-between gap-2 rounded border px-3 py-1.5 text-[10px] text-accent-amber">
              <span>
                Viewing historical snapshot from{" "}
                {new Date(history[historicalIndex]?.ranAt ?? 0).toLocaleString()}. Re-run for fresh
                data.
              </span>
              <button
                type="button"
                onClick={() => setState({ ...state, historicalIndex: 0 })}
                className="hover:text-accent-amber/80 underline transition-colors"
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
              className={`rounded-t px-3 py-1.5 text-[11px] transition-colors ${
                activeTab === tab.key
                  ? "border border-b-0 border-bg-border bg-bg-primary text-accent-green"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mx-0 min-h-[320px] bg-bg-primary px-5 py-4">
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
                      {!isRemote && historicalIndex === 0 && projectPath && (
                        <div className="mt-5 border-t border-bg-border pt-4">
                          <AutoFixPanel
                            projectPath={projectPath}
                            onFixApplied={() => setReanalyzeNonce((n) => n + 1)}
                          />
                        </div>
                      )}
                      {!isRemote && historicalIndex === 0 && projectPath && (
                        <div className="mt-5 border-t border-bg-border pt-4">
                          <QualityAIRunSummaryPanel
                            projectPath={projectPath}
                            projectName={
                              workspace?.name || projectPath.split(/[/\\]/).pop() || "Project"
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
      </div>

      {/* Footer — Get AI Insight */}
      {displayedReport && !isLoading && (
        <div className="shrink-0 border-t border-bg-border bg-bg-secondary px-5 py-3">
          {!showWorkspacePicker ? (
            <button
              onClick={() => setShowWorkspacePicker(true)}
              className="bg-accent-green/10 border-accent-green/20 hover:bg-accent-green/20 flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 text-xs font-medium text-accent-green transition-colors"
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
          )}
        </div>
      )}
    </div>
  );
}

function computeTotalScore(report: CodeQualityReport): number {
  const cs = calcCommentScore(report.comment_ratio);
  const ts = calcTestScore(report.test_ratio);
  const cx = calcComplexityScore(report.avg_complexity);
  const org = report.org_score;
  return Math.round(cs * 0.2 + ts * 0.3 + cx * 0.3 + org * 0.2);
}

async function runConfiguredAutoFixers(projectPath: string): Promise<void> {
  try {
    const availability = await codeQualityProbeFixers(projectPath);
    const fixers: QualityFixer[] = [];
    if (availability.eslint) fixers.push("eslint");
    if (availability.prettier) fixers.push("prettier");

    for (const fixer of fixers) {
      await codeQualityRunFix(projectPath, fixer, qualityAutoFixRunId(fixer));
    }
  } catch (err) {
    console.warn("Auto-fix on next run failed:", err);
  }
}

function qualityAutoFixRunId(fixer: QualityFixer): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `quality-auto-${fixer}-${random}`;
}

function LoadingState({ projectPath }: { projectPath: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12">
      <div className="border-accent-amber/30 h-8 w-8 animate-spin rounded-full border-2 border-t-accent-amber" />
      <span className="text-xs text-text-muted">Analyzing codebase…</span>
      {projectPath && (
        <span className="max-w-full truncate px-4 font-mono text-[10px] text-text-muted">
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
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <AlertTriangle size={28} className="text-accent-red" />
      <div className="text-xs font-medium text-text-primary">
        {isRemote ? "Remote workspaces not supported yet" : "Analysis failed"}
      </div>
      <div className="max-w-md text-[11px] leading-relaxed text-text-muted">{message}</div>
      {!isRemote && (
        <button
          type="button"
          onClick={onRetry}
          className="hover:border-accent-amber/40 inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-secondary px-3 py-1.5 text-[11px] transition-colors hover:text-accent-amber"
        >
          <RefreshCw size={11} /> Try again
        </button>
      )}
    </div>
  );
}

function EmptyReportState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <Diamond size={28} className="text-text-muted" />
      <div className="text-xs font-medium text-text-primary">No source files detected</div>
      <div className="max-w-md text-[11px] leading-relaxed text-text-muted">
        The analyzer didn't find any files in supported languages. If you just cloned the project or
        restored a worktree, try refreshing.
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="hover:border-accent-amber/40 inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-secondary px-3 py-1.5 text-[11px] transition-colors hover:text-accent-amber"
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
  const workspacesWithSessions = activeWorkspaces.filter((w) => w.panes.some((p) => p.sessionId));

  return (
    <div className="rounded-lg border border-bg-border bg-bg-primary p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
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
            className="hover:border-accent-green/30 flex w-full items-center gap-2 rounded-lg border border-bg-border bg-bg-secondary px-3 py-2 text-left transition-colors hover:bg-bg-hover"
          >
            <LayoutGrid size={12} className="flex-shrink-0 text-text-muted" />
            <span className="truncate text-[11px] font-medium text-text-primary">{ws.name}</span>
            <span className="ml-auto flex-shrink-0 text-[10px] text-text-muted">
              {ws.panes.filter((p) => p.sessionId).length} active
            </span>
          </button>
        ))}
        <button
          onClick={onCreate}
          className="bg-accent-green/5 border-accent-green/20 hover:bg-accent-green/10 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors"
        >
          <Plus size={12} className="flex-shrink-0 text-accent-green" />
          <span className="truncate text-[11px] font-medium text-accent-green">
            Create workspace "{projectName}"
          </span>
        </button>
      </div>
    </div>
  );
}
