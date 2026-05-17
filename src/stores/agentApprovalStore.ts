import { create } from "zustand";
import {
  respondPermission as tauriRespondPermission,
  respondEdit as tauriRespondEdit,
  cancelPendingTools as tauriCancelPendingTools,
} from "@/lib/tauri";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useFlightStore } from "@/stores/flightStore";
import type {
  PendingPermission,
  PendingEdit,
} from "@/types/agent-conversation";

/**
 * Approval-queue substore split out of agentTaskStore. Owns the ephemeral
 * permission / write-edit prompt queues that wake up the Toolbar Bell and
 * the per-conversation `PendingApprovalsSection`. Not persisted — the
 * backend re-emits queued prompts when a session resumes, and a cold-
 * start session has no live prompts anyway.
 *
 * `appendAllowedToolPattern` stays on agentTaskStore because it mutates a
 * persisted conversation field (`allowedTools`); the smart-approval row
 * calls it directly after `respondPermission` resolves.
 */

function findTaskForConversation(
  conversationId: string,
): { taskId: string } | null {
  const hit = useFlightStore.getState().findTaskBySessionId(conversationId);
  return hit ? { taskId: hit.task.id } : null;
}

/**
 * Wakes the orchestrator's Review queue (`approval_needed`) when a new
 * permission / edit prompt arrives for a conversation that backs an
 * orchestrator Task. Idempotent — `notify_approval_needed` flips state, so
 * repeat firing is a no-op.
 */
function fireTaskApprovalNeeded(conversationId: string): void {
  const hit = findTaskForConversation(conversationId);
  if (!hit) return;
  void useOrchestrationStore
    .getState()
    .onTaskApprovalNeeded(hit.taskId)
    .catch((e) => console.warn("fireTaskApprovalNeeded failed:", e));
}

/**
 * Resolves the linked task approval when BOTH queues for a conversation
 * are empty. Called after every respond / cancel mutation.
 */
function maybeResolveTaskApproval(
  conversationId: string,
  state: { permissions: Map<string, PendingPermission[]>; edits: Map<string, PendingEdit[]> },
): void {
  const perms = state.permissions.get(conversationId) ?? [];
  const edits = state.edits.get(conversationId) ?? [];
  if (perms.length > 0 || edits.length > 0) return;
  const hit = findTaskForConversation(conversationId);
  if (!hit) return;
  void useOrchestrationStore
    .getState()
    .onTaskApprovalResolved(hit.taskId)
    .catch((e) => console.warn("maybeResolveTaskApproval failed:", e));
}

interface AgentApprovalState {
  /** Pending permission prompts awaiting user decision, keyed by conversationId. */
  permissions: Map<string, PendingPermission[]>;
  /** Pending write-file edits awaiting user decision, keyed by conversationId. */
  edits: Map<string, PendingEdit[]>;

  /** Called from agentTaskStore's `api-agent:permission-request` listener. */
  addPendingPermission: (
    conversationId: string,
    perm: PendingPermission,
  ) => void;
  /** Called from agentTaskStore's `api-agent:pending-edit` listener. */
  addPendingEdit: (conversationId: string, edit: PendingEdit) => void;

  respondPermission: (
    conversationId: string,
    toolId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => Promise<void>;
  respondEdit: (
    conversationId: string,
    toolId: string,
    decision: "apply" | "reject",
    mergedContent?: string,
  ) => Promise<void>;
  /** F8: drain every parked prompt as denied without killing the session. */
  cancelPendingTools: (conversationId: string) => Promise<void>;

  /** Selector helper used by UI components that want both queues for a
   * conversation in one read. */
  getPendingForConversation: (
    conversationId: string,
  ) => { permissions: PendingPermission[]; edits: PendingEdit[] };

  /** Wipe both queues for a conversation. Called when the conversation is
   * deleted, forked (M2.7), or restored from a checkpoint. */
  clearConversation: (conversationId: string) => void;
}

export const useAgentApprovalStore = create<AgentApprovalState>((set, get) => ({
  permissions: new Map(),
  edits: new Map(),

  addPendingPermission: (conversationId, perm) => {
    set((s) => {
      const next = new Map(s.permissions);
      const existing = next.get(conversationId) ?? [];
      next.set(conversationId, [...existing, perm]);
      return { permissions: next };
    });
    fireTaskApprovalNeeded(conversationId);
  },

  addPendingEdit: (conversationId, edit) => {
    set((s) => {
      const next = new Map(s.edits);
      const existing = next.get(conversationId) ?? [];
      next.set(conversationId, [...existing, edit]);
      return { edits: next };
    });
    // P0-1: pending-edit can fire WITHOUT a permission-request preceding it
    // (some providers fire only the edit prompt). Without this the Bell
    // badge / ReviewQueueView miss the wake-up. Idempotent.
    fireTaskApprovalNeeded(conversationId);
  },

  respondPermission: async (conversationId, toolId, decision) => {
    await tauriRespondPermission(conversationId, toolId, decision);
    set((s) => {
      const next = new Map(s.permissions);
      const existing = next.get(conversationId) ?? [];
      const match = existing.find((p) => p.id === toolId);
      if (!match) {
        console.warn(
          `[approval] no pending permission entry for toolId ${toolId} on ${conversationId}`,
        );
      }
      const filtered = existing.filter((p) => p.id !== toolId);
      if (filtered.length === 0) next.delete(conversationId);
      else next.set(conversationId, filtered);
      return { permissions: next };
    });
    maybeResolveTaskApproval(conversationId, get());
  },

  respondEdit: async (conversationId, toolId, decision, mergedContent) => {
    await tauriRespondEdit(conversationId, toolId, decision, mergedContent);
    set((s) => {
      const next = new Map(s.edits);
      const existing = next.get(conversationId) ?? [];
      const match = existing.find((p) => p.id === toolId);
      if (!match) {
        console.warn(
          `[approval] no pending edit entry for toolId ${toolId} on ${conversationId}`,
        );
      }
      const filtered = existing.filter((p) => p.id !== toolId);
      if (filtered.length === 0) next.delete(conversationId);
      else next.set(conversationId, filtered);
      return { edits: next };
    });
    maybeResolveTaskApproval(conversationId, get());
  },

  cancelPendingTools: async (conversationId) => {
    // Optimistic clear — backend has no echo event.
    set((s) => {
      const nextPerms = new Map(s.permissions);
      const nextEdits = new Map(s.edits);
      nextPerms.delete(conversationId);
      nextEdits.delete(conversationId);
      return { permissions: nextPerms, edits: nextEdits };
    });
    maybeResolveTaskApproval(conversationId, get());
    try {
      await tauriCancelPendingTools(conversationId);
    } catch (e) {
      console.warn("cancelPendingTools failed:", e);
    }
  },

  getPendingForConversation: (conversationId) => ({
    permissions: get().permissions.get(conversationId) ?? [],
    edits: get().edits.get(conversationId) ?? [],
  }),

  clearConversation: (conversationId) => {
    set((s) => {
      const nextPerms = new Map(s.permissions);
      const nextEdits = new Map(s.edits);
      const hadPerms = nextPerms.has(conversationId);
      const hadEdits = nextEdits.has(conversationId);
      if (!hadPerms && !hadEdits) return s;
      nextPerms.delete(conversationId);
      nextEdits.delete(conversationId);
      return { permissions: nextPerms, edits: nextEdits };
    });
    // Best-effort resolve — if the conversation backed a task, clearing
    // its queues should release the Review queue's hold. Safe no-op when
    // there's no linked task.
    maybeResolveTaskApproval(conversationId, get());
  },
}));
