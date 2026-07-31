/**
 * Delete-time worktree disclosure for Agents conversations.
 *
 * Deleting a conversation DISCARDS the worktree it ran in — the directory is
 * removed and its `pkt/<id>` branch is force-deleted (owner decision, 2026-07-30:
 * "Discard, surface the confirm"). Before this module the delete confirm said
 * nothing about it, so a confirmed delete silently destroyed a checkout — and,
 * when the tree was dirty, unrecoverable uncommitted work.
 *
 * The rule this module encodes: the confirm NAMES the worktree path and branch,
 * and states — separately and first — whether the tree has uncommitted changes.
 * Nothing here mutates anything; it only gathers the facts the confirm quotes.
 * The discard itself lives in `agentTaskStore.deleteConversation`.
 */
import { getGitStatus } from "@/lib/tauri";
import { deriveLegacyWorktree, isWorktreeDirty } from "@/lib/worktreeLifecycle";
import type { AgentConversation } from "@/types/agent-conversation";

/** The local worktree a conversation owns, resolved through the legacy
 *  provenance derivation. */
export interface ConversationWorktreeRef {
  basePath: string;
  worktreePath: string;
  branch: string;
}

/** `ConversationWorktreeRef` plus the dirty-check result. */
export interface ConversationWorktreeDisclosure extends ConversationWorktreeRef {
  /** The worktree has uncommitted changes — discarding loses them for good. */
  dirty: boolean;
  /** The dirty-check itself failed (git unavailable, path gone). Treated as
   *  "may be dirty" so the confirm never under-states the loss. */
  dirtyUnknown: boolean;
}

/**
 * The LOCAL worktree a delete would discard, or `null` when there is nothing to
 * discard: a conversation that ran in the project root, an SSH conversation
 * (its worktree lives on the remote host and this app does not own it), or a
 * worktree already discarded through the lifecycle bar.
 *
 * Single source of truth for "does this delete touch a worktree?" — the confirm
 * and the store's fan-out both key off it, so a warning can never disagree with
 * what deletion actually does.
 */
export function conversationWorktree(conv: AgentConversation): ConversationWorktreeRef | null {
  if (conv.sshTarget) return null;
  const wt = conv.worktree ?? deriveLegacyWorktree(conv);
  if (!wt) return null;
  if (wt.state === "discarded") return null; // already gone
  return { basePath: wt.basePath, worktreePath: wt.worktreePath, branch: wt.branch };
}

/**
 * Resolve the worktree AND ask git whether it is dirty. Returns `null` when
 * there is no local worktree. A failed dirty-check resolves with
 * `dirty: true, dirtyUnknown: true` rather than rejecting — an unknown tree is
 * disclosed as possibly-dirty, never as clean.
 */
export async function inspectConversationWorktree(
  conv: AgentConversation,
): Promise<ConversationWorktreeDisclosure | null> {
  const wt = conversationWorktree(conv);
  if (!wt) return null;
  try {
    return { ...wt, dirty: isWorktreeDirty(await getGitStatus(wt.worktreePath)), dirtyUnknown: false };
  } catch (e) {
    console.warn("inspectConversationWorktree: dirty-check failed for", conv.id, e);
    return { ...wt, dirty: true, dirtyUnknown: true };
  }
}

/** Shown while the dirty-check is still in flight — the confirm discloses that
 *  a worktree is involved before it knows whether the tree is dirty. */
export const WORKTREE_CHECK_PENDING_WARNING =
  "Checking this conversation's worktree for uncommitted changes…";

/** Heading for the delete confirm's amber callout. */
export const WORKTREE_DISCARD_WARNING_TITLE = "Deleting also discards this conversation's worktree";

/**
 * The exact lines the delete confirm shows. Dirtiness comes FIRST because it is
 * the only unrecoverable consequence; the path and branch follow so the user can
 * go rescue the work if they'd rather not lose it. `null` (no worktree) yields
 * an empty array — a root-run conversation shows no spurious warning.
 */
export function worktreeDeleteWarnings(
  disclosure: ConversationWorktreeDisclosure | null,
): string[] {
  if (!disclosure) return [];
  const first = disclosure.dirtyUnknown
    ? "Could not check for uncommitted changes — assume unsaved work in this worktree will be lost."
    : disclosure.dirty
      ? "This worktree has UNCOMMITTED CHANGES. They will be permanently lost."
      : "No uncommitted changes, but any commits on this branch that were never merged are lost.";
  return [
    first,
    `Worktree ${disclosure.worktreePath} will be deleted from disk.`,
    `Branch ${disclosure.branch} will be force-deleted.`,
  ];
}

/** Confirm-button label. Escalates when work is (or may be) at risk so the
 *  destructive click itself names what it destroys. */
export function worktreeDeleteConfirmLabel(
  disclosure: ConversationWorktreeDisclosure | null,
): string {
  if (!disclosure) return "Delete";
  if (disclosure.dirty || disclosure.dirtyUnknown) return "Delete and discard changes";
  return "Delete and discard worktree";
}
