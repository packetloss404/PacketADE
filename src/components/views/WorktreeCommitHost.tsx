import { useEffect } from "react";
import { X } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { deriveLegacyWorktree } from "@/stores/agentConversationPersistence";
import { useFinishCommitHost } from "@/stores/finishCommitHostStore";
import { GitDashboard } from "@/components/workspace/GitDashboard";

/**
 * DISPOSABLE (P2-S3) — delete in P5-S2. A single self-contained modal host that
 * makes the endings loop reachable from the TODAY Agents tab: it opens
 * {@link GitDashboard} against the selected conversation's worktree, which
 * mounts the four-action {@link WorktreeLifecycleBar}. Opened by the ReviewBar
 * "Finish → Commit…" CTA via {@link useFinishCommitHost}.
 *
 * Priced throwaway (ruled): in Phase 3+ the CTA opens GitDashboard inside the
 * mosaic workspace instead, so this file and its trigger store are removed —
 * deletion is one import line in `AgentsView.tsx` plus the two files.
 */
export function WorktreeCommitHost() {
  const hostConversationId = useFinishCommitHost((s) => s.hostConversationId);
  const closeFinishCommit = useFinishCommitHost((s) => s.closeFinishCommit);
  const conversation = useAgentTaskStore((s) =>
    hostConversationId ? s.conversations.find((c) => c.id === hostConversationId) : undefined,
  );

  // Escape closes the host.
  useEffect(() => {
    if (!hostConversationId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFinishCommit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hostConversationId, closeFinishCommit]);

  if (!hostConversationId || !conversation) return null;

  const worktree = conversation.worktree ?? deriveLegacyWorktree(conversation);
  const projectPath = worktree?.worktreePath ?? conversation.projectPath;
  const serverId = conversation.sshTarget?.id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={closeFinishCommit}
    >
      <div
        className="flex h-[80vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-lg border border-bg-border bg-bg-primary shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-2">
          <span className="truncate text-ui font-medium text-text-primary">
            Finish · {conversation.title}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={closeFinishCommit}
            className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <GitDashboard
            projectPath={projectPath}
            conversationId={conversation.id}
            serverId={serverId}
          />
        </div>
      </div>
    </div>
  );
}
