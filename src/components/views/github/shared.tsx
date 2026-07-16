// Shared helpers for the GitHubView sub-components. Extracted to eliminate
// the verbatim duplicates that the parallel-extraction agents had to leave
// behind to avoid sibling-conflict on GitHubView.tsx.

/** Open/closed/all state-filter tab pill used in both IssueList and PRList. */
export function StateFilterChip({
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

/** Format an ISO date as "5m" / "3h" / "2d" / "1mo" / "1y" relative to now. */
export function timeAgo(iso: string | undefined | null): string {
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
