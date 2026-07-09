import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Coins,
  FolderOpen,
  GitBranch as GitBranchIcon,
  Server,
} from "lucide-react";
import { estimateTurnCostUsd } from "@/lib/conversationCost";
import { gitSafetyCheck, type GitSafetyReport } from "@/lib/tauri";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import type { AgentConversation } from "@/types/agent-conversation";

const POLL_INTERVAL_MS = 30_000;

function basenameOf(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "$<0.01";
  return `$${usd.toFixed(2)}`;
}

interface SessionMetaLineProps {
  conversation: AgentConversation;
}

/**
 * Thin single-line replacement for SessionHealthBar. Model text, ctx%,
 * token count, and turn/tool-call/pending counts all died with that
 * component (vanity — the model picker and ContextUsageRing already show
 * model/context once each, and pending-approval count lives in
 * PendingApprovalsSection). This line owns exactly three facts:
 *
 * - project pill (custom label or basename, full path on hover)
 * - git branch/dirty/behind-upstream (ported verbatim from SessionHealthBar)
 * - session cost, api-mode only, summed from the P0-5 stamped `costUsd` on
 *   each assistant message (falling back to the same frontend estimate
 *   MessageList's per-turn pill uses for older persisted messages)
 */
export function SessionMetaLine({ conversation }: SessionMetaLineProps) {
  const projectLabels = useAgentSidebarPrefsStore((s) => s.projectLabels);
  const [report, setReport] = useState<GitSafetyReport | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const gitCancelled = useRef(false);

  const isSsh = !!conversation.sshTarget;
  const projectPath = conversation.projectPath;
  const customLabel = projectLabels[projectPath];
  const displayLabel = customLabel || basenameOf(projectPath) || "(no project)";

  // Per-conversation git safety poll (branch + dirty state + behind-upstream),
  // ported verbatim from SessionHealthBar. Skipped for SSH targets and
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

  const isApi = conversation.mode === "api";

  const sessionCost = useMemo(() => {
    if (!isApi) return null;
    let total = 0;
    for (const m of conversation.messages ?? []) {
      if (m.role !== "assistant") continue;
      total += m.costUsd ?? estimateTurnCostUsd(conversation.model, m) ?? 0;
    }
    return total;
  }, [isApi, conversation.messages, conversation.model]);

  return (
    <div className="flex items-center gap-3 px-3 py-1 bg-bg-primary border-b border-line-soft text-meta text-text-muted shrink-0 overflow-hidden">
      {/* Project pill */}
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

      {/* Git cluster */}
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

      {/* Right-aligned session cost (api-only) */}
      {isApi && sessionCost != null && sessionCost > 0 && (
        <Tooltip content="Estimated session cost" side="bottom">
          <span className="ml-auto flex items-center gap-1 shrink-0">
            <Coins size={10} />
            <span>{formatCost(sessionCost)}</span>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
