/**
 * The ONE delete confirm for an agent conversation — shared by AgentSidebar and
 * FleetSidebar so the two surfaces cannot drift on what deletion costs.
 *
 * Deleting a conversation discards the worktree it ran in (directory + `pkt/<id>`
 * branch). That consequence is disclosed here, before the destructive click:
 * the dialog names the worktree path and branch, and states first and loudest
 * whether the tree has UNCOMMITTED CHANGES. The dirty-check is asynchronous, so
 * the callout opens with a "checking…" line and settles into the real facts —
 * it never renders a reassuring "clean" it hasn't verified.
 *
 * Cancel / Esc / X back out with zero mutation: the store is only touched from
 * the confirm button.
 */
import { useEffect, useState } from "react";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { useToast } from "@/components/ui/Toast";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  conversationWorktree,
  inspectConversationWorktree,
  worktreeDeleteConfirmLabel,
  worktreeDeleteWarnings,
  WORKTREE_CHECK_PENDING_WARNING,
  WORKTREE_DISCARD_WARNING_TITLE,
  type ConversationWorktreeDisclosure,
} from "@/lib/conversationWorktreeDisclosure";

interface ConfirmDeleteConversationModalProps {
  conversationId: string;
  /** Row title as the user sees it; falls back to "(untitled)". */
  title?: string;
  /** Called after confirm or cancel — the host clears its pending state. */
  onClose: () => void;
}

type Check =
  | { status: "none" }
  | { status: "checking" }
  | { status: "ready"; disclosure: ConversationWorktreeDisclosure | null };

export function ConfirmDeleteConversationModal({
  conversationId,
  title,
  onClose,
}: ConfirmDeleteConversationModalProps) {
  const deleteConversation = useAgentTaskStore((s) => s.deleteConversation);
  const toast = useToast();
  const [check, setCheck] = useState<Check>({ status: "none" });

  // Read the conversation imperatively: this must not re-run on every streaming
  // frame, only when the dialog targets a different conversation.
  useEffect(() => {
    const conv = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === conversationId);
    if (!conv || !conversationWorktree(conv)) {
      setCheck({ status: "none" });
      return;
    }
    setCheck({ status: "checking" });
    let cancelled = false;
    void inspectConversationWorktree(conv).then((disclosure) => {
      if (!cancelled) setCheck({ status: "ready", disclosure });
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const disclosure = check.status === "ready" ? check.disclosure : null;
  const warnings =
    check.status === "checking"
      ? [WORKTREE_CHECK_PENDING_WARNING]
      : worktreeDeleteWarnings(disclosure);

  const handleConfirm = () => {
    const cleanup = deleteConversation(conversationId);
    onClose();
    // The delete already happened; this only reports a cleanup that didn't.
    void cleanup.then((outcome) => {
      if (outcome && !outcome.discarded) {
        toast.error(
          `Conversation deleted, but its worktree could not be discarded: ${outcome.worktreePath}. Remove it manually.`,
        );
      }
    });
  };

  return (
    <ConfirmDeleteModal
      title="Delete conversation?"
      entityName={title || "(untitled)"}
      description="will be closed and its history removed."
      warnings={warnings}
      warningTitle={WORKTREE_DISCARD_WARNING_TITLE}
      confirmLabel={worktreeDeleteConfirmLabel(disclosure)}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
