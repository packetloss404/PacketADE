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

