// v0.8-B: PR CI status pill.
//
// Renders a compact 18px-tall pill next to a PR title showing the rollup of
// every check-run + legacy status context posted against the PR's head
// commit. Lazily fetches `githubStore.fetchPrChecks` on mount when the
// cache is empty so the PR list doesn't fire N requests on first render
// (each pill triggers its own fetch — fan-out is bounded by the list size,
// which is `per_page=30`).
//
// States:
//   - loading      → muted "loading…" pill
//   - error        → red-bordered "checks!" pill, full message in tooltip
//   - combined === "none" → faint "no checks" pill
//   - success      → green ✓ N
//   - failure      → red × N failing
//   - pending      → yellow … N running
//   - neutral      → muted ○ N

import { useEffect } from "react";
import { Check, CircleDashed, Loader2, X } from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import type { GitHubPr, GitHubPrChecks } from "@/types/github";

interface PrCheckPillProps {
  pr: GitHubPr;
}

function prChecksKey(
  owner: string,
  repo: string,
  number: number,
): string {
  return `${owner}/${repo}#${number}`;
}

export function PrCheckPill({ pr }: PrCheckPillProps) {
  const config = useGitHubStore((s) => s.config);
  const fetchPrChecks = useGitHubStore((s) => s.fetchPrChecks);
  const checks = useGitHubStore((s) =>
    s.config.selectedRepo
      ? s.prChecks[
          prChecksKey(
            s.config.selectedRepo.owner,
            s.config.selectedRepo.repo,
            pr.number,
          )
        ]
      : undefined,
  );
  const loading = useGitHubStore((s) =>
    s.config.selectedRepo
      ? Boolean(
          s.prChecksLoading[
            prChecksKey(
              s.config.selectedRepo.owner,
              s.config.selectedRepo.repo,
              pr.number,
            )
          ],
        )
      : false,
  );
  const error = useGitHubStore((s) =>
    s.config.selectedRepo
      ? s.prChecksError[
          prChecksKey(
            s.config.selectedRepo.owner,
            s.config.selectedRepo.repo,
            pr.number,
          )
        ]
      : undefined,
  );

  useEffect(() => {
    if (!config.selectedRepo) return;
    if (!checks && !loading && !error) {
      // fire-and-forget; the store dedupes via `prChecksLoading`.
      void fetchPrChecks(pr);
    }
    // Intentionally narrow deps — once a fetch is in-flight or cached, we
    // don't want to re-fire just because the parent re-rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.number, config.selectedRepo?.owner, config.selectedRepo?.repo]);

  if (loading && !checks) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-bg-tertiary text-text-muted border border-bg-border"
        style={{ height: 18 }}
        title="Fetching CI status"
      >
        <Loader2 size={9} className="animate-spin" />
        <span>loading…</span>
      </span>
    );
  }

  if (error) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-accent-red/10 text-accent-red border border-accent-red/40"
        style={{ height: 18 }}
        title={`Failed to load checks: ${error}`}
      >
        <X size={9} /> checks!
      </span>
    );
  }

  if (!checks) {
    // Pre-fetch state (no cached entry yet and no in-flight request). Render
    // an invisible spacer so layout doesn't jump once the pill mounts.
    return <span className="inline-block" style={{ height: 18, width: 0 }} />;
  }

  return <RenderPill checks={checks} />;
}

function RenderPill({ checks }: { checks: GitHubPrChecks }) {
  const tooltip = describeChecks(checks);
  if (checks.total === 0 || checks.combinedState === "none") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-bg-tertiary text-text-muted border border-bg-border"
        style={{ height: 18 }}
        title={tooltip}
      >
        <CircleDashed size={9} /> no checks
      </span>
    );
  }

  if (checks.combinedState === "failure") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-accent-red/10 text-accent-red border border-accent-red/40"
        style={{ height: 18 }}
        title={tooltip}
      >
        <X size={9} /> {checks.failing} failing
      </span>
    );
  }

  if (checks.combinedState === "pending") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-accent-yellow/10 text-accent-yellow border border-accent-yellow/40"
        style={{ height: 18 }}
        title={tooltip}
      >
        <Loader2 size={9} className="animate-spin" /> {checks.pending} running
      </span>
    );
  }

  if (checks.combinedState === "success") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-accent-green/10 text-accent-green border border-accent-green/40"
        style={{ height: 18 }}
        title={tooltip}
      >
        <Check size={9} /> {checks.passing}
      </span>
    );
  }

  // neutral / skipped
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium bg-bg-tertiary text-text-muted border border-bg-border"
      style={{ height: 18 }}
      title={tooltip}
    >
      <CircleDashed size={9} /> {checks.total}
    </span>
  );
}

function describeChecks(checks: GitHubPrChecks): string {
  const parts: string[] = [];
  if (checks.passing > 0) parts.push(`${checks.passing} passing`);
  if (checks.failing > 0) parts.push(`${checks.failing} failing`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  const skipped = checks.total - checks.passing - checks.failing - checks.pending;
  if (skipped > 0) parts.push(`${skipped} skipped/neutral`);
  if (parts.length === 0) return "No checks have been posted against this PR yet";
  return parts.join(" · ");
}
