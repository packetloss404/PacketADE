import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Brain,
  Check,
  Clock,
  Diamond,
  GitBranch,
  GitPullRequest,
  Github,
  Loader2,
  Plane,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useMissionPlannerStore } from "@/stores/missionPlannerStore";
import { gitCreateBranch } from "@/lib/tauri";
import { PRModal } from "@/components/views/PRModal";
import { DiffViewer } from "@/components/views/DiffViewer";
import { IssueBody } from "@/components/views/github/IssueBody";
import { IssueActionBar } from "@/components/views/github/IssueActionBar";
import { IssueCommentList } from "@/components/views/github/IssueCommentList";
import { IssueCommentComposer } from "@/components/views/github/IssueCommentComposer";
import { IssueList } from "@/components/views/github/IssueList";
import { PRReviewPanel } from "@/components/views/github/PRReviewPanel";
// v0.8-13: read-only pr reviews + line comments viewer
import { PullRequestReviewsPanel } from "@/components/views/github/PullRequestReviewsPanel";
import { PRActionBar } from "@/components/views/github/PRActionBar";
// v0.8-B: pr check pill + checks tab (re-shipped)
import { PRChecksTab } from "@/components/views/github/PRChecksTab";
import { RepoSelector } from "@/components/views/github/RepoSelector";
import { PRList } from "@/components/views/github/PRList";
import { ActivityFeed } from "@/components/views/github/ActivityFeed";
import { AITriageDrawer } from "@/components/views/github/AITriageDrawer";
import { InvestigationPanel } from "@/components/views/github/InvestigationPanel";
import {
  CtaFeedbackRow,
  type CtaFeedback,
} from "@/components/views/github/CtaFeedbackRow";
import type { GitHubIssue } from "@/types/github";
import { relativeTime } from "@/lib/time";

// v0.8-D — turn an issue title into a git-branch-safe slug. Lowercase,
// non-alphanumerics collapsed to `-`, trimmed to 40 chars after dropping
// leading/trailing dashes.
function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

type TabKey = "issues" | "prs" | "activity";

