import { useCallback, useEffect, useState } from "react";
import { X, RotateCcw, GitBranch, Save, Loader2 } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { relativeTime } from "@/lib/time";
import type { AgentMessage } from "@/types/agent-conversation";

interface Checkpoint {
  id: string;
  createdAt: string;
  messageCount: number;
  messages: AgentMessage[];
}

interface CheckpointPanelProps {
  conversationId: string;
  onClose: () => void;
}

/**
 * Claude-Code-style rewind panel.
 *
 * Lists checkpoint snapshots for the current conversation with three actions
 * per row: restore code+conv (placeholder for git-worktree work), restore conv
 * only, and fork-from-here (creates a new conversation seeded with the
 * checkpoint's messages).
 */
export function CheckpointPanel({
  conversationId,
  onClose,
}: CheckpointPanelProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingNow, setSavingNow] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const list = await useAgentTaskStore
        .getState()
        .listCheckpoints(conversationId);
      // Newest first — backend ordering not guaranteed, sort defensively.
      const sorted = [...list].sort((a, b) => {
        const at = Date.parse(a.createdAt);
        const bt = Date.parse(b.createdAt);
        return (isNaN(bt) ? 0 : bt) - (isNaN(at) ? 0 : at);
      });
      setCheckpoints(sorted);
    } catch (err) {
      console.warn("Failed to list checkpoints:", err);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function handleSaveNow() {
    setSavingNow(true);
    try {
      await useAgentTaskStore.getState().saveCheckpoint(conversationId);
      await refetch();
    } catch (err) {
      console.warn("Failed to save checkpoint:", err);
    } finally {
      setSavingNow(false);
    }
  }

  function restoreMessages(cp: Checkpoint) {
    useAgentTaskStore
      .getState()
      .restoreCheckpoint(
        conversationId,
        JSON.stringify({ messages: cp.messages }),
      );
  }

  async function handleRestoreCodeAndConv(cp: Checkpoint) {
    setBusyAction(`code-${cp.id}`);
    try {
      // v1: only message restore. Code rollback is git-worktree territory.
      restoreMessages(cp);
      onClose();
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRestoreConvOnly(cp: Checkpoint) {
    setBusyAction(`conv-${cp.id}`);
    try {
      restoreMessages(cp);
      onClose();
    } finally {
      setBusyAction(null);
    }
  }

  async function handleFork(cp: Checkpoint) {
    if (!conversation || conversation.mode !== "api" || !conversation.model) {
      console.warn("Fork only supported on API conversations with a model.");
      return;
    }
    setBusyAction(`fork-${cp.id}`);
    try {
      const store = useAgentTaskStore.getState();
      const newId = await store.createApiConversation(
        conversation.agent,
        conversation.projectPath,
        conversation.model,
        "",
        conversation.systemPromptOverride ?? null,
      );
      // Seed the new conversation with the checkpoint's messages.
      useAgentTaskStore.setState((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === newId
            ? {
                ...c,
                messages: cp.messages.map((m) => ({ ...m })),
                updatedAt: Date.now(),
              }
            : c,
        ),
      }));
      store.selectConversation(newId);
      onClose();
    } catch (err) {
      console.warn("Failed to fork from checkpoint:", err);
    } finally {
      setBusyAction(null);
    }
  }

  function formatWhen(createdAt: string): string {
    const t = Date.parse(createdAt);
    if (isNaN(t)) return createdAt;
    return relativeTime(t);
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary border-l border-bg-border">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-bg-border shrink-0">
        <RotateCcw size={12} className="text-accent-blue" />
        <span className="text-[11px] font-medium text-text-primary">
          Rewind
        </span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
          title="Close"
        >
          <X size={12} />
        </button>
      </div>

      {/* Save current state */}
      <div className="px-3 py-2 border-b border-bg-border shrink-0">
        <button
          onClick={() => void handleSaveNow()}
          disabled={savingNow}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 border border-accent-green/30 rounded transition-colors disabled:opacity-50"
          title="Snapshot current conversation state"
        >
          {savingNow ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Save size={11} />
          )}
          Save current state
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && checkpoints.length === 0 && (
          <div className="flex items-center justify-center h-24 text-[11px] text-text-muted gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Loading checkpoints...
          </div>
        )}

        {!loading && checkpoints.length === 0 && (
          <div className="flex items-center justify-center h-24 px-4">
            <span className="text-[11px] text-text-muted text-center">
              No checkpoints yet — click 'Save current state' to snapshot.
            </span>
          </div>
        )}

        <ul className="divide-y divide-bg-border">
          {checkpoints.map((cp) => {
            const codeBusy = busyAction === `code-${cp.id}`;
            const convBusy = busyAction === `conv-${cp.id}`;
            const forkBusy = busyAction === `fork-${cp.id}`;
            const anyBusy = busyAction !== null;
            return (
              <li key={cp.id} className="px-3 py-2 hover:bg-bg-hover/40">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[11px] text-text-primary font-medium">
                    {formatWhen(cp.createdAt)}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    · {cp.messageCount} msg
                    {cp.messageCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleRestoreCodeAndConv(cp)}
                    disabled={anyBusy}
                    title="Code rollback coming next phase. Restores conversation messages only for now."
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-secondary border border-bg-border hover:border-accent-blue/40 hover:text-accent-blue rounded transition-colors disabled:opacity-50"
                  >
                    {codeBusy ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <RotateCcw size={10} />
                    )}
                    Restore code + conv
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRestoreConvOnly(cp)}
                    disabled={anyBusy}
                    title="Restore only the conversation messages from this checkpoint"
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent-green border border-accent-green/30 hover:bg-accent-green/10 rounded transition-colors disabled:opacity-50"
                  >
                    {convBusy ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <RotateCcw size={10} />
                    )}
                    Restore conv only
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleFork(cp)}
                    disabled={anyBusy}
                    title="Create a new conversation seeded from this checkpoint"
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent-amber border border-accent-amber/30 hover:bg-accent-amber/10 rounded transition-colors disabled:opacity-50"
                  >
                    {forkBusy ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <GitBranch size={10} />
                    )}
                    Fork from here
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
