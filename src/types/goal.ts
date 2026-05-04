import type { AgentPlanItem } from "./agent-conversation";

export type GoalStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

/**
 * B5 — persistent goal envelope around a checklist that outlives any
 * single AgentConversation. Inspired by Codex CLI 0.128's persisted
 * `/goal` workflows. Goals can attach optionally to a Flight (mission)
 * and to a conversation; both bindings are loose (the conversation can
 * be closed without losing the goal).
 *
 * The goal's `checklist` is a snapshot — kept in sync with the bound
 * conversation's `plan` field via an effect in PlanPanel. When the
 * conversation is closed, the snapshot is what the user sees.
 */
export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  /** Optional binding to a Flight/Mission for grouping. */
  missionId?: string;
  /** Optional binding to the conversation that owns the live checklist. */
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
  /** v3 reserved: opaque token for resuming Codex's own /goal workflow
   * once we wire app-server transport (A6). Unused in v1. */
  lastResumeToken?: string;
  /** Snapshot of the bound conversation's plan; refreshed via
   * `syncChecklistFromConversation`. Falls back to the snapshot when
   * the conversation has been closed. */
  checklist?: AgentPlanItem[];
}
