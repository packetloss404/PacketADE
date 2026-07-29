import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useFlightStore } from "@/stores/flightStore";
import {
  acknowledgeCoordinationMessage,
  postCoordinationMessage,
} from "@/stores/coordinationInboxStore";
import type {
  CoordinationEventType,
  CoordinationMessageKind,
  CoordinationRecipientKind,
} from "@/types/flight";
import { toolResultProvenance } from "@/lib/provenance";

/**
 * N3 Slice 2 — applies event-routed writes from the (read-mostly) MCP server.
 *
 * The Rust MCP server can't write persisted state directly: the frontend saves
 * flights wholesale from Zustand, so a direct Rust file write would be clobbered
 * by the next frontend save and be invisible to the UI. Instead a write tool
 * emits `mcp-server-write`, and this bridge applies it through the owning store
 * action — the sole writer of `state.v1.json` — which persists it.
 *
 * The only write today is `append_coordination_event` (the `append_handoff`
 * tool): an external agent posting an append-only, human-visible note to a
 * flight's coordination timeline. It changes no task or flight state.
 */

export interface McpWriteIntent {
  op: string;
  flightId: string;
  event: {
    type?: string;
    summary?: string;
    agentId?: string | null;
    kind?: string;
    recipientKind?: string;
    recipientId?: string | null;
    recipientLabel?: string | null;
    body?: string;
    dedupeKey?: string | null;
    messageId?: string;
    note?: string | null;
  };
}

const COORDINATION_EVENT_TYPES = new Set<CoordinationEventType>([
  "task_started",
  "task_completed",
  "task_failed",
  "handoff",
  "review_requested",
  "review_resolved",
  "collision_warning",
  "escalation",
]);
const MESSAGE_KINDS = new Set<CoordinationMessageKind>([
  "instruction",
  "question",
  "answer",
  "blocker",
  "finding",
  "handoff",
  "artifact",
]);
const RECIPIENT_KINDS = new Set<CoordinationRecipientKind>([
  "flight",
  "role",
  "task",
  "attempt",
  "session",
]);

/** Apply a single write intent. Exported for testing; guards against unknown
 *  ops and malformed payloads. Idempotency isn't needed — each MCP call is one
 *  distinct append. */
export function applyMcpWrite(intent: McpWriteIntent): void {
  const { op, flightId, event: payload } = intent;
  const mcpSource = toolResultProvenance({
    toolId: `mcp-write-${flightId}-${payload?.messageId ?? payload?.dedupeKey ?? op}`,
    name: `mcp__packetade__${op}`,
    content: payload?.body ?? payload?.summary ?? payload?.note ?? undefined,
  });
  if (op === "post_coordination_message") {
    if (
      !flightId ||
      !payload?.body ||
      !MESSAGE_KINDS.has(payload.kind as CoordinationMessageKind) ||
      !RECIPIENT_KINDS.has(payload.recipientKind as CoordinationRecipientKind)
    ) {
      return;
    }
    const actor = payload.agentId ? `mcp:${payload.agentId}` : "mcp";
    void postCoordinationMessage({
      flightId,
      kind: payload.kind as CoordinationMessageKind,
      sender: { kind: "agent", id: actor, displayName: actor },
      recipients: [
        {
          kind: payload.recipientKind as CoordinationRecipientKind,
          id: payload.recipientId ?? undefined,
          label: payload.recipientLabel ?? undefined,
        },
      ],
      body: payload.body,
      dedupeKey: payload.dedupeKey ?? undefined,
      provenance: [mcpSource],
    }).catch((error) => console.warn("MCP inbox write was not applied:", error));
    return;
  }
  if (op === "acknowledge_coordination_message") {
    if (!flightId || !payload?.messageId) return;
    const actor = payload.agentId ? `mcp:${payload.agentId}` : "mcp";
    acknowledgeCoordinationMessage(
      flightId,
      payload.messageId,
      { kind: "agent", id: actor, displayName: actor },
      payload.note ?? undefined,
    );
    return;
  }
  if (op !== "append_coordination_event") return;
  if (!flightId || !payload?.summary) return;

  // Trust only known event types; default to a handoff note.
  const type: CoordinationEventType = COORDINATION_EVENT_TYPES.has(
    payload.type as CoordinationEventType,
  )
    ? (payload.type as CoordinationEventType)
    : "handoff";

  // Namespace the actor so an external agent can't impersonate "you"/"system"
  // or a first-party agent in the timeline's actor label (FlightsView derives
  // the actor from agentId). MCP-sourced notes always read as `mcp:<id>`.
  const agentId = payload.agentId ? `mcp:${payload.agentId}` : "mcp";

  // No-ops if the flight was deleted between the server's validation and now.
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type,
    summary: payload.summary,
    agentId,
    metadata: { source: "mcp" },
    provenance: mcpSource,
  });
}

export function startMcpWriteBridge(): Promise<UnlistenFn> {
  return listen<McpWriteIntent>("mcp-server-write", (event) => applyMcpWrite(event.payload));
}
