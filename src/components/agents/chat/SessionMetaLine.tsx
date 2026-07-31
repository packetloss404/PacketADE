import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  FolderOpen,
  GitBranch as GitBranchIcon,
  Plug,
  Server,
} from "lucide-react";
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

interface SessionMetaLineProps {
  conversation: AgentConversation;
}

/**
 * Thin single-line replacement for SessionHealthBar. Model text, ctx%,
 * token count, and turn/tool-call/pending counts all died with that
 * component (vanity — the model picker and ContextUsageRing already show
 * model/context once each, and pending-approval count lives in
 * PendingApprovalsSection). This line owns exactly two facts:
 *
 * - project pill (custom label or basename, full path on hover)
 * - git branch/dirty/behind-upstream (ported verbatim from SessionHealthBar)
 *
 * A right-aligned session-cost readout used to live here too; it went with the
 * rest of the cost reporting surface on 2026-07-31. Cost is still measured and
 * still drives the budget guardrails — it is just no longer displayed.
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

  // S8-Phase-B (Slice B): MCP servers the sidecar sourced from its own FS for
  // this session (remote sessions), plus any read/parse errors. Shown for all
  // sessions — it's a free signal for local stdio too — with amber styling
  // carrying the attention when a config file could not be read.
  const mcpSources = conversation.mcpSources;
  const mcpCount = mcpSources?.sources.length ?? 0;
  const mcpErrorCount = mcpSources?.readErrors.length ?? 0;
  const showMcpPill = !!mcpSources && (mcpCount > 0 || mcpErrorCount > 0);

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

      {/* MCP sources pill (S8-Phase-B) */}
      {showMcpPill && (
        <Tooltip
          content={
            <div className="flex flex-col gap-0.5 text-left">
              {mcpCount > 0 ? (
                mcpSources!.sources.map((s) => (
                  <span key={`${s.scope}:${s.name}`}>
                    {s.name} ({s.transport}, {s.scope})
                  </span>
                ))
              ) : (
                <span>No MCP servers sourced</span>
              )}
              {mcpErrorCount > 0 &&
                mcpSources!.readErrors.map((e) => (
                  <span key={`err:${e.scope}:${e.path}`} className="text-accent-amber">
                    {e.scope}: {e.path} — {e.message}
                  </span>
                ))}
            </div>
          }
          side="bottom"
        >
          <span className="flex items-center gap-1 shrink-0 cursor-default">
            <Plug
              size={10}
              className={mcpErrorCount > 0 ? "text-accent-amber" : "text-text-muted"}
            />
            <span className={mcpErrorCount > 0 ? "text-accent-amber" : undefined}>
              MCP {mcpCount}
              {mcpErrorCount > 0 ? ` (!${mcpErrorCount})` : ""}
            </span>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
