// v0.8-B: full PR checks tab.
//
// Lists every check-run + legacy status context posted against the PR's
// head commit, grouped Failing → Pending → Passing → Skipped/Neutral.
// Each row links to `html_url` (Actions log / external CI run) when
// GitHub reports one. A "Refresh" button re-calls `fetchPrChecks` with
// `force: true` to bypass the store cache.

import { useEffect, useMemo } from "react";
import {
  AlertCircle,
  Check,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import type {
  GitHubCheckCombinedState,
  GitHubCheckRun,
  GitHubPr,
  GitHubPrChecks,
} from "@/types/github";

interface PRChecksTabProps {
  pr: GitHubPr;
}

function prChecksKey(
  owner: string,
  repo: string,
  number: number,
): string {
  return `${owner}/${repo}#${number}`;
}

type Bucket =
  | "failing"
  | "pending"
  | "passing"
  | "neutral";

function bucketFor(run: GitHubCheckRun): Bucket {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "passing";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
      return "failing";
    case "neutral":
    case "skipped":
    case null:
    case undefined:
      return "neutral";
    default:
      return "neutral";
  }
}

const BUCKET_ORDER: Bucket[] = ["failing", "pending", "passing", "neutral"];
const BUCKET_LABEL: Record<Bucket, string> = {
  failing: "Failing",
  pending: "In progress",
  passing: "Passing",
  neutral: "Skipped / neutral",
};

function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

export function PRChecksTab({ pr }: PRChecksTabProps) {
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
      void fetchPrChecks(pr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.number, config.selectedRepo?.owner, config.selectedRepo?.repo]);

  const grouped = useMemo(() => {
    const out: Record<Bucket, GitHubCheckRun[]> = {
      failing: [],
      pending: [],
      passing: [],
      neutral: [],
    };
    if (!checks) return out;
    for (const run of checks.runs) {
      out[bucketFor(run)].push(run);
    }
    // Sort by name within each bucket for stable display.
    for (const k of BUCKET_ORDER) {
      out[k].sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [checks]);

  return (
    <div className="flex flex-col h-full bg-bg-primary min-h-0">
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-bg-border bg-bg-secondary flex-shrink-0">
        <AlertCircle size={12} className="text-text-secondary" />
        <span className="text-xs font-semibold text-text-primary">
          Checks
        </span>
        {checks && <RollupSummary checks={checks} />}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void fetchPrChecks(pr, { force: true })}
          disabled={loading}
          title="Re-fetch CI status from GitHub"
          className="inline-flex items-center gap-1 text-[10.5px] text-text-muted hover:text-text-primary transition-colors px-1.5 py-1"
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && !checks ? (
          <div className="flex items-center justify-center py-12 text-text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-[11px] text-accent-red">
            Failed to load checks: {error}
          </div>
        ) : !checks || checks.total === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[11px] text-text-muted gap-2">
            <CircleDashed size={20} className="text-text-muted" />
            <span>No CI runs have been posted against this PR's head commit.</span>
          </div>
        ) : (
          <div className="flex flex-col">
            {BUCKET_ORDER.map((bucket) => {
              const runs = grouped[bucket];
              if (runs.length === 0) return null;
              return (
                <div key={bucket} className="border-b border-bg-border">
                  <div className="px-3.5 py-1.5 bg-bg-secondary text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {BUCKET_LABEL[bucket]} · {runs.length}
                  </div>
                  {runs.map((run) => (
                    <CheckRow key={`${bucket}-${run.id}-${run.name}`} run={run} bucket={bucket} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function RollupSummary({ checks }: { checks: GitHubPrChecks }) {
  const tone = combinedTone(checks.combinedState);
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 rounded-full text-[10px] font-medium ${tone.bg} ${tone.text} ${tone.border}`}
      style={{ height: 18 }}
    >
      {tone.icon}
      {checks.passing} passing
      {checks.failing > 0 && ` · ${checks.failing} failing`}
      {checks.pending > 0 && ` · ${checks.pending} pending`}
    </span>
  );
}

function combinedTone(state: GitHubCheckCombinedState) {
  switch (state) {
    case "success":
      return {
        bg: "bg-accent-green/10",
        text: "text-accent-green",
        border: "border border-accent-green/40",
        icon: <Check size={9} />,
      };
    case "failure":
      return {
        bg: "bg-accent-red/10",
        text: "text-accent-red",
        border: "border border-accent-red/40",
        icon: <X size={9} />,
      };
    case "pending":
      return {
        bg: "bg-accent-yellow/10",
        text: "text-accent-yellow",
        border: "border border-accent-yellow/40",
        icon: <Loader2 size={9} className="animate-spin" />,
      };
    default:
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-muted",
        border: "border border-bg-border",
        icon: <CircleDashed size={9} />,
      };
  }
}

function CheckRow({ run, bucket }: { run: GitHubCheckRun; bucket: Bucket }) {
  const icon = bucketIcon(bucket);
  return (
    <div className="flex items-center gap-2 px-3.5 py-2 border-t border-bg-border first:border-t-0 hover:bg-bg-secondary/60 transition-colors">
      <span className={`flex-shrink-0 ${icon.text}`} title={describeRun(run)}>
        {icon.node}
      </span>
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-[11px] text-text-primary truncate">{run.name}</span>
        <span className="text-[10px] text-text-muted truncate">
          {run.appName ?? "external"}
          {run.conclusion && ` · ${run.conclusion}`}
          {run.status !== "completed" && ` · ${run.status}`}
        </span>
      </div>
      <span className="font-mono text-[10px] text-text-muted tabular-nums flex-shrink-0 w-12 text-right">
        {formatDuration(run.durationMs)}
      </span>
      {run.htmlUrl ? (
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noreferrer"
          title="Open CI run"
          className="inline-flex items-center gap-1 text-[10px] text-accent-blue hover:underline px-1.5 py-0.5 flex-shrink-0"
        >
          view <ExternalLink size={9} />
        </a>
      ) : (
        <span className="text-[10px] text-text-muted px-1.5 py-0.5 flex-shrink-0">—</span>
      )}
    </div>
  );
}

function bucketIcon(bucket: Bucket): { node: React.ReactNode; text: string } {
  switch (bucket) {
    case "passing":
      return { node: <Check size={11} />, text: "text-accent-green" };
    case "failing":
      return { node: <X size={11} />, text: "text-accent-red" };
    case "pending":
      return { node: <Loader2 size={11} className="animate-spin" />, text: "text-accent-yellow" };
    default:
      return { node: <CircleDashed size={11} />, text: "text-text-muted" };
  }
}

function describeRun(run: GitHubCheckRun): string {
  const parts: string[] = [run.name];
  if (run.appName) parts.push(`(${run.appName})`);
  if (run.conclusion) parts.push(`→ ${run.conclusion}`);
  else parts.push(`→ ${run.status}`);
  if (run.durationMs != null) parts.push(`· ${formatDuration(run.durationMs)}`);
  return parts.join(" ");
}
