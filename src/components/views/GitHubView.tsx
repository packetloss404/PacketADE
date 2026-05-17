import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronRight,
  Clock,
  Diamond,
  GitBranch,
  GitPullRequest,
  Github,
  Loader2,
  Plane,
  RefreshCw,
  Search,
  Send,
  StickyNote,
  X,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useMissionPlannerStore } from "@/stores/missionPlannerStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { gitCreateBranch } from "@/lib/tauri";
import type { AttemptTargetSpec } from "@/lib/tauri";
import { PRModal } from "@/components/views/PRModal";
import { DiffViewer } from "@/components/views/DiffViewer";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { IssueBody } from "@/components/views/github/IssueBody";
import { IssueActionBar } from "@/components/views/github/IssueActionBar";
import { IssueCommentList } from "@/components/views/github/IssueCommentList";
import { IssueCommentComposer } from "@/components/views/github/IssueCommentComposer";
import { PRReviewPanel } from "@/components/views/github/PRReviewPanel";
// v0.8-13: read-only pr reviews + line comments viewer
import { PullRequestReviewsPanel } from "@/components/views/github/PullRequestReviewsPanel";
import { PRActionBar } from "@/components/views/github/PRActionBar";
// v0.8-B: pr check pill + checks tab (re-shipped)
import { PrCheckPill } from "@/components/views/github/PrCheckPill";
import { PRChecksTab } from "@/components/views/github/PRChecksTab";
import { RepoSelector } from "@/components/views/github/RepoSelector";
import { AICatchUpButton } from "@/components/views/github/AICatchUpButton";
import { AITriageDrawer } from "@/components/views/github/AITriageDrawer";
import { Sparkles } from "lucide-react";
import type { GitHubIssue, GitHubPr } from "@/types/github";
import { relativeTime } from "@/lib/time";

// v0.8-D — inline feedback descriptor surfaced by the issue / investigation
// action rows when a CTA finishes. `tone` drives color; optional `linkLabel`
// + `onLinkClick` render a small affordance (e.g. "View") that takes the
// user to wherever the action's downstream artefact lives.
type CtaFeedback = {
  tone: "success" | "error" | "info";
  message: string;
  linkLabel?: string;
  onLinkClick?: () => void;
} | null;

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

interface IssueListProps {
  issues: GitHubIssue[];
  totalIssues: number;
  isLoading: boolean;
  selectedNum: number | null;
  onSelect: (num: number) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  // v0.8-C
  stateFilter: "open" | "closed" | "all";
  onStateFilterChange: (state: "open" | "closed" | "all") => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  totalLoaded: number;
  // v0.8-F: triage drawer launch
  onOpenTriage: () => void;
  untriagedCount: number;
}

