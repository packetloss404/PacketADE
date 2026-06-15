import { Check, ChevronRight, GitBranch, Loader2 } from "lucide-react";
import type { GitHubPr } from "@/types/github";
import { PrCheckPill } from "@/components/views/github/PrCheckPill";
import { StateFilterChip, timeAgo } from "@/components/views/github/shared";

export interface PRListProps {
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

export function PRList({
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
