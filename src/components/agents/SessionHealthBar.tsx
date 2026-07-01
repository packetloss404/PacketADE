import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Coins,
  Cpu,
  FolderOpen,
  Gauge,
  GitBranch as GitBranchIcon,
  Server,
} from "lucide-react";
import {
  aggregateConversationCost,
  formatCostPill,
} from "@/lib/conversationCost";
import { gitSafetyCheck, type GitSafetyReport } from "@/lib/tauri";
import { computeContextOccupancy } from "@/lib/modelContext";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";

const POLL_INTERVAL_MS = 30_000;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function basenameOf(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

interface SessionCounts {
  turns: number;
  toolCalls: number;
  pending: number;
  received: number;
}

interface SessionHealthBarProps {
  conversation: AgentConversation;
  counts: SessionCounts;
}

/**
 * Single consolidated session status bar mounted directly under the chat
 * header. Wave 3 merged what used to be three stacked strips into this one
 * de-duplicated row:
 *
 * - the header status line (turns · tool calls · pending approvals),
 * - the old SessionHealthBar (model · context gauge · tokens · session $),
 * - the old AgentStatusBar (project pill · git safety).
 *
 * Git branch is now sourced ONCE from the richer `gitSafetyCheck` (branch +
 * dirty + behind-upstream), replacing the previous plain `getGitBranch` poll
 * so the branch is no longer shown twice. The model/context/tokens/cost
 * cluster is API-mode only; the project pill, counts and git safety render
 * for every conversation.
 */
export function SessionHealthBar({ conversation, counts }: SessionHealthBarProps) {
  const projectLabels = useAgentTaskStore((s) => s.projectLabels);
  const [report, setReport] = useState<GitSafetyReport | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const gitCancelled = useRef(false);

  const isSsh = !!conversation.sshTarget;
  const projectPath = conversation.projectPath;
  const customLabel = projectLabels[projectPath];
  const displayLabel = customLabel || basenameOf(projectPath) || "(no project)";

  // Per-conversation git safety poll (branch + dirty state + behind-upstream).
  // Each conversation can target a different project than layoutStore, so we
  // poll off `conversation.projectPath` directly. Skipped for SSH targets and
  // project-less conversations.
  useEffect(() => {
    gitCancelled.current = false;
    if (isSsh || !projectPath) {
      setReport(null);
      return undefined;
    }

    const run = async () => {
      setGitLoading(true);
      try {
        const next = await gitSafetyCheck(projectPath);
        if (!gitCancelled.current) setReport(next);
      } catch {
        if (!gitCancelled.current) setReport(null);
      } finally {
        if (!gitCancelled.current) setGitLoading(false);
      }
    };

    void run();
    const interval = window.setInterval(run, POLL_INTERVAL_MS);
    return () => {
      gitCancelled.current = true;
      window.clearInterval(interval);
    };
  }, [projectPath, isSsh]);

  const { totalTokens, estCost } = useMemo(
    () => aggregateConversationCost(conversation),
    [conversation],
  );

  // Context usage = the LATEST assistant turn's resident window
  // (input + cache read + cache write), not a cross-turn sum. Each turn
  // re-sends the whole window, so summing multi-counts the same context
  // and pins the gauge to 100%. The shared lib is the single source of
  // truth for both the window size and the occupancy math.
  const occupancy = useMemo(() => {
    const messages = conversation.messages ?? [];
    let latest: AgentMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.role === "assistant" &&
        ((m.inputTokens ?? 0) > 0 ||
          (m.cacheReadTokens ?? 0) > 0 ||
          (m.cacheWriteTokens ?? 0) > 0)
      ) {
        latest = m;
        break;
      }
    }
    return computeContextOccupancy({
      inputTokens: latest?.inputTokens,
      cacheReadTokens: latest?.cacheReadTokens,
      cacheWriteTokens: latest?.cacheWriteTokens,
      model: conversation.model,
    });
  }, [conversation.messages, conversation.model]);

  const ctxWindow = occupancy.totalTokens;
  const ctxPct = Math.round(occupancy.fraction * 100);
  const ctxColor =
    ctxPct >= 85
      ? "text-accent-red"
      : ctxPct >= 60
        ? "text-accent-amber"
        : "text-text-muted";

  const cost = formatCostPill(estCost, totalTokens);
  const isApi = conversation.mode === "api";

  const countBits: string[] = [];
  if (counts.turns > 0)
    countBits.push(`${counts.turns} turn${counts.turns === 1 ? "" : "s"}`);
  if (counts.toolCalls > 0)
    countBits.push(`${counts.toolCalls} tool call${counts.toolCalls === 1 ? "" : "s"}`);

  return (
    <div className="flex items-center gap-3 px-3 py-1 bg-bg-primary border-b border-line-soft text-[10px] text-text-muted shrink-0 overflow-hidden">
      {/* Left: project pill */}
      <Tooltip content={projectPath || "No project"} side="bottom">
        <span className="flex items-center gap-1.5 shrink-0 cursor-default">
          {isSsh ? (
            <Server size={10} className="text-accent-purple" />
          ) : (
            <FolderOpen size={10} className="text-text-muted" />
          )}
          <span className="truncate max-w-[160px]">{displayLabel}</span>
        </span>
      </Tooltip>

      {/* Session counts (merged from the old header status line) */}
      {countBits.length > 0 && (
        <Tooltip content={`${counts.turns} sent, ${counts.received} received`} side="bottom">
          <span className="shrink-0">{countBits.join(" · ")}</span>
        </Tooltip>
      )}
      {counts.pending > 0 && (
        <Badge tone="amber" className="shrink-0">
          {counts.pending} pending
        </Badge>
      )}

      {/* Right cluster: model / context / tokens / cost (API) + git safety */}
      <div className="ml-auto flex items-center gap-3 overflow-hidden">
        {isApi && conversation.model && (
          <Tooltip content={`Active model: ${conversation.model}`} side="bottom">
            <span className="flex items-center gap-1 shrink-0">
              <Cpu size={10} />
              <span className="text-text-secondary truncate max-w-[180px]">
                {conversation.model}
              </span>
            </span>
          </Tooltip>
        )}

        {isApi && (
          <Tooltip
            content={`Context: ~${fmtTokens(occupancy.usedTokens)} of ~${fmtTokens(ctxWindow)} model window (latest turn)`}
            side="bottom"
          >
            <span className={`flex items-center gap-1 shrink-0 ${ctxColor}`}>
              <Gauge size={10} />
              <span>{ctxPct}% ctx</span>
            </span>
          </Tooltip>
        )}

        {isApi && totalTokens > 0 && (
          <Tooltip
            content={`Total tokens this conversation: ${totalTokens.toLocaleString()}`}
            side="bottom"
          >
            <span className="flex items-center gap-1 shrink-0">
              <span>{fmtTokens(totalTokens)} tok</span>
            </span>
          </Tooltip>
        )}

        {isApi && cost && (
          <Tooltip
            content="Estimated session cost (sums per-message tokens × model rates)"
            side="bottom"
          >
            <span className="flex items-center gap-1 shrink-0">
              <Coins size={10} />
              <span>{cost}</span>
            </span>
          </Tooltip>
        )}

        {isSsh && conversation.sshTarget && (
          <span className="flex items-center gap-1 shrink-0 font-mono">
            <Server size={10} className="text-accent-purple" />
            SSH · {conversation.sshTarget.host}
          </span>
        )}

        {!isSsh && report && report.isGitRepo && (
          <span className="flex items-center gap-1 shrink-0 font-mono">
            <GitBranchIcon
              size={10}
              className={report.isClean ? "text-text-muted" : "text-accent-amber"}
            />
            <span className={report.isClean ? "text-text-muted" : "text-accent-amber"}>
              {report.branch ?? "?"}
            </span>
            {!report.isClean && (
              <Tooltip
                content={`${report.uncommittedCount} uncommitted change${
                  report.uncommittedCount === 1 ? "" : "s"
                }`}
                side="bottom"
              >
                <span className="inline-flex items-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />
                </span>
              </Tooltip>
            )}
            {report.behindUpstream > 0 && (
              <Tooltip content={`${report.behindUpstream} behind upstream`} side="bottom">
                <span className="flex items-center text-accent-amber">
                  <ArrowDownToLine size={9} />
                  {report.behindUpstream}
                </span>
              </Tooltip>
            )}
          </span>
        )}

        {!isSsh && !gitLoading && report && !report.isGitRepo && (
          <span className="flex items-center gap-1 shrink-0 text-text-faint">
            <FolderOpen size={10} />
            not a git repo
          </span>
        )}

        {!isSsh && gitLoading && !report && (
          <Spinner size={10} className="text-text-faint" />
        )}
      </div>
    </div>
  );
}
