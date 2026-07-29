import { create } from "zustand";
import {
  respondPermission as tauriRespondPermission,
  respondEdit as tauriRespondEdit,
  cancelPendingTools as tauriCancelPendingTools,
} from "@/lib/tauri";
import type {
  PendingPermission,
  PendingEdit,
} from "@/types/agent-conversation";
import {
  auditSourceChain,
  useProvenanceAuditStore,
} from "@/stores/provenanceAuditStore";

export const EMPTY_PENDING_PERMISSIONS: PendingPermission[] = [];
export const EMPTY_PENDING_EDITS: PendingEdit[] = [];

/**
 * Approval-queue substore split out of agentTaskStore. Owns the ephemeral
 * permission / write-edit prompt queues that wake up the per-conversation
 * `PendingApprovalsSection`. Not persisted — the backend re-emits queued
 * prompts when a session resumes, and a cold-start session has no live
 * prompts anyway.
 *
 * `appendAllowedToolPattern` stays on agentTaskStore because it mutates a
 * persisted conversation field (`allowedTools`); the smart-approval row
 * calls it directly after `respondPermission` resolves.
 */

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
    /** P1-9 deny-and-continue: optional user guidance forwarded with a
     * "deny" so the model is steered ("don't touch prod — use the staging
     * config") instead of stalled on a bare refusal. */
    reason?: string,
  ) => Promise<void>;
  /** P1-9 tiered gating: answer a permission request `allow_once` WITHOUT
   * it ever entering the prompt queue. Called by the permission-request
   * listener for read/search tools and in-project edits under Default mode
   * — no queue bookkeeping, no task wake-up, no notification. */
  autoAllowPermission: (conversationId: string, toolId: string) => Promise<void>;
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
  },

  addPendingEdit: (conversationId, edit) => {
    set((s) => {
      const next = new Map(s.edits);
      const existing = next.get(conversationId) ?? [];
      next.set(conversationId, [...existing, edit]);
      return { edits: next };
    });
  },

  respondPermission: async (conversationId, toolId, decision, reason) => {
    const pending = get().permissions.get(conversationId) ?? [];
    const match = pending.find((permission) => permission.id === toolId);
    await tauriRespondPermission(conversationId, toolId, decision, reason);
    if (match) {
      useProvenanceAuditStore.getState().record({
        conversationId,
        toolId,
        action: match.name,
        target: match.safeTarget,
        decision:
          decision === "allow_once"
            ? "user_allowed_once"
            : decision === "allow_always"
              ? "user_allowed_session"
              : "user_denied",
        effectivePolicy: match.effectivePolicy ?? "explicit approval",
        sourceChain: auditSourceChain(match.sourceChain ?? []),
      });
    }
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
  },

  autoAllowPermission: async (conversationId, toolId) => {
    try {
      await tauriRespondPermission(conversationId, toolId, "allow_once");
    } catch (e) {
      console.warn("autoAllowPermission failed:", e);
    }
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
  },

  cancelPendingTools: async (conversationId) => {
    const pending = get().permissions.get(conversationId) ?? [];
    for (const permission of pending) {
      useProvenanceAuditStore.getState().record({
        conversationId,
        toolId: permission.id,
        action: permission.name,
        target: permission.safeTarget,
        decision: "cancelled",
        effectivePolicy: permission.effectivePolicy ?? "explicit approval",
        sourceChain: auditSourceChain(permission.sourceChain ?? []),
      });
    }
    // Optimistic clear — backend has no echo event.
    set((s) => {
      const nextPerms = new Map(s.permissions);
      const nextEdits = new Map(s.edits);
      nextPerms.delete(conversationId);
      nextEdits.delete(conversationId);
      return { permissions: nextPerms, edits: nextEdits };
    });
    try {
      await tauriCancelPendingTools(conversationId);
    } catch (e) {
      console.warn("cancelPendingTools failed:", e);
    }
  },

  getPendingForConversation: (conversationId) => ({
    permissions: get().permissions.get(conversationId) ?? EMPTY_PENDING_PERMISSIONS,
    edits: get().edits.get(conversationId) ?? EMPTY_PENDING_EDITS,
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
  },
}));
