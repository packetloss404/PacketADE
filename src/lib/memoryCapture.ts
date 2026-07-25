// M4 — "+ Add to memory" payload builders.
//
// The memory store's `captureManually({ projectPath, source, summary, body,
// tags })` action is the generic manual-capture affordance (first used by the
// GitHub InvestigationPanel). These pure builders shape that input for two more
// surfaces — the flight coordination timeline and the agent transcript — so the
// UI stays thin glue and the payload logic is unit-testable.

import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import type { CoordinationEvent, Flight } from "@/types/flight";

export interface ManualCaptureInput {
  projectPath: string;
  source: string;
  summary: string;
  body: string;
  tags: string[];
}

/** Trim to a single, length-bounded summary line. */
function summaryLine(text: string, max = 120): string {
  const first = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** M4: build a capture payload from a flight coordination-timeline event. */
export function buildCoordinationMemoryInput(
  event: CoordinationEvent,
  flight: Flight,
): ManualCaptureInput {
  const actor = event.agentId || "system";
  return {
    projectPath: flight.projectPath,
    source: "flight-coordination",
    summary: summaryLine(`${flight.title}: ${event.summary}`),
    body: [
      `Flight: ${flight.title}`,
      `Event: ${event.type}${event.taskTitle ? ` — ${event.taskTitle}` : ""}`,
      `Actor: ${actor}`,
      "",
      event.summary,
    ].join("\n"),
    tags: ["flight-coordination", event.type, `flight-${flight.id}`],
  };
}

/** M4: build a capture payload from a single assistant transcript message. */
export function buildTranscriptMemoryInput(
  message: AgentMessage,
  conversation: AgentConversation,
): ManualCaptureInput {
  return {
    projectPath: conversation.projectPath,
    source: "agent-transcript",
    summary: summaryLine(message.content) || conversation.title || "Agent note",
    body: message.content,
    tags: ["agent-transcript", conversation.agent],
  };
}
