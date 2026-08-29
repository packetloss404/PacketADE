// M4 — "+ Add to memory" payload builders.
//
// The memory store's `captureManually({ scope, source, summary, body, tags })`
// action is the generic manual-capture affordance (first used by the GitHub
// InvestigationPanel). These pure builders shape that input for two more
// surfaces — the flight coordination timeline and the agent transcript — so the
// UI stays thin glue and the payload logic is unit-testable.
//
// `scope` is a `MemoryBriefScope`, not a bare path: a capture taken from a
// remote agent transcript used to be stamped with the plain remote path, which
// no ssh scope will ever match — it was written and then immediately
// unreachable. `memoryStore.memoryWriteKey` turns the scope into the stored key.

import type { MemoryScopeInput, MemoryBriefScope } from "@/stores/memoryStore";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";
import type { CoordinationEvent, Flight } from "@/types/flight";

export interface ManualCaptureInput {
  scope: MemoryScopeInput;
  source: string;
  summary: string;
  body: string;
  tags: string[];
}

/**
 * The scope a conversation's memory belongs to. `sshTarget` is set exactly when
 * the conversation's tools execute on a remote host, and carries the
 * `ServerConfig` id, so this needs no store lookup and stays pure.
 */
export function conversationMemoryScope(conversation: AgentConversation): MemoryBriefScope {
  const ssh = conversation.sshTarget;
  if (ssh?.id) {
    return {
      kind: "ssh",
      projectPath: ssh.remotePath || conversation.projectPath,
      serverId: ssh.id,
      remotePath: ssh.remotePath || conversation.projectPath,
      workspaceId: null,
    };
  }
  return { kind: "local", projectPath: conversation.projectPath, workspaceId: null };
}

/** Trim to a single, length-bounded summary line. */
function summaryLine(text: string, max = 120): string {
  const first = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** M4: build a capture payload from a flight coordination-timeline event.
 *  `scope` is resolved by the caller (which can read the workspace store);
 *  omitting it files the capture against the flight's own local path. */
export function buildCoordinationMemoryInput(
  event: CoordinationEvent,
  flight: Flight,
  scope?: MemoryScopeInput,
): ManualCaptureInput {
  const actor = event.agentId || "system";
  return {
    scope: scope ?? { kind: "local", projectPath: flight.projectPath, workspaceId: null },
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
    scope: conversationMemoryScope(conversation),
    source: "agent-transcript",
    summary: summaryLine(message.content) || conversation.title || "Agent note",
    body: message.content,
    tags: ["agent-transcript", conversation.agent],
  };
}
