import { AlertCircle, Loader2, Search, Sparkles } from "lucide-react";
import type { GitHubIssue } from "@/types/github";
import { StateFilterChip } from "@/components/views/github/shared";

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
  aiAssistAvailable?: boolean;
}

export function IssueList({
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
  aiAssistAvailable = true,
}: IssueListProps) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden border-r border-bg-border bg-bg-secondary">
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-bg-border px-2.5 py-2">
        <div className="flex flex-1 items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10.5px] text-text-muted">
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
          disabled={untriagedCount === 0 || !aiAssistAvailable}
          title={
            !aiAssistAvailable
              ? "AI triage is available for local GitHub Workspaces only"
              : untriagedCount === 0
                ? "No untriaged issues to triage"
                : `Run AI triage on ${untriagedCount} untriaged issue(s)`
          }
          className="bg-accent-blue/15 border-accent-blue/30 hover:bg-accent-blue/25 inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-accent-blue transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Sparkles size={10} />
          Triage
          {untriagedCount > 0 && (
            <span className="bg-accent-blue/20 rounded-full px-1 text-[9px]">{untriagedCount}</span>
          )}
        </button>
      </div>

      {/* v0.8-C: state filter */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-bg-border px-2.5 py-1.5">
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
        <span className="font-mono text-[9.5px] text-text-muted">
          {totalIssues} {stateFilter}
        </span>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1 border-b border-bg-border px-2.5 py-1 text-[10px] text-text-muted">
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
          <div className="py-12 text-center text-[11px] text-text-muted">
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
                  className={`flex w-full items-start gap-2 border-b border-bg-border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "border-l-2 border-l-accent-green bg-bg-tertiary"
                      : "hover:bg-bg-tertiary/50 border-l-2 border-l-transparent"
                  }`}
                >
                  <AlertCircle
                    size={11}
                    className={`${
                      isClosed ? "text-accent-purple" : "text-accent-green"
                    } mt-0.5 flex-shrink-0`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[10px] tabular-nums text-text-muted">
                        #{iss.number}
                      </span>
                      <span
                        className="flex-1 overflow-hidden text-[11px] leading-snug text-text-primary"
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                        }}
                      >
                        {iss.title}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {iss.labels.slice(0, 3).map((l) => (
                        <span
                          key={l.name}
                          className="rounded-full border px-1.5 py-0.5 text-[9px]"
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
                      <span className="text-[9.5px] text-text-muted">{iss.user.login}</span>
                    </div>
                  </div>
                </button>
              );
            })}
            {/* v0.8-C: pagination */}
            {hasMore && (
              <div className="flex items-center justify-center gap-2 border-t border-bg-border px-3 py-3">
                <span className="text-[10px] text-text-muted">Showing {totalLoaded}</span>
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                  className="inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-tertiary px-2.5 py-1 text-[10.5px] font-medium text-text-primary hover:border-line-strong disabled:opacity-60"
                >
                  {isLoadingMore && <Loader2 size={10} className="animate-spin" />}
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
