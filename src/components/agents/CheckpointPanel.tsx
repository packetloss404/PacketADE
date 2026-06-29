import { useCallback, useEffect, useState } from "react";
import {
  X,
  RotateCcw,
  GitBranch,
  Save,
  Loader2,
  AlertTriangle,
  History,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { Modal } from "@/components/ui/Modal";
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
 * Lists checkpoint snapshots for the current conversation. Checkpoints only
 * store messages today; code rollback needs a future git-worktree path.
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
  const [error, setError] = useState<string | null>(null);
  // Checkpoint pending a destructive-restore confirmation.
  const [confirmRestore, setConfirmRestore] = useState<Checkpoint | null>(null);

  const canFork = Boolean(
    conversation && conversation.mode === "api" && conversation.model,
  );

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
      setError(
        `Failed to load checkpoints: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function handleSaveNow() {
    setSavingNow(true);
    setError(null);
    try {
      await useAgentTaskStore.getState().saveCheckpoint(conversationId);
      await refetch();
    } catch (err) {
      console.warn("Failed to save checkpoint:", err);
      setError(
        `Failed to save checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  async function handleRestoreConvOnly(cp: Checkpoint) {
    setBusyAction(`conv-${cp.id}`);
    setError(null);
    try {
      restoreMessages(cp);
      onClose();
    } catch (err) {
      console.warn("Failed to restore checkpoint:", err);
      setError(
        `Failed to restore conversation: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    setError(null);
    try {
      const store = useAgentTaskStore.getState();
      const newId = await store.createApiConversation(
        conversation.agent,
        conversation.projectPath,
        conversation.model,
        "",
        conversation.systemPromptOverride ?? null,
        undefined,
        undefined,
        null,
        undefined,
        false,
        conversation.allowedTools ?? null,
        conversation.memoryContextEnabled ?? false,
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
      setError(
        `Failed to fork from checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      );
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
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] font-medium text-accent-green bg-accent-green/20 hover:bg-accent-green/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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

      {/* Messages-only scope notice */}
      <div className="flex items-start gap-1.5 px-3 py-1.5 border-b border-bg-border shrink-0 text-[10px] text-accent-amber bg-accent-amber/10">
        <AlertTriangle size={11} className="shrink-0 mt-px" />
        <span>
          Checkpoints restore conversation messages only — code changes aren't
          rolled back.
        </span>
      </div>

      {/* Error strip */}
      {error && (
        <div className="flex items-start gap-1.5 px-3 py-1.5 border-b border-bg-border shrink-0 text-[10px] text-accent-red bg-accent-red/10">
          <AlertTriangle size={11} className="shrink-0 mt-px" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-accent-red hover:text-text-primary transition-colors"
            aria-label="Dismiss error"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && checkpoints.length === 0 && (
          <div className="flex items-center justify-center h-24 text-[11px] text-text-muted gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Loading checkpoints...
          </div>
        )}

        {!loading && checkpoints.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 px-4 gap-2 text-text-muted">
            <History size={20} className="text-text-faint" />
            <span className="text-[11px] text-center">
              No checkpoints yet — click 'Save current state' to snapshot.
            </span>
          </div>
        )}

        <ul className="divide-y divide-bg-border">
          {checkpoints.map((cp) => {
            const convBusy = busyAction === `conv-${cp.id}`;
            const forkBusy = busyAction === `fork-${cp.id}`;
            const anyBusy = busyAction !== null;
            return (
              <li key={cp.id} className="px-3 py-2 hover:bg-bg-hover transition-colors">
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
                    onClick={() => setConfirmRestore(cp)}
                    disabled={anyBusy}
                    title="Restore only the conversation messages from this checkpoint (replaces current messages)"
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent-red border border-accent-red/30 hover:bg-accent-red/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {convBusy ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <RotateCcw size={10} />
                    )}
                    Restore conversation
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleFork(cp)}
                    disabled={anyBusy || !canFork}
                    title={
                      canFork
                        ? "Create a new conversation seeded from this checkpoint"
                        : "Fork is only available on API conversations with a model."
                    }
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent-amber border border-accent-amber/30 hover:bg-accent-amber/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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

      {confirmRestore && (
        <Modal
          onClose={() => setConfirmRestore(null)}
          title="Restore conversation?"
          icon={<RotateCcw size={14} className="text-accent-red" />}
          width="w-[420px]"
          closeOnEscape
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRestore(null)}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const cp = confirmRestore;
                  setConfirmRestore(null);
                  void handleRestoreConvOnly(cp);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent-red bg-accent-red/15 hover:bg-accent-red/25 border border-accent-red/30 rounded transition-colors"
              >
                <RotateCcw size={12} />
                Restore conversation
              </button>
            </div>
          }
        >
          <div className="px-5 py-4 text-xs text-text-secondary leading-relaxed">
            This replaces all current messages with the{" "}
            <span className="text-text-primary font-medium">
              {confirmRestore.messageCount} message
              {confirmRestore.messageCount === 1 ? "" : "s"}
            </span>{" "}
            snapshot from{" "}
            <span className="text-text-primary font-medium">
              {formatWhen(confirmRestore.createdAt)}
            </span>
            . This can't be undone.
          </div>
        </Modal>
      )}
    </div>
  );
}