function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function GitHubView() {
  const {
    config,
    isConnected,
    isInitializing,
    authenticatedUser,
    repos,
    issues,
    isLoading,
    error,
    investigation,
    isInvestigating,
    prs,
    prDiff,
    isPrLoading,
    lastSyncAt,
    initializeAuth,
    connect,
    disconnect,
    fetchRepos,
    selectRepo,
    fetchIssues,
    investigateIssue,
    createPR,
    fetchPrs,
    getPrDiff,
    clearError,
    clearInvestigation,
    // v0.8-C: state filters + pagination
    issueStateFilter,
    prStateFilter,
    setIssueStateFilter,
    setPrStateFilter,
    issuesHasMore,
    prsHasMore,
    isLoadingMoreIssues,
    isLoadingMorePrs,
    loadMoreIssues,
    loadMorePrs,
    // v0.8-F: needed to apply labels emitted by AITriageDrawer
    setIssueLabels,
  } = useGitHubStore();

  const addIssue = useIssueStore((s) => s.addIssue);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const [tokenInput, setTokenInput] = useState("");
  const [tab, setTab] = useState<TabKey>("issues");
  const [selectedIssueNum, setSelectedIssueNum] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showPRModal, setShowPRModal] = useState(false);
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  // v0.8-B: which tab is active in the PR detail panel.
  const [prDetailTab, setPrDetailTab] = useState<"overview" | "checks">(
    "overview",
  );
  // v0.8-F: triage drawer open state
  const [triageOpen, setTriageOpen] = useState(false);

  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  useEffect(() => {
    if (isConnected && repos.length === 0) {
      fetchRepos();
    }
  }, [isConnected, repos.length, fetchRepos]);

  useEffect(() => {
    if (isConnected && config.selectedRepo) {
      fetchIssues();
      fetchPrs();
    }
  }, [isConnected, config.selectedRepo, fetchIssues, fetchPrs]);

  useEffect(() => {
    if (selectedIssueNum == null && issues.length > 0) {
      setSelectedIssueNum(issues[0].number);
    } else if (
      selectedIssueNum != null &&
      !issues.find((i) => i.number === selectedIssueNum)
    ) {
      setSelectedIssueNum(issues[0]?.number ?? null);
    }
  }, [issues, selectedIssueNum]);

  const selectedIssue = useMemo(
    () => issues.find((i) => i.number === selectedIssueNum) ?? null,
    [issues, selectedIssueNum]
  );

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter(
      (i) =>
        i.title.toLowerCase().includes(q) || String(i.number).includes(q)
    );
  }, [issues, searchQuery]);

  // v0.8-F: issues currently in the list with no labels — these are the
  // default selection for the triage drawer. We pull from the unfiltered
  // `issues` so the drawer's view doesn't accidentally shrink when the
  // user has a text filter applied.
  const untriagedIssues = useMemo(
    () => issues.filter((i) => i.labels.length === 0),
    [issues],
  );

  // v0.8-F: wire AITriageDrawer.onApply into the existing store action.
  // Falls back to the raw tauri command when the store doesn't expose
  // `setIssueLabels` (back-compat for installs that pre-date v0.8-C).
  async function handleTriageApply(
    labelsByIssue: Record<number, string[]>,
  ): Promise<void> {
    const entries = Object.entries(labelsByIssue);
    for (const [numStr, labels] of entries) {
      const num = Number(numStr);
      const issue = issues.find((i) => i.number === num);
      if (!issue) continue;
      if (typeof setIssueLabels === "function") {
        // v0.8-C store path: takes {name, color}[]. We don't know the
        // color, so use a neutral placeholder; the next `fetchIssues`
        // overwrites with GitHub's authoritative color.
        await setIssueLabels(
          { number: num },
          labels.map((name) => ({ name, color: "888888" })),
        );
      } else {
        // Fallback: raw tauri command.
        const { githubSetIssueLabels } = await import("@/lib/tauri");
        const repoInfo = config.selectedRepo;
        if (!repoInfo) continue;
        await githubSetIssueLabels(repoInfo.owner, repoInfo.repo, num, labels);
      }
    }
  }

  async function handleConnect() {
    if (tokenInput.trim()) {
      await connect(tokenInput.trim());
      setTokenInput("");
    }
  }

  function handleImportIssue(issue: GitHubIssue) {
    addIssue({
      title: `[GH-${issue.number}] ${issue.title}`,
      description: issue.body || "",
      status: "todo",
      priority: "medium",
      labels: issue.labels.map((l) => l.name),
      epic: null,
      acceptanceCriteria: [],
      blockedBy: [],
      blocks: [],
    });
  }

  function handleRefresh() {
    fetchRepos();
    if (config.selectedRepo) {
      fetchIssues();
      fetchPrs();
    }
  }

  if (!isConnected) {
    return (
      <div className="flex flex-col h-full bg-bg-primary p-4 overflow-y-auto">
        <div className="flex items-center gap-2 mb-6">
          <Github size={14} className="text-text-primary" />
          <h2 className="text-xs font-semibold text-text-primary">
            GitHub Integration
          </h2>
        </div>

        <div className="max-w-md mx-auto mt-16">
          <div className="bg-bg-secondary border border-bg-border rounded-lg p-6 text-center">
            <Github size={32} className="mx-auto mb-4 text-text-muted" />
            <h3 className="text-sm font-semibold text-text-primary mb-2">
              Connect to GitHub
            </h3>
            <p className="text-[11px] text-text-muted mb-4">
              Enter a personal access token with repo scope to browse
              repositories and issues.
            </p>
            {isInitializing && (
              <p className="text-[11px] text-text-muted mb-3">
                Checking auth state...
              </p>
            )}
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="flex-1 bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              />
              <button
                onClick={handleConnect}
                disabled={isLoading || isInitializing}
                className="px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors"
              >
                Connect
              </button>
            </div>
            {error && (
              <p className="text-[11px] text-accent-red mt-3">{error}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const username = authenticatedUser?.login ?? "user";

  const openCount = issues.length;

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      <HeaderBand
        username={username}
        repos={repos}
        selected={config.selectedRepo}
        onSelectRepo={selectRepo}
        onRefresh={handleRefresh}
        isLoading={isLoading || isPrLoading}
        onNewPR={() => setShowPRModal(true)}
        onDisconnect={disconnect}
      />

      <SubTabs
        tab={tab}
        onTab={setTab}
        issueCount={openCount}
        prCount={prs.length}
        lastSyncAt={lastSyncAt}
      />

      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-accent-red/10 border-b border-accent-red/20 flex-shrink-0">
          <AlertCircle size={12} className="text-accent-red" />
          <span className="text-[11px] text-accent-red flex-1">{error}</span>
          <button
            onClick={clearError}
            className="text-accent-red/60 hover:text-accent-red"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!config.selectedRepo ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-text-muted">
          Select a repository to begin.
        </div>
      ) : tab === "issues" ? (
        <div className="flex-1 grid grid-cols-[340px_1fr] min-h-0 overflow-hidden">
          <IssueList
            issues={filteredIssues}
            totalIssues={openCount}
            isLoading={isLoading}
            selectedNum={selectedIssueNum}
            onSelect={(num) => {
              setSelectedIssueNum(num);
              clearInvestigation();
            }}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            stateFilter={issueStateFilter}
            onStateFilterChange={setIssueStateFilter}
            hasMore={issuesHasMore}
            isLoadingMore={isLoadingMoreIssues}
            onLoadMore={loadMoreIssues}
            totalLoaded={issues.length}
            onOpenTriage={() => setTriageOpen(true)}
            untriagedCount={untriagedIssues.length}
          />
          <IssueDetail
            issue={selectedIssue}
            investigation={investigation}
            isInvestigating={isInvestigating}
            onImport={handleImportIssue}
            onInvestigate={(num) => investigateIssue(projectPath, num)}
            onRefetch={() => fetchIssues()}
          />
        </div>
      ) : tab === "prs" ? (
        <div className="flex-1 grid grid-cols-[1fr_auto] min-h-0 overflow-hidden">
          <PRList
            prs={prs}
            isLoading={isPrLoading}
            selectedNum={selectedPrNumber}
            onSelect={(num) => {
              setSelectedPrNumber(num);
              getPrDiff(num);
            }}
            stateFilter={prStateFilter}
            onStateFilterChange={setPrStateFilter}
            hasMore={prsHasMore}
            isLoadingMore={isLoadingMorePrs}
            onLoadMore={loadMorePrs}
          />
          {selectedPrNumber != null && (
            <div className="w-[480px] border-l border-bg-border bg-bg-primary overflow-y-auto">
              <div className="px-4 py-3 border-b border-bg-border flex items-center gap-2">
                <GitPullRequest size={12} className="text-accent-purple" />
                <span className="text-xs font-semibold text-text-primary">
                  PR #{selectedPrNumber} diff
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => setSelectedPrNumber(null)}
                  className="text-text-muted hover:text-text-primary"
                >
                  <X size={12} />
                </button>
              </div>
              {/* v0.8-A: PR action bar */}
              {(() => {
                const pr = prs.find((p) => p.number === selectedPrNumber);
                if (!pr) return null;
                return (
                  <PRActionBar
                    pr={pr}
                    onAction={() => {
                      void fetchPrs();
                    }}
                  />
                );
              })()}
              {/* v0.8-B: pr checks tab — simple horizontal switcher between
                  the existing diff/review surface and the dedicated checks
                  list. Sits below the action bar so PRActionBar stays
                  reachable on every tab. */}
              <div className="flex items-center gap-0 px-3.5 border-b border-bg-border bg-bg-secondary">
                {(
                  [
                    { key: "overview", label: "Overview" },
                    { key: "checks", label: "Checks" },
                  ] as { key: "overview" | "checks"; label: string }[]
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setPrDetailTab(t.key)}
                    className={`px-2.5 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                      prDetailTab === t.key
                        ? "border-accent-purple text-text-primary"
                        : "border-transparent text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {prDetailTab === "overview" ? (
                <>
                  <div className="p-3">
                    {isPrLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2
                          size={16}
                          className="animate-spin text-text-muted"
                        />
                      </div>
                    ) : prDiff ? (
                      <div className="border border-bg-border rounded-lg overflow-hidden">
                        <DiffViewer diff={prDiff} />
                      </div>
                    ) : (
                      <p className="text-[11px] text-text-muted">
                        No diff available.
                      </p>
                    )}
                  </div>
                  {/* v0.8-E: AI pre-flight code review. Lives below the diff so
                      it reads naturally as "here's the change, here's what the
                      AI thinks of it". */}
                  {(() => {
                    const pr = prs.find((p) => p.number === selectedPrNumber);
                    if (!pr) return null;
                    return <PRReviewPanel pr={pr} />;
                  })()}
                  {/* v0.8-13: pr reviews panel — read-only viewer for
                      existing GitHub formal reviews + per-line comment
                      threads. Sits below the AI review so the user sees
                      AI feedback then human feedback in order. */}
                  {(() => {
                    const pr = prs.find((p) => p.number === selectedPrNumber);
                    if (!pr) return null;
                    return <PullRequestReviewsPanel pr={pr} />;
                  })()}
                </>
              ) : (
                /* v0.8-B: pr checks tab */
                (() => {
                  const pr = prs.find((p) => p.number === selectedPrNumber);
                  if (!pr) return null;
                  return <PRChecksTab pr={pr} />;
                })()
              )}
            </div>
          )}
        </div>
      ) : (
        <ActivityFeed
          issues={issues}
          prs={prs}
          owner={config.selectedRepo?.owner ?? ""}
          repo={config.selectedRepo?.repo ?? ""}
        />
      )}

      {showPRModal && (
        <PRModal
          onClose={() => setShowPRModal(false)}
          onSubmit={createPR}
          isLoading={isLoading}
          /* v0.8 spec: when a user opens the PR modal while focused on an
             issue, seed the "Closes #N" picker with that issue so the
             linkage is the default rather than an extra click. */
          initialLinkedIssues={
            selectedIssueNum != null ? [selectedIssueNum] : []
          }
        />
      )}

      {/* v0.8-F: triage drawer */}
      {triageOpen && config.selectedRepo && (
        <AITriageDrawer
          owner={config.selectedRepo.owner}
          repo={config.selectedRepo.repo}
          untriagedIssues={untriagedIssues}
          onClose={() => setTriageOpen(false)}
          onApply={handleTriageApply}
        />
      )}
    </div>
  );
}

interface HeaderBandProps {
  username: string;
  repos: ReturnType<typeof useGitHubStore.getState>["repos"];
  selected: { owner: string; repo: string } | null;
  onSelectRepo: (owner: string, repo: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  onNewPR: () => void;
  onDisconnect: () => void;
}

function HeaderBand({
  username,
  repos,
  selected,
  onSelectRepo,
  onRefresh,
  isLoading,
  onNewPR,
  onDisconnect,
}: HeaderBandProps) {
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-bg-border bg-bg-secondary flex-shrink-0">
      <Github size={13} className="text-text-primary" />
      <span className="text-xs font-semibold text-text-primary">GitHub</span>

      <RepoSelector
        selected={selected}
        repos={repos}
        onSelect={onSelectRepo}
      />

      <button
        type="button"
        onClick={onRefresh}
        disabled={isLoading}
        title="Refresh"
        className="p-1 text-text-muted hover:text-text-primary transition-colors"
      >
        <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
      </button>

      <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent-green/10 text-accent-green">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
        Connected · {username}
      </span>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onNewPR}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-purple/15 text-accent-purple border border-accent-purple/30 rounded hover:bg-accent-purple/25 transition-colors"
      >
        <GitPullRequest size={10} />
        New PR
      </button>
      <button
        type="button"
        onClick={onDisconnect}
        className="text-[10px] text-text-muted hover:text-accent-red transition-colors px-1.5 py-1"
      >
        Disconnect
      </button>
    </div>
  );
}

interface SubTabsProps {
  tab: TabKey;
  onTab: (t: TabKey) => void;
  issueCount: number;
  prCount: number;
  lastSyncAt: number | null;
}

function SubTabs({ tab, onTab, issueCount, prCount, lastSyncAt }: SubTabsProps) {
  return (
    <div className="flex items-center px-2.5 bg-bg-secondary border-b border-bg-border flex-shrink-0">
      <GhTab
        active={tab === "issues"}
        onClick={() => onTab("issues")}
        icon={<AlertCircle size={10} />}
        label="Issues"
        badge={issueCount}
        accent="green"
      />
      <GhTab
        active={tab === "prs"}
        onClick={() => onTab("prs")}
        icon={<GitBranch size={10} />}
        label="Pull requests"
        badge={prCount}
        accent="purple"
      />
      <GhTab
        active={tab === "activity"}
        onClick={() => onTab("activity")}
        icon={<Clock size={10} />}
        label="Activity"
        accent="default"
      />
      <div className="flex-1" />
      <span className="text-[10px] text-text-muted px-1.5">
        {lastSyncAt ? (
          <>
            synced{" "}
            <span className="font-mono text-text-secondary">
              {relativeTime(lastSyncAt)}
            </span>
          </>
        ) : (
          <span className="font-mono text-text-secondary">not synced yet</span>
        )}
      </span>
    </div>
  );
}

interface GhTabProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  accent: "green" | "purple" | "default";
}

function GhTab({ active, onClick, icon, label, badge, accent }: GhTabProps) {
  const accentText =
    accent === "green"
      ? "text-accent-green"
      : accent === "purple"
        ? "text-accent-purple"
        : "text-accent-blue";
  const accentBorder =
    accent === "green"
      ? "border-accent-green"
      : accent === "purple"
        ? "border-accent-purple"
        : "border-accent-blue";
  const badgeBg =
    active
      ? accent === "green"
        ? "bg-accent-green/20 text-accent-green"
        : accent === "purple"
          ? "bg-accent-purple/20 text-accent-purple"
          : "bg-accent-blue/20 text-accent-blue"
      : "bg-bg-tertiary text-text-muted";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-[11px] -mb-px border-b-2 transition-colors ${
        active
          ? `${accentText} ${accentBorder} font-semibold`
          : "text-text-muted border-transparent hover:text-text-secondary font-medium"
      }`}
    >
      {icon} {label}
      {badge != null && (
        <span
          className={`text-[9px] px-1.5 rounded-full tabular-nums ${badgeBg}`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

interface IssueDetailProps {
  issue: GitHubIssue | null;
  investigation: string | null;
  isInvestigating: boolean;
  onImport: (issue: GitHubIssue) => void;
  onInvestigate: (issueNumber: number) => void;
  // v0.8-C
  onRefetch?: () => void;
}

function IssueDetail({
  issue,
  investigation,
  isInvestigating,
  onImport,
  onInvestigate,
  onRefetch,
}: IssueDetailProps) {
  // v0.8-D — store hooks for Plan flight + Branch from issue. Hooks must
  // run in stable order on every render, so they're called BEFORE the
  // `!issue` early-return below.
  const setActiveView = useAppStore((s) => s.setActiveView);
  const addFlight = useFlightStore((s) => s.addFlight);
  const updateFlight = useFlightStore((s) => s.updateFlight);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const startPlanner = useMissionPlannerStore((s) => s.startPlanner);
  const injectTurn = useMissionPlannerStore((s) => s.injectTurn);
  const projectPathFromLayout = useLayoutStore((s) => s.projectPath);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  const [actionBusy, setActionBusy] = useState<null | "plan" | "branch">(null);
  const [feedback, setFeedback] = useState<CtaFeedback>(null);

  const issueNum = issue?.number;
  useEffect(() => {
    // Clear stale feedback when the selected issue changes — a "Created
    // branch issue-42-…" line for a different issue would be misleading.
    setFeedback(null);
    setActionBusy(null);
  }, [issueNum]);

  if (!issue) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-text-muted bg-bg-primary">
        Select an issue to view details
      </div>
    );
  }

  const resolvedProjectPath =
    activeWorkspace?.projectPath || projectPathFromLayout || "";

  async function handlePlanFlight() {
    if (!issue || actionBusy) return;
    setActionBusy("plan");
    setFeedback(null);
    try {
      // Stage the mission: title from issue, spec-mode entry. Mirrors
      // MissionsView::handleStartMission's add/update/setActive/start
      // sequence so the planner runtime is alive before the view switch.
      const flight = addFlight({
        title: issue.title,
        objective: `Linked to GitHub issue #${issue.number}: ${issue.title}`,
        priority: "medium",
        projectPath: resolvedProjectPath,
        workspaceId: activeWorkspace?.id ?? null,
        issueIds: [],
      });
      updateFlight(flight.id, { status: "spec" });
      setActiveFlight(flight.id);

      // Start the planner BEFORE switching view — otherwise the
      // MissionSpecPane mounts before the runtime exists. `startPlanner`
      // installs api-agent listeners then spawns the sidecar.
      await startPlanner(flight.id, resolvedProjectPath);

      // Seed the planner with the issue context so the user lands on a
      // spec-mode chat that already knows what to build.
      const opener =
        `From GitHub issue #${issue.number}: ${issue.title}\n\n` +
        (issue.body?.trim() || "(no description)");
      await injectTurn(flight.id, opener, "user");

      setActiveView("missions");
      setFeedback({
        tone: "success",
        message: `Staged mission for #${issue.number}`,
        linkLabel: "Open",
        onLinkClick: () => setActiveView("missions"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Plan flight failed: ${msg}` });
    } finally {
      setActionBusy(null);
    }
  }

  async function handleBranchFromIssue() {
    if (!issue || actionBusy) return;
    if (!resolvedProjectPath) {
      setFeedback({
        tone: "error",
        message: "No active workspace — open one to create branches.",
      });
      return;
    }
    setActionBusy("branch");
    setFeedback(null);
    try {
      const slug = slugifyIssueTitle(issue.title) || "untitled";
      const branchName = `issue-${issue.number}-${slug}`;
      await gitCreateBranch(resolvedProjectPath, branchName, true);
      setFeedback({
        tone: "success",
        message: `Created branch \`${branchName}\``,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Branch failed: ${msg}` });
    } finally {
      setActionBusy(null);
    }
  }

  const issueIsOpen = issue.state !== "closed";
  return (
    <div className="overflow-y-auto flex flex-col min-h-0 bg-bg-primary">
      <div className="px-4 py-3.5 border-b border-bg-border">
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              {issueIsOpen ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-green/15 text-accent-green border border-accent-green/30">
                  <AlertCircle size={9} /> Open
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-purple/15 text-accent-purple border border-accent-purple/30">
                  <Check size={9} /> Closed
                </span>
              )}
              <span className="text-[10px] text-text-muted">
                <span className="text-text-secondary">{issue.user.login}</span>{" "}
                opened {timeAgo(issue.created_at)} ago
                <span className="mx-1.5 text-line-strong">·</span>
                <span className="font-mono">#{issue.number}</span>
              </span>
            </div>
            <h2 className="m-0 text-[15px] font-semibold text-text-primary leading-snug">
              {issue.title}
            </h2>
            {issue.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {issue.labels.map((l) => (
                  <span
                    key={l.name}
                    className="text-[10px] px-2 py-0.5 rounded-full border font-medium"
                    style={{
                      backgroundColor: `#${l.color}22`,
                      color: `#${l.color}`,
                      borderColor: `#${l.color}44`,
                    }}
                  >
                    {l.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <a
            href={issue.html_url}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            className="p-1 text-text-muted hover:text-text-primary"
          >
            <Send size={11} className="-rotate-45" />
          </a>
        </div>
      </div>

      {/* v0.8-C: issue actions / comments */}
      <IssueActionBar issue={issue} onChange={() => onRefetch?.()} />

      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-bg-border bg-bg-secondary flex-shrink-0 flex-wrap">
        <button
          type="button"
          onClick={() => onImport(issue)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-green/15 text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors"
        >
          <Diamond size={10} /> Import to board
        </button>
        <button
          type="button"
          onClick={() => onInvestigate(issue.number)}
          disabled={isInvestigating}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors disabled:opacity-50"
        >
          {isInvestigating ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Brain size={10} />
          )}
          Investigate with AI
        </button>
        {/* v0.8-D — Plan flight: stage a mission in spec mode and seed the
            planner with the issue body. */}
        <button
          type="button"
          onClick={() => void handlePlanFlight()}
          disabled={actionBusy === "plan"}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-soft text-accent-green border border-accent-line rounded hover:bg-accent-green/15 transition-colors disabled:opacity-50"
        >
          {actionBusy === "plan" ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Plane size={10} />
          )}{" "}
          Plan flight
        </button>
        <div className="flex-1" />
        {/* v0.8-D — Branch from issue: create `issue-{N}-{slug}` in the
            active workspace cwd and check it out. */}
        <button
          type="button"
          onClick={() => void handleBranchFromIssue()}
          disabled={actionBusy === "branch"}
          className="inline-flex items-center gap-1.5 text-[10.5px] text-text-secondary hover:text-text-primary px-2 py-1 disabled:opacity-50"
        >
          {actionBusy === "branch" ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <GitBranch size={10} />
          )}{" "}
          Branch from issue
        </button>
      </div>

      {/* v0.8-D — inline feedback under the action row. Reflects the last
          CTA invocation; cleared on issue change or by the user. */}
      {feedback && (
        <CtaFeedbackRow
          feedback={feedback}
          onDismiss={() => setFeedback(null)}
        />
      )}

      <div className="px-4 py-3.5 border-b border-bg-border">
        <IssueBody body={issue.body} />
      </div>

      {/* v0.8-C: issue actions / comments */}
      <div className="px-4 py-3 border-b border-bg-border">
        <IssueCommentList issue={issue} />
      </div>
      <div className="px-4 py-3 border-b border-bg-border">
        <IssueCommentComposer
          issue={issue}
          onPosted={() => onRefetch?.()}
        />
      </div>

      <div className="px-4 py-3.5 flex-1 min-h-0">
        <InvestigationPanel
          issue={issue}
          investigation={investigation}
          isInvestigating={isInvestigating}
          onRun={() => onInvestigate(issue.number)}
        />
      </div>
    </div>
  );
}

