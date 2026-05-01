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
  X,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { PRModal } from "@/components/views/PRModal";
import { DiffViewer } from "@/components/views/DiffViewer";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { IssueBody } from "@/components/views/github/IssueBody";
import { RepoSelector } from "@/components/views/github/RepoSelector";
import type { GitHubIssue, GitHubPr } from "@/types/github";

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
    repos,
    issues,
    isLoading,
    error,
    investigation,
    isInvestigating,
    prs,
    prDiff,
    isPrLoading,
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
  } = useGitHubStore();

  const addIssue = useIssueStore((s) => s.addIssue);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const [tokenInput, setTokenInput] = useState("");
  const [tab, setTab] = useState<TabKey>("issues");
  const [selectedIssueNum, setSelectedIssueNum] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showPRModal, setShowPRModal] = useState(false);
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);

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

  const username =
    repos[0]?.owner?.login && config.selectedRepo
      ? config.selectedRepo.owner
      : repos[0]?.owner?.login ?? "user";

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
          />
          <IssueDetail
            issue={selectedIssue}
            investigation={investigation}
            isInvestigating={isInvestigating}
            onImport={handleImportIssue}
            onInvestigate={(num) => investigateIssue(projectPath, num)}
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
            </div>
          )}
        </div>
      ) : (
        <ActivityFeed issues={issues} prs={prs} />
      )}

      {showPRModal && (
        <PRModal
          onClose={() => setShowPRModal(false)}
          onSubmit={createPR}
          isLoading={isLoading}
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
}

function SubTabs({ tab, onTab, issueCount, prCount }: SubTabsProps) {
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
        synced{" "}
        <span className="font-mono text-text-secondary">just now</span>
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
}

function IssueList({
  issues,
  totalIssues,
  isLoading,
  selectedNum,
  onSelect,
  searchQuery,
  onSearchChange,
}: IssueListProps) {
  return (
    <div className="border-r border-bg-border flex flex-col min-w-0 bg-bg-secondary overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-bg-border flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[10.5px] text-text-muted">
          <Search size={10} />
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="is:open is:issue"
            className="flex-1 bg-transparent text-[10.5px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-bg-border flex-shrink-0 text-[10px] text-text-muted">
        <span className="text-text-secondary">{totalIssues} open</span>
        <span className="text-line-strong">·</span>
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
            No open issues found
          </div>
        ) : (
          issues.map((iss) => {
            const active = selectedNum === iss.number;
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
                  className="text-accent-green mt-0.5 flex-shrink-0"
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
          })
        )}
      </div>
    </div>
  );
}

interface IssueDetailProps {
  issue: GitHubIssue | null;
  investigation: string | null;
  isInvestigating: boolean;
  onImport: (issue: GitHubIssue) => void;
  onInvestigate: (issueNumber: number) => void;
}

function IssueDetail({
  issue,
  investigation,
  isInvestigating,
  onImport,
  onInvestigate,
}: IssueDetailProps) {
  if (!issue) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-text-muted bg-bg-primary">
        Select an issue to view details
      </div>
    );
  }

  return (
    <div className="overflow-y-auto flex flex-col min-h-0 bg-bg-primary">
      <div className="px-4 py-3.5 border-b border-bg-border">
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-green/15 text-accent-green border border-accent-green/30">
                <AlertCircle size={9} /> Open
              </span>
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
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-soft text-accent-green border border-accent-line rounded hover:bg-accent-green/20 transition-colors"
        >
          <Plane size={10} /> Plan flight
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[10.5px] text-text-muted hover:text-text-primary px-2 py-1 transition-colors"
        >
          <GitBranch size={10} /> Branch from issue
        </button>
      </div>

      <div className="px-4 py-3.5 border-b border-bg-border">
        <IssueBody body={issue.body} />
      </div>

      <div className="px-4 py-3.5 flex-1 min-h-0">
        <InvestigationPanel
          investigation={investigation}
          isInvestigating={isInvestigating}
          onRun={() => onInvestigate(issue.number)}
        />
      </div>
    </div>
  );
}

interface InvestigationPanelProps {
  investigation: string | null;
  isInvestigating: boolean;
  onRun: () => void;
}

function InvestigationPanel({
  investigation,
  isInvestigating,
  onRun,
}: InvestigationPanelProps) {
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

        <div className="flex gap-1.5 mt-3 pt-2.5 border-t border-dashed border-bg-border">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-soft text-accent-green border border-accent-line rounded hover:bg-accent-green/20 transition-colors"
          >
            <Plane size={10} /> Hand off to Claude
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-bg-tertiary text-text-primary border border-bg-border rounded hover:bg-bg-elevated transition-colors"
          >
            <GitBranch size={10} /> Draft patch
          </button>
          <button
            type="button"
            className="text-[10.5px] text-text-muted hover:text-text-primary px-2 py-1 transition-colors"
          >
            Save as memory
          </button>
        </div>
      </div>
    </div>
  );
}

interface PRListProps {
  prs: GitHubPr[];
  isLoading: boolean;
  selectedNum: number | null;
  onSelect: (num: number) => void;
}

interface PrExtended extends GitHubPr {
  draft?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  requested_reviewers?: unknown[];
}

function PRList({ prs, isLoading, selectedNum, onSelect }: PRListProps) {
  if (isLoading && prs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  if (prs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-[11px] text-text-muted">
        No open pull requests
      </div>
    );
  }
  return (
    <div className="overflow-y-auto px-4 py-3 flex flex-col gap-2">
      {prs.map((raw) => {
        const pr = raw as PrExtended;
        const additions = pr.additions ?? 0;
        const deletions = pr.deletions ?? 0;
        const files = pr.changed_files ?? 0;
        const reviews = Array.isArray(pr.requested_reviewers)
          ? pr.requested_reviewers.length
          : 0;
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
                  {files > 0 && (
                    <>
                      <span className="text-line-strong">·</span>
                      <span className="text-text-secondary">
                        {files} file{files === 1 ? "" : "s"}
                      </span>
                    </>
                  )}
                  {(additions > 0 || deletions > 0) && (
                    <>
                      <span className="text-accent-green">+{additions}</span>
                      <span className="text-accent-red">−{deletions}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1 items-end flex-shrink-0">
                <span className="inline-flex items-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded-full font-medium bg-accent-green/15 text-accent-green">
                  <Check size={9} />
                  {pr.state ?? "open"}
                </span>
                {reviews > 0 && (
                  <span className="text-[9.5px] text-text-muted">
                    {reviews} review{reviews === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>

            {(additions > 0 || deletions > 0) && (
              <div className="flex gap-0.5 mt-2 h-1 rounded-full overflow-hidden bg-bg-tertiary">
                <div
                  className="bg-accent-green"
                  style={{ flex: additions || 0.0001 }}
                />
                <div
                  className="bg-accent-red"
                  style={{ flex: deletions || 0.0001 }}
                />
              </div>
            )}
          </button>
        );
      })}
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
}: {
  issues: GitHubIssue[];
  prs: GitHubPr[];
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

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] text-text-muted">
        No recent activity yet.
      </div>
    );
  }

  return (
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
