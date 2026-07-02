import { saveConversation, loadConversations } from "@/lib/tauri";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { getAgentAutoArchiveIdleMs } from "@/stores/agentSettingsStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { useAgentTaskStore } from "@/stores/agentTaskStore";

/** Build a serializable snapshot of a conversation for `saveConversation`.
 * Pulls plan state out of `agentPlanStore` so the persisted record
 * keeps its on-disk shape even though those fields no longer live on the
 * in-memory conversation object. Ephemeral substores (approval,
 * streaming) are intentionally omitted — they reset on hydration. */
function snapshotForPersist(conv: AgentConversation): AgentConversation {
  const plans = useAgentPlanStore.getState();
  return {
    ...conv,
    plan: plans.getPlan(conv.id),
    planApproved: plans.getPlanApproved(conv.id) || undefined,
  };
}

/** Debounced save: per-conversation timers so rapid streaming events coalesce. */
const SAVE_DEBOUNCE_MS = 500;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSave(conv: AgentConversation): void {
  if (conv.mode !== "api") return; // only persist API conversations
  const existing = saveTimers.get(conv.id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    saveTimers.delete(conv.id);
    saveConversation(conv.id, JSON.stringify(snapshotForPersist(conv))).catch((e) => {
      console.warn("Failed to save conversation:", conv.id, e);
    });
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(conv.id, handle);
}

/** Cancel any pending debounced save for a conversation (used when the
 * conversation is deleted so a stale timer can't re-persist its file). */
export function cancelPendingSave(conversationId: string): void {
  const timer = saveTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(conversationId);
  }
}

/** Request a save for a conversation by id. Plan-store mutations call
 * this so plan/spec edits debounce-persist through the same path as
 * conversation mutations, without plan-store needing to import the full
 * agentTaskStore module at load time. */
export function requestConversationSave(conversationId: string): void {
  const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === conversationId);
  if (conv) scheduleSave(conv);
}

/** One-time pass over hydrated conversations: any conversation with
 * status === "done" that has been idle longer than the Agents settings
 * threshold and isn't already archived gets auto-archived. Mutates `conv` in
 * place and returns whether it changed (so callers can re-persist). */
function maybeAutoArchive(conv: AgentConversation): boolean {
  if (conv.archived) return false;
  if (conv.status !== "done") return false;
  const autoArchiveIdleMs = getAgentAutoArchiveIdleMs();
  if (autoArchiveIdleMs === null) return false;
  if (conv.updatedAt >= Date.now() - autoArchiveIdleMs) return false;
  conv.archived = true;
  return true;
}

/** Hydrate persisted API conversations on module load.
 * Reset runtime-only fields so we don't resume mid-stream after a cold start. */
export function hydrateConversations(): void {
  loadConversations()
    .then((rawList) => {
      const parsed: AgentConversation[] = [];
      for (const raw of rawList) {
        try {
          const conv = JSON.parse(raw) as AgentConversation;
          if (conv.mode !== "api") continue; // PTY sessions died with the app
          // Auto-archive long-idle done conversations BEFORE we coerce status to
          // "idle" below. Persist the change so the archive flag survives the
          // next cold start.
          if (maybeAutoArchive(conv)) {
            saveConversation(conv.id, JSON.stringify(conv)).catch((e) => {
              console.warn("Failed to persist auto-archive:", conv.id, e);
            });
          }
          conv.status = "idle";
          conv.messages = (conv.messages ?? []).map((m) => ({ ...m, isStreaming: false }));
          conv.queuedMessages = [];
          // Push persisted plan state into the plan substore — it is the
          // runtime source of truth. The conversation's own copies are kept
          // for back-compat with code that hasn't migrated yet but the live
          // UI reads from the store. (Legacy spec/specStage fields from the
          // retired Spec FSM are simply ignored on parse.)
          useAgentPlanStore.getState().hydrateConversation(conv.id, {
            plan: conv.plan,
            planApproved: conv.planApproved,
          });
          // Drop ephemeral fields so the in-memory record matches the new
          // substore-driven shape. These were already cleared pre-split.
          delete conv.pendingPermissions;
          delete conv.pendingEdits;
          delete conv.thinkingStream;
          delete conv.subAgentTokens;
          parsed.push(conv);
        } catch (e) {
          console.warn("Skipping malformed conversation:", e);
        }
      }
      if (parsed.length > 0) {
        useAgentTaskStore.setState((state) => ({
          conversations: [...parsed, ...state.conversations],
        }));
      }
    })
    .catch((e) => console.warn("Failed to hydrate conversations:", e));
}
