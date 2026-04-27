import { useEffect, useRef, useState } from "react";
import { GitBranch, Server, FolderOpen, ArrowDownToLine } from "lucide-react";
import { gitSafetyCheck, type GitSafetyReport } from "@/lib/tauri";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface AgentStatusBarProps {
  conversation: AgentConversation;
  onOpenWorkspace?: () => void;
}

const POLL_INTERVAL_MS = 30_000;

function basenameOf(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

export function AgentStatusBar({ conversation, onOpenWorkspace }: AgentStatusBarProps) {
  const projectLabels = useAgentTaskStore((s) => s.projectLabels);
  const [report, setReport] = useState<GitSafetyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const cancelled = useRef(false);

  const isSsh = !!conversation.sshTarget;
  const projectPath = conversation.projectPath;
  const customLabel = projectLabels[projectPath];
  const displayLabel = customLabel || basenameOf(projectPath) || "(no project)";

  useEffect(() => {
    cancelled.current = false;
    if (isSsh || !projectPath) {
      setReport(null);
      return undefined;
    }

    const run = async () => {
      setLoading(true);
      try {
        const next = await gitSafetyCheck(projectPath);
        if (!cancelled.current) setReport(next);
      } catch {
        if (!cancelled.current) setReport(null);
      } finally {
        if (!cancelled.current) setLoading(false);
      }
    };

    void run();
    const interval = window.setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(interval);
    };
  }, [projectPath, isSsh]);

  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t border-bg-border bg-bg-primary text-[10px] text-text-muted">
      {/* Left: project / workspace pill */}
      <button
        type="button"
        onClick={onOpenWorkspace}
        disabled={!onOpenWorkspace}
        className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors ${
          onOpenWorkspace
            ? "hover:bg-bg-hover hover:text-text-secondary cursor-pointer"
            : "cursor-default"
        }`}
        title={projectPath}
      >
        {isSsh ? (
          <Server size={10} className="text-accent-purple" />
        ) : (
          <FolderOpen size={10} className="text-text-muted" />
        )}
        <span className="truncate max-w-[180px]">{displayLabel}</span>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {isSsh && conversation.sshTarget && (
          <span className="flex items-center gap-1 font-mono">
            <Server size={10} className="text-accent-purple" />
            SSH · {conversation.sshTarget.host}
          </span>
        )}

        {!isSsh && report && report.isGitRepo && (
          <span className="flex items-center gap-1 font-mono">
            <GitBranch
              size={10}
              className={report.isClean ? "text-text-muted" : "text-accent-amber"}
            />
            <span className={report.isClean ? "text-text-muted" : "text-accent-amber"}>
              {report.branch ?? "?"}
            </span>
            {!report.isClean && (
              <span
                className="text-accent-amber"
                title={`${report.uncommittedCount} uncommitted change${
                  report.uncommittedCount === 1 ? "" : "s"
                }`}
              >
                ●
              </span>
            )}
            {report.behindUpstream > 0 && (
              <span
                className="flex items-center text-accent-amber"
                title={`${report.behindUpstream} behind upstream`}
              >
                <ArrowDownToLine size={9} />
                {report.behindUpstream}
              </span>
            )}
          </span>
        )}

        {!isSsh && !loading && report && !report.isGitRepo && (
          <span className="flex items-center gap-1 text-text-muted/70">
            <FolderOpen size={10} />
            not a git repo
          </span>
        )}

        {!isSsh && loading && !report && (
          <span className="text-text-muted/60 italic">...</span>
        )}
      </div>
    </div>
  );
}