function IssueList({
  issues,
  totalIssues,
  isLoading,
  selectedNum,
  onSelect,
  searchQuery,
  onSearchChange,
  stateFilter,
  onStateFilterChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
  totalLoaded,
  onOpenTriage,
  untriagedCount,
}: IssueListProps) {
  return (
    <div className="border-r border-bg-border flex flex-col min-w-0 bg-bg-secondary overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-bg-border flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[10.5px] text-text-muted">
          <Search size={10} />
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="filter issues..."
            className="flex-1 bg-transparent text-[10.5px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
        {/* v0.8-F: triage drawer */}
        <button
          type="button"
          onClick={onOpenTriage}
          disabled={untriagedCount === 0}
          title={
            untriagedCount === 0
              ? "No untriaged issues to triage"
              : `Run AI triage on ${untriagedCount} untriaged issue(s)`
          }
          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sparkles size={10} />
          Triage
          {untriagedCount > 0 && (
            <span className="text-[9px] px-1 rounded-full bg-accent-blue/20">
              {untriagedCount}
            </span>
          )}
        </button>
      </div>

      {/* v0.8-C: state filter */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-bg-border flex-shrink-0">
        <StateFilterChip
          label="Open"
          active={stateFilter === "open"}
          onClick={() => onStateFilterChange("open")}
        />
        <StateFilterChip
          label="Closed"
          active={stateFilter === "closed"}
          onClick={() => onStateFilterChange("closed")}
        />
        <StateFilterChip
          label="All"
          active={stateFilter === "all"}
          onClick={() => onStateFilterChange("all")}
        />
        <div className="flex-1" />
        <span className="text-[9.5px] text-text-muted font-mono">
          {totalIssues} {stateFilter}
        </span>
      </div>

      <div className="flex items-center gap-1 px-2.5 py-1 border-b border-bg-border flex-shrink-0 text-[10px] text-text-muted">
        <span>filtered: {issues.length}</span>
        <div className="flex-1" />
        <span className="font-mono text-text-muted">by: newest</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && issues.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : issues.length === 0 ? (
          <div className="text-center py-12 text-[11px] text-text-muted">
            No {stateFilter === "all" ? "" : stateFilter} issues found
          </div>
        ) : (
          <>
            {issues.map((iss) => {
              const active = selectedNum === iss.number;
              const isClosed = iss.state === "closed";
              return (
                <button
                  type="button"
                  key={iss.number}
                  onClick={() => onSelect(iss.number)}
                  className={`w-full text-left px-3 py-2.5 border-b border-bg-border flex gap-2 items-start transition-colors ${
                    active
                      ? "bg-bg-tertiary border-l-2 border-l-accent-green"
                      : "border-l-2 border-l-transparent hover:bg-bg-tertiary/50"
                  }`}
                >
                  <AlertCircle
                    size={11}
                    className={`${
                      isClosed ? "text-accent-purple" : "text-accent-green"
                    } mt-0.5 flex-shrink-0`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[10px] text-text-muted tabular-nums">
                        #{iss.number}
                      </span>
                      <span
                        className="text-[11px] text-text-primary leading-snug flex-1 overflow-hidden"
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                        }}
                      >
                        {iss.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      {iss.labels.slice(0, 3).map((l) => (
                        <span
                          key={l.name}
                          className="text-[9px] px-1.5 py-0.5 rounded-full border"
                          style={{
                            backgroundColor: `#${l.color}22`,
                            color: `#${l.color}`,
                            borderColor: `#${l.color}44`,
                          }}
                        >
                          {l.name}
                        </span>
                      ))}
                      <div className="flex-1" />
                      <span className="text-[9.5px] text-text-muted">
                        {iss.user.login}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {/* v0.8-C: pagination */}
            {hasMore && (
              <div className="flex items-center justify-center gap-2 px-3 py-3 border-t border-bg-border">
                <span className="text-[10px] text-text-muted">
                  Showing {totalLoaded}
                </span>
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-bg-tertiary text-text-primary border border-bg-border rounded hover:border-line-strong disabled:opacity-60"
                >
                  {isLoadingMore && (
                    <Loader2 size={10} className="animate-spin" />
                  )}
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// v0.8-C: state filter chip used by IssueList and PRList.
function StateFilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
        active
          ? "bg-accent-green/15 text-accent-green border-accent-green/30"
          : "bg-bg-tertiary text-text-muted border-bg-border hover:text-text-primary"
      }`}
    >
      {label}
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

// v0.8-D — slim inline status strip rendered under issue/investigation
// action bars when a CTA completes. Color follows `tone`; the optional
// `linkLabel`/`onLinkClick` render a small View affordance.
function CtaFeedbackRow({
  feedback,
  onDismiss,
}: {
  feedback: NonNullable<CtaFeedback>;
  onDismiss: () => void;
}) {
  const toneCls =
    feedback.tone === "success"
      ? "bg-accent-green/10 border-accent-green/20 text-accent-green"
      : feedback.tone === "error"
        ? "bg-accent-red/10 border-accent-red/20 text-accent-red"
        : "bg-accent-blue/10 border-accent-blue/20 text-accent-blue";
  return (
    <div
      className={`flex items-center gap-2 px-4 py-1.5 border-b text-[10.5px] ${toneCls}`}
    >
      <span className="flex-1 truncate font-mono">{feedback.message}</span>
      {feedback.linkLabel && feedback.onLinkClick && (
        <button
          type="button"
          onClick={feedback.onLinkClick}
          className="underline hover:opacity-80 px-1 font-medium"
        >
          {feedback.linkLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="opacity-60 hover:opacity-100"
        title="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  );
}

interface InvestigationPanelProps {
  issue: GitHubIssue;
  investigation: string | null;
  isInvestigating: boolean;
  onRun: () => void;
}

function InvestigationPanel({
  issue,
  investigation,
  isInvestigating,
  onRun,
}: InvestigationPanelProps) {
  // v0.8-D — wire Hand off to Claude / Draft patch / Save as memory.
  const setActiveView = useAppStore((s) => s.setActiveView);
  const layoutProjectPath = useLayoutStore((s) => s.projectPath);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addFlight = useFlightStore((s) => s.addFlight);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const launchAsync = useAsyncFlightStore((s) => s.launchAsync);
  const captureManually = useMemoryStore((s) => s.captureManually);

  const [busy, setBusy] = useState<null | "handoff" | "draft" | "memory">(null);
  const [feedback, setFeedback] = useState<CtaFeedback>(null);

  // Clear stale feedback when the underlying investigation or issue
  // changes; what was "Saved to project memory" for issue #41 is no
  // longer relevant when the user clicks over to #42.
  const issueNumber = issue.number;
  useEffect(() => {
    setFeedback(null);
    setBusy(null);
  }, [issueNumber, investigation]);

  const resolvedProjectPath =
    activeWorkspace?.projectPath || layoutProjectPath || "";

  const downstreamReady = Boolean(investigation && !isInvestigating);

  async function handleHandoffToClaude() {
    if (!investigation || busy) return;
    if (!resolvedProjectPath) {
      setFeedback({
        tone: "error",
        message: "No project path — open a workspace before handing off.",
      });
      return;
    }
    setBusy("handoff");
    setFeedback(null);
    try {
      // Create a fresh workspace seeded with claude-code and the
      // investigation as the workspace-level prompt. The pane spawns
      // when WorkspaceView renders and `useTerminalSession` writes the
      // prompt as the first input.
      const initialPrompt =
        `--- GitHub Investigation for #${issue.number} (${issue.title}) ---\n\n` +
        `${investigation}\n\n` +
        `--- end of context ---\n\n` +
        `Please continue from here.`;
      const name = `GH #${issue.number} — ${issue.title}`.slice(0, 64);
      const wsId = createWorkspace(
        name,
        ["claude-code"],
        resolvedProjectPath,
        { prompt: initialPrompt },
      );
      setActiveWorkspace(wsId);
      setActiveView("workspace");
      setFeedback({
        tone: "success",
        message: `Opened Claude with #${issue.number} context`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Hand off failed: ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  async function handleDraftPatch() {
    if (!investigation || busy) return;
    if (!resolvedProjectPath) {
      setFeedback({
        tone: "error",
        message: "No active workspace — open one to draft a patch.",
      });
      return;
    }
    setBusy("draft");
    setFeedback(null);
    try {
      // Seed a single-attempt async Flight using the investigation as the
      // brief. Executor model = claude-sonnet-4-6 over the OAuth sidecar
      // (api-claude-oauth) per the v0.8-D spec.
      const brief =
        `GitHub issue #${issue.number}: ${issue.title}\n\n` +
        `Issue description:\n${issue.body?.trim() || "(no description)"}\n\n` +
        `AI Investigation:\n${investigation}\n\n` +
        `Apply the change. Keep the diff focused on what the investigation calls out.`;
      const flight = addFlight({
        title: `Fix #${issue.number}: ${issue.title}`,
        objective: brief.slice(0, 200),
        priority: "medium",
        projectPath: resolvedProjectPath,
        workspaceId: activeWorkspace?.id ?? null,
        issueIds: [],
      });
      const target: AttemptTargetSpec = {
        kind: "local",
        basePath: resolvedProjectPath,
        baseBranch: "main",
        agentConfigId: "api-claude-oauth",
        provider: "claude-oauth",
        model: "claude-sonnet-4-6",
      };
      await launchAsync(flight.id, brief, [target]);
      setActiveFlight(flight.id);
      setActiveView("missions");
      setFeedback({
        tone: "success",
        message: `Launched draft patch for #${issue.number}`,
        linkLabel: "Open",
        onLinkClick: () => setActiveView("missions"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Draft patch failed: ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  function handleSaveAsMemory() {
    if (!investigation || busy) return;
    setBusy("memory");
    setFeedback(null);
    try {
      captureManually({
        projectPath: resolvedProjectPath,
        source: "github-investigation",
        summary: `Investigation for #${issue.number}: ${issue.title}`,
        body: investigation,
        tags: ["github-investigation", `gh-${issue.number}`],
      });
      setFeedback({
        tone: "success",
        message: "Saved to project memory",
        linkLabel: "View",
        onLinkClick: () => setActiveView("memory"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", message: `Save failed: ${msg}` });
    } finally {
      setBusy(null);
    }
  }

  if (!investigation && !isInvestigating) {
    return (
      <div className="bg-bg-secondary border border-accent-blue/30 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-accent-blue/10 border-b border-accent-blue/20">
          <Brain size={12} className="text-accent-blue" />
          <span className="text-[11px] font-semibold text-accent-blue">
            AI Investigation
          </span>
          <span className="text-[9.5px] text-text-muted">scout · read-only</span>
        </div>
        <div className="px-3.5 py-3 flex items-center gap-3">
          <span className="text-[11px] text-text-muted flex-1">
            Run an AI investigation to scan the codebase, surface a likely fix,
            and list files touched.
          </span>
          <button
            type="button"
            onClick={onRun}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors"
          >
            <Brain size={10} /> Run investigation
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bg-secondary border border-accent-blue/30 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-accent-blue/10 border-b border-accent-blue/20">
        <Brain size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-accent-blue">
          AI Investigation
        </span>
        <span className="text-[9.5px] text-text-muted">
          scout · read-only
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRun}
          disabled={isInvestigating}
          className="text-[9.5px] text-accent-blue hover:underline px-1.5 py-0.5 disabled:opacity-50"
        >
          {isInvestigating ? "Running..." : "Re-run"}
        </button>
      </div>

      <div className="px-3.5 py-3 text-[11px] text-text-secondary leading-relaxed">
        {isInvestigating && !investigation ? (
          <div className="flex items-center gap-2 text-text-muted py-2">
            <Loader2 size={12} className="animate-spin" />
            Analyzing codebase...
          </div>
        ) : investigation ? (
          <MarkdownRenderer
            content={investigation}
            className="text-[11px] text-text-secondary leading-relaxed"
          />
        ) : null}

        <div className="flex gap-1.5 mt-3 pt-2.5 border-t border-dashed border-bg-border flex-wrap items-center">
          {/* v0.8-D — Hand off to Claude: spawn `claude` PTY with the
              investigation piped in as the first user turn. */}
          <button
            type="button"
            onClick={() => void handleHandoffToClaude()}
            disabled={!downstreamReady || busy === "handoff"}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-soft text-accent-green border border-accent-line rounded hover:bg-accent-green/15 transition-colors disabled:opacity-50"
          >
            {busy === "handoff" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Plane size={10} />
            )}{" "}
            Hand off to Claude
          </button>
          {/* v0.8-D — Draft patch: single-attempt async flight using the
              OAuth Claude sidecar (claude-sonnet-4-6) as executor. */}
          <button
            type="button"
            onClick={() => void handleDraftPatch()}
            disabled={!downstreamReady || busy === "draft"}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-bg-tertiary text-text-primary border border-bg-border rounded hover:bg-bg-elevated transition-colors disabled:opacity-50"
          >
            {busy === "draft" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <GitBranch size={10} />
            )}{" "}
            Draft patch
          </button>
          {/* v0.8-D — Save as memory: write the investigation as a manual
              MemoryEvent so it's available to future sessions. */}
          <button
            type="button"
            onClick={handleSaveAsMemory}
            disabled={!downstreamReady || busy === "memory"}
            className="inline-flex items-center gap-1.5 text-[10.5px] text-text-secondary hover:text-text-primary px-2 py-1 disabled:opacity-50"
          >
            {busy === "memory" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <StickyNote size={10} />
            )}{" "}
            Save as memory
          </button>
        </div>

        {feedback && (
          <div className="mt-2">
            <CtaFeedbackRow
              feedback={feedback}
              onDismiss={() => setFeedback(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface PRListProps {
  prs: GitHubPr[];
  isLoading: boolean;
  selectedNum: number | null;
  onSelect: (num: number) => void;
  // v0.8-C
  stateFilter: "open" | "closed" | "all";
  onStateFilterChange: (state: "open" | "closed" | "all") => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

function PRList({
  prs,
  isLoading,
  selectedNum,
  onSelect,
  stateFilter,
  onStateFilterChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: PRListProps) {
  // NOTE: GitHub's `/pulls` LIST endpoint does NOT return
  // `additions`/`deletions`/`changed_files`/`requested_reviewers` — those
  // require a per-PR GET. Rendering them from the list response produced
  // zeros for every PR (v0.7 FIX 3). Removed until per-PR fetch lands.
  // `draft` IS on the list response and is retained.
  return (
    <div className="flex flex-col min-h-0 overflow-hidden">
      {/* v0.8-C: state filter */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-bg-border flex-shrink-0">
        <StateFilterChip
          label="Open"
          active={stateFilter === "open"}
          onClick={() => onStateFilterChange("open")}
        />
        <StateFilterChip
          label="Closed"
          active={stateFilter === "closed"}
          onClick={() => onStateFilterChange("closed")}
        />
        <StateFilterChip
          label="All"
          active={stateFilter === "all"}
          onClick={() => onStateFilterChange("all")}
        />
        <div className="flex-1" />
        <span className="text-[9.5px] text-text-muted font-mono">
          {prs.length} loaded
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {isLoading && prs.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : prs.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-[11px] text-text-muted">
            No {stateFilter === "all" ? "" : stateFilter} pull requests
          </div>
        ) : (
          <>
            {prs.map((pr) => {
              const draft = !!pr.draft;
              const active = selectedNum === pr.number;
              return (
                <button
                  type="button"
                  key={pr.number}
                  onClick={() => onSelect(pr.number)}
                  className={`w-full text-left bg-bg-secondary border rounded-lg px-3.5 py-2.5 transition-colors ${
                    active
                      ? "border-accent-purple/50"
                      : "border-bg-border hover:border-line-strong"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <GitBranch
                      size={13}
                      className={`mt-0.5 flex-shrink-0 ${
                        draft ? "text-text-muted" : "text-accent-purple"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[10px] text-text-muted tabular-nums">
                          #{pr.number}
                        </span>
                        <span className="text-xs font-medium text-text-primary">
                          {pr.title}
                        </span>
                        {draft && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted border border-bg-border">
                            draft
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5 text-[10px] text-text-muted flex-wrap">
                        <span>
                          <span className="text-text-secondary">
                            {pr.user?.login ?? "unknown"}
                          </span>{" "}
                          wants to merge
                        </span>
                        <span className="font-mono text-text-secondary">
                          {pr.head?.ref ?? ""}
                        </span>
                        <ChevronRight size={9} />
                        <span className="font-mono text-text-secondary">
                          {pr.base?.ref ?? ""}
                        </span>
                        <span className="text-line-strong">·</span>
                        <span className="text-text-muted">
                          opened {timeAgo(pr.created_at)} ago
                        </span>
                        {/* v0.8-B: pr check pill */}
                        <PrCheckPill pr={pr} />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 items-end flex-shrink-0">
                      <span
                        className={`inline-flex items-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded-full font-medium ${
                          pr.state === "closed"
                            ? "bg-accent-purple/15 text-accent-purple"
                            : "bg-accent-green/15 text-accent-green"
                        }`}
                      >
                        <Check size={9} />
                        {pr.state ?? "open"}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {/* v0.8-C: pagination */}
            {hasMore && (
              <div className="flex items-center justify-center gap-2 px-3 py-3">
                <span className="text-[10px] text-text-muted">
                  Showing {prs.length}
                </span>
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-bg-tertiary text-text-primary border border-bg-border rounded hover:border-line-strong disabled:opacity-60"
                >
                  {isLoadingMore && (
                    <Loader2 size={10} className="animate-spin" />
                  )}
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ActivityItem {
  kind:
    | "pr_opened"
    | "pr_merged"
    | "issue_opened"
    | "issue_commented"
    | "checks_passed"
    | "issue_imported";
  who: string;
  what: string;
  num: number;
  iso: string;
}

function ActivityFeed({
  issues,
  prs,
  owner,
  repo,
}: {
  issues: GitHubIssue[];
  prs: GitHubPr[];
  owner: string;
  repo: string;
}) {
  const items = useMemo<ActivityItem[]>(() => {
    const out: ActivityItem[] = [];
    for (const pr of prs) {
      out.push({
        kind: "pr_opened",
        who: pr.user?.login ?? "unknown",
        what: pr.title,
        num: pr.number,
        iso: pr.created_at,
      });
    }
    for (const iss of issues) {
      out.push({
        kind: "issue_opened",
        who: iss.user.login,
        what: iss.title,
        num: iss.number,
        iso: iss.created_at,
      });
    }
    return out
      .filter((a) => a.iso)
      .sort((a, b) => new Date(b.iso).getTime() - new Date(a.iso).getTime())
      .slice(0, 30);
  }, [issues, prs]);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* v0.8-F: catch me up */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary flex-shrink-0 relative">
        <Clock size={11} className="text-text-muted" />
        <span className="text-[11px] font-semibold text-text-primary">
          Recent activity
        </span>
        <div className="flex-1" />
        {owner && repo && <AICatchUpButton owner={owner} repo={repo} />}
      </div>
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-text-muted">
          No recent activity yet.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3.5">
          <div className="flex flex-col border-l border-dashed border-bg-border ml-1.5 pl-3.5">
        {items.map((a, i) => {
          const meta = activityMeta(a.kind);
          return (
            <div
              key={`${a.kind}-${a.num}-${i}`}
              className={`relative py-2 ${
                i < items.length - 1 ? "border-b border-bg-border" : ""
              }`}
            >
              <span
                className={`absolute -left-[22px] top-2.5 w-4 h-4 rounded-full bg-bg-secondary grid place-items-center border ${meta.border} ${meta.text}`}
              >
                {meta.icon}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-secondary flex-1 min-w-0">
                  <span className="text-text-primary font-medium">{a.who}</span>
                  {" · "}
                  <span className="truncate">{a.what}</span>
                </span>
                <span className="font-mono text-[10px] text-text-muted flex-shrink-0">
                  #{a.num}
                </span>
                <span className="text-[10px] text-text-muted flex-shrink-0">
                  {timeAgo(a.iso)} ago
                </span>
              </div>
            </div>
          );
        })}
          </div>
        </div>
      )}
    </div>
  );
}

function activityMeta(kind: ActivityItem["kind"]): {
  icon: React.ReactNode;
  text: string;
  border: string;
} {
  switch (kind) {
    case "pr_merged":
    case "pr_opened":
      return {
        icon: <GitBranch size={10} />,
        text: "text-accent-purple",
        border: "border-accent-purple/40",
      };
    case "issue_opened":
      return {
        icon: <AlertCircle size={10} />,
        text: "text-accent-green",
        border: "border-accent-green/40",
      };
    case "issue_commented":
      return {
        icon: <Brain size={10} />,
        text: "text-accent-blue",
        border: "border-accent-blue/40",
      };
    case "checks_passed":
      return {
        icon: <Check size={10} />,
        text: "text-accent-green",
        border: "border-accent-green/40",
      };
    case "issue_imported":
    default:
      return {
        icon: <Diamond size={10} />,
        text: "text-accent-green",
        border: "border-accent-line",
      };
  }
}
