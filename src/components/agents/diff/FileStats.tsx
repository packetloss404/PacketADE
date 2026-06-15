import type { PerFileDiffStat } from "@/lib/aggregateConversationDiffs";

export interface FileStatsProps {
  /** Pre-computed per-file stat from `aggregateConversationDiffs`. */
  stat: PerFileDiffStat | undefined;
  /** True while the parent is still resolving the aggregate. */
  loading: boolean;
}

/**
 * Compact "+adds / -dels (new)" badge rendered next to file rows in the diff
 * pane's left list. Stays a pure presentational component so it can be
 * reused by both DiffPane and EmbeddedDiffPane (and anywhere else that
 * surfaces per-file diff stats).
 */
export function FileStats({ stat, loading }: FileStatsProps) {
  if (loading) {
    return <span className="text-text-muted text-[10px]">…</span>;
  }
  if (!stat) {
    return <span className="text-text-muted text-[10px]">—</span>;
  }
  return (
    <span className="flex items-center gap-1 font-mono text-[10px]">
      {stat.isNew && (
        <span
          className="text-accent-green border border-accent-green/30 bg-accent-green/10 px-1 rounded"
          title="New file"
        >
          new
        </span>
      )}
      <span className="text-accent-green">+{stat.adds}</span>
      <span className="text-accent-red">-{stat.dels}</span>
    </span>
  );
}
