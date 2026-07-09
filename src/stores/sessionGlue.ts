/**
 * Tile program (P1-S2) — sessionGlue: the ONE bridge between the two engines.
 *
 * `agentTaskStore` (headless conversations) and `workspaceStore` (placement)
 * never import each other — an eslint `no-restricted-imports` rule enforces it.
 * All cross-engine wiring lives here:
 *
 *   (a) One-directional GC — deleting a conversation prunes its tiles; closing
 *       a tile NEVER touches the conversation.
 *   (b) Idempotent startup reconciliation sweep — self-heals a wrapper whose
 *       conversation pane was stripped by an old-binary re-save. No localStorage
 *       guard key: reconciliation IS the repair, so re-runs are safe no-ops.
 *   (c) `openSession(ref)` — idempotently materialize a conversation's wrapper
 *       workspace (deterministic id `ws-wrap-<convId>`, `origin:"conversation"`)
 *       and activate it.
 *
 * This sprint dark-ships: the mechanisms + their tests land now, full sidebar
 * consumption arrives in Phase 4 (which wires {@link initSessionGlue} into the
 * app shell AFTER `hydrateConversations` resolves — P1 blast radius forbids
 * touching the bootstrap here).
 */
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore, conversationWrapperId } from "@/stores/workspaceStore";

// ─── (a) One-directional GC ─────────────────────────────────────────────────

/**
 * Subscribe to `agentTaskStore` and prune referencing panes whenever a
 * conversation disappears (deleteConversation / forkAndResend never delete, so
 * only a real removal fires this). Direction is strictly conversation→panes:
 * `workspaceStore.removeConversationPanes` touches no conversation, so closing a
 * tile can never delete a conversation.
 *
 * Returns the zustand unsubscribe fn. Idempotent installation is the caller's
 * concern ({@link initSessionGlue} installs exactly once).
 */
export function installConversationGc(): () => void {
  let previousIds = new Set(
    useAgentTaskStore.getState().conversations.map((c) => c.id),
  );
  return useAgentTaskStore.subscribe((state) => {
    const nextIds = new Set(state.conversations.map((c) => c.id));
    if (nextIds.size >= previousIds.size) {
      // No id could have been removed when the count didn't shrink — the common
      // streaming-update path exits here without scanning.
      let removedAny = false;
      for (const id of previousIds) {
        if (!nextIds.has(id)) {
          removedAny = true;
          break;
        }
      }
      if (!removedAny) {
        previousIds = nextIds;
        return;
      }
    }
    for (const id of previousIds) {
      if (!nextIds.has(id)) {
        useWorkspaceStore.getState().removeConversationPanes(id);
      }
    }
    previousIds = nextIds;
  });
}

// ─── (b) Reconciliation sweep ───────────────────────────────────────────────

/**
 * Self-heal orphaned conversation wrappers. When an old binary re-saves a
 * workspace it strips `kind`/`conversationId`, so `normalizePanes` degrades the
 * conversation pane to a plain terminal pane on the next load — leaving the
 * `origin:"conversation"` wrapper holding no conversation pane. This sweep
 * removes those ghost wrappers so their conversation cleanly re-surfaces as an
 * UNPLACED fleet row (via `sessionIndex`), with ZERO conversation-file mutation
 * — the conversation record is never touched, only the empty placement wrapper.
 *
 * Idempotent: a second run finds no orphaned wrappers and does nothing. There
 * is deliberately no persisted guard key — reconciliation is the repair, so
 * running it every startup is correct.
 */
export function runReconciliationSweep(): void {
  const orphanWrapperIds: string[] = [];
  for (const workspace of useWorkspaceStore.getState().workspaces) {
    if (workspace.origin !== "conversation") continue;
    const hasConversationPane = workspace.panes.some((p) => p.kind === "conversation");
    if (!hasConversationPane) orphanWrapperIds.push(workspace.id);
  }
  for (const id of orphanWrapperIds) {
    useWorkspaceStore.getState().deleteWorkspace(id);
  }
}

// ─── (c) openSession materializer ───────────────────────────────────────────

/** Reference handed to {@link openSession}. A conversation with no tile is a
 *  first-class citizen (the Remote Agents R0 shape); opening one materializes a
 *  wrapper on demand. */
export interface OpenSessionRef {
  conversationId: string;
}

/**
 * Idempotently materialize + activate the wrapper workspace for a conversation.
 * Called by the sidebar click, the needs-you click, and the retirement redirect
 * shim (Phase 4/5). Deterministic id `ws-wrap-<convId>` means calling twice
 * yields exactly one workspace. The title seeds from the conversation's
 * auto-title (live-follow-until-first-rename is a Phase 4 concern).
 *
 * Returns the wrapper workspace id.
 */
export function openSession(ref: OpenSessionRef): string {
  const { conversationId } = ref;
  const conversation = useAgentTaskStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  const workspaceId = useWorkspaceStore.getState().ensureConversationWorkspace({
    conversationId,
    name: conversation?.title ?? conversationId,
    projectPath: conversation?.projectPath ?? "",
  });
  useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
  return workspaceId;
}

/** Re-export so consumers/tests can assert the deterministic wrapper id without
 *  reaching into workspaceStore internals. */
export { conversationWrapperId };

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let gcUnsubscribe: (() => void) | null = null;

/**
 * Install the GC subscription (once) and run the reconciliation sweep. The
 * caller (Phase 4 app shell) invokes this AFTER `hydrateConversations` resolves
 * so the sweep sees the fully-hydrated workspace + conversation state. Safe to
 * call more than once — the GC subscription is not duplicated.
 */
export function initSessionGlue(): void {
  if (!gcUnsubscribe) gcUnsubscribe = installConversationGc();
  runReconciliationSweep();
}

/** Tear down the GC subscription (test cleanup / hot-reload). */
export function teardownSessionGlue(): void {
  if (gcUnsubscribe) {
    gcUnsubscribe();
    gcUnsubscribe = null;
  }
}
