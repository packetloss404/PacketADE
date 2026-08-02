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
  showChecks?: boolean;
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
  showChecks = true,
}: PRListProps) {
  // NOTE: GitHub's `/pulls` LIST endpoint does NOT return
  // `additions`/`deletions`/`changed_files`/`requested_reviewers` — those
  // require a per-PR GET. Rendering them from the list response produced
  // zeros for every PR (v0.7 FIX 3). Removed until per-PR fetch lands.
  // `draft` IS on the list response and is retained.
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      {/* v0.8-C: state filter */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-bg-border px-3 py-2">
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
        <span className="font-mono text-[9.5px] text-text-muted">{prs.length} loaded</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
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
                  className={`w-full rounded-lg border bg-bg-secondary px-3.5 py-2.5 text-left transition-colors ${
                    active ? "border-accent-purple/50" : "border-bg-border hover:border-line-strong"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <GitBranch
                      size={13}
                      className={`mt-0.5 flex-shrink-0 ${
                        draft ? "text-text-muted" : "text-accent-purple"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] tabular-nums text-text-muted">
                          #{pr.number}
                        </span>
                        <span className="text-xs font-medium text-text-primary">{pr.title}</span>
                        {draft && (
                          <span className="rounded-full border border-bg-border bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted">
                            draft
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5 text-[10px] text-text-muted">
                        <span>
                          <span className="text-text-secondary">{pr.user?.login ?? "unknown"}</span>{" "}
                          wants to merge
                        </span>
                        <span className="font-mono text-text-secondary">{pr.head?.ref ?? ""}</span>
                        <ChevronRight size={9} />
                        <span className="font-mono text-text-secondary">{pr.base?.ref ?? ""}</span>
                        <span className="text-line-strong">·</span>
                        <span className="text-text-muted">opened {timeAgo(pr.created_at)} ago</span>
                        {/* v0.8-B: pr check pill */}
                        {showChecks && <PrCheckPill pr={pr} />}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-end gap-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium ${
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
                <span className="text-[10px] text-text-muted">Showing {prs.length}</span>
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
