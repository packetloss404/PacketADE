import { useMemo } from "react";
import {
  AlertCircle,
  Brain,
  Check,
  Clock,
  Diamond,
  GitBranch,
} from "lucide-react";
import { AICatchUpButton } from "@/components/views/github/AICatchUpButton";
import { timeAgo } from "@/components/views/github/shared";
import type { GitHubIssue, GitHubPr } from "@/types/github";

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

interface ActivityFeedProps {
  issues: GitHubIssue[];
  prs: GitHubPr[];
  owner: string;
  repo: string;
}

export function ActivityFeed({ issues, prs, owner, repo }: ActivityFeedProps) {
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
