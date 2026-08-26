import type { PacketAgentDeploymentProjection } from "@/types/packet-agent";

/** PH6: one observed worker event, already unwrapped from either the SSE
 * frame payload or an events-page row. */
export interface ObservedPacketAgentEvent {
  eventId?: string;
  type: string;
  data: Record<string, unknown>;
}

export const PACKET_AGENT_TERMINAL_STATES = [
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
] as const;

export type PacketAgentTerminalState = (typeof PACKET_AGENT_TERMINAL_STATES)[number];

/** Canonical token form: lowercase with every separator collapsed to `_`,
 * so `worker.run.approval_required` (normalized) and raw journal spellings
 * like `run.approval-required` compare equal. */
function canonical(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** True for events that require a human decision — normalized
 * `worker.run.approval_required` / `worker.run.blocked` and their raw
 * journal spellings. */
export function isPacketAgentAttentionEvent(type: string): boolean {
  const token = canonical(type);
  return token.includes("approval_required") || token.includes("blocked");
}

/** Terminal run state carried by the event type, when there is one. */
export function packetAgentTerminalState(type: string): PacketAgentTerminalState | undefined {
  const token = canonical(type);
  if (token.includes("budget_exhausted")) return "budget_exhausted";
  if (token.includes("completed")) return "completed";
  if (token.includes("cancelled") || token.includes("canceled")) return "cancelled";
  if (token.includes("failed")) return "failed";
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Pure event → projection mapping. Never advances the durable cursor — that
 * happens only when an explicit ack round-trip succeeds. Tolerates both
 * normalized event types (`worker.run.approval_required`) and raw journal
 * spellings (matching on canonical tokens).
 */
export function projectPacketAgentEvent(
  projection: PacketAgentDeploymentProjection,
  event: ObservedPacketAgentEvent,
): Partial<PacketAgentDeploymentProjection> {
  const token = canonical(event.type);
  const updates: Partial<PacketAgentDeploymentProjection> = {
    ...(event.eventId ? { lastEventId: event.eventId } : {}),
    lastEventType: event.type,
  };

  if (isPacketAgentAttentionEvent(event.type)) {
    updates.attentionCount = projection.attentionCount + 1;
  } else {
    const terminal = packetAgentTerminalState(event.type);
    if (terminal) {
      updates.status = terminal;
    } else if (token.includes("revoked")) {
      updates.status = "revoked";
    } else if (token.includes("paused")) {
      updates.status = "paused";
    } else if (token.includes("activated") || token.includes("resumed")) {
      updates.status = "active";
    } else if (token.includes("deployed")) {
      updates.status = "deployed";
    }
  }

  if (token.includes("checkpoint") || token.includes("progress")) {
    updates.checkpointCount = (projection.checkpointCount ?? 0) + 1;
  }

  const summary = record(event.data.summary);
  const absoluteCost =
    numberAt(event.data.totalCostUsd) ?? numberAt(summary?.totalCostUsd);
  if (absoluteCost !== undefined) {
    updates.totalCostUsd = absoluteCost;
  } else {
    const increment = numberAt(event.data.costUsd) ?? numberAt(summary?.costUsd);
    if (increment !== undefined) {
      updates.totalCostUsd = (projection.totalCostUsd ?? 0) + increment;
    }
  }

  if (event.eventId && record(event.data.evidence)?.available === true) {
    if (!projection.evidenceEventIds.includes(event.eventId)) {
      updates.evidenceEventIds = [...projection.evidenceEventIds, event.eventId];
    }
  }

  return updates;
}
