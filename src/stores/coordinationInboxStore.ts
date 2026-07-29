import { generateId } from "@/lib/storage";
import { writePty } from "@/lib/tauri";
import { selectCooperativeTaskViews } from "@/lib/cooperativeFlight";
import { derivedArtifactProvenance } from "@/lib/provenance";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import type {
  CoordinationArtifactRef,
  CoordinationMessage,
  CoordinationMessageKind,
  CoordinationMessageParty,
  CoordinationMessageRecipient,
  Flight,
} from "@/types/flight";
import type { ProvenanceEnvelope } from "@/types/provenance";

export const INBOX_MAX_BODY = 16_384;
export const INBOX_MAX_ARTIFACTS = 8;
export const INBOX_MAX_FANOUT = 50;
export const INBOX_MAX_POSTS_PER_MINUTE = 60;

export interface PostCoordinationMessageInput {
  flightId: string;
  kind: CoordinationMessageKind;
  sender: CoordinationMessageParty;
  recipients: CoordinationMessageRecipient[];
  body: string;
  artifacts?: CoordinationArtifactRef[];
  replyToId?: string;
  dedupeKey?: string;
  hopCount?: number;
  provenance?: ProvenanceEnvelope[];
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function recipientKey(recipient: CoordinationMessageRecipient): string {
  return `${recipient.kind}:${recipient.id ?? ""}`;
}

export function expandCoordinationRecipients(
  flight: Flight,
  recipients: CoordinationMessageRecipient[],
): CoordinationMessageRecipient[] {
  const expanded: CoordinationMessageRecipient[] = [];
  for (const recipient of recipients) {
    if (recipient.kind !== "role") {
      expanded.push(recipient);
      continue;
    }
    for (const task of flight.milestones.flatMap((milestone) => milestone.tasks)) {
      if (task.role !== recipient.id) continue;
      expanded.push({ kind: "task", id: task.id, label: task.title });
    }
  }
  const deduped = new Map<string, CoordinationMessageRecipient>();
  for (const recipient of expanded) {
    const key = recipientKey(recipient);
    const previous = deduped.get(key);
    deduped.set(key, recipient.label || !previous ? recipient : previous);
  }
  const result = Array.from(deduped.values());
  if (result.length > INBOX_MAX_FANOUT) {
    throw new Error(`A steering message can target at most ${INBOX_MAX_FANOUT} recipients.`);
  }
  return result;
}

export function validateCoordinationMessageInput(
  flight: Flight,
  input: PostCoordinationMessageInput,
  now = Date.now(),
): CoordinationMessageRecipient[] {
  const body = input.body.trim();
  if (!body) throw new Error("Message body is required.");
  if (body.length > INBOX_MAX_BODY) {
    throw new Error(`Message body exceeds ${INBOX_MAX_BODY} characters.`);
  }
  if ((input.artifacts?.length ?? 0) > INBOX_MAX_ARTIFACTS) {
    throw new Error(`A message can include at most ${INBOX_MAX_ARTIFACTS} artifacts.`);
  }
  if ((input.hopCount ?? 0) < 0 || (input.hopCount ?? 0) > 8) {
    throw new Error("Message hop count is outside the allowed range.");
  }
  const recent = (flight.coordinationInbox ?? []).filter(
    (message) =>
      message.sender.kind === input.sender.kind &&
      message.sender.id === input.sender.id &&
      message.createdAt >= now - 60_000,
  );
  if (recent.length >= INBOX_MAX_POSTS_PER_MINUTE) {
    throw new Error("Coordination inbox rate limit reached. Try again in a minute.");
  }
  const recipients = expandCoordinationRecipients(flight, input.recipients);
  if (recipients.length === 0) throw new Error("The selected recipient has no destinations.");
  for (const recipient of recipients) {
    if (recipient.kind !== "flight" && !recipient.id?.trim()) {
      throw new Error(`${recipient.kind} recipients require an id.`);
    }
  }
  return recipients;
}

function patchInboxMessage(
  flightId: string,
  messageId: string,
  patch: Partial<CoordinationMessage>,
): void {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  if (!flight) return;
  useFlightStore.getState().updateFlight(flightId, {
    coordinationInbox: (flight.coordinationInbox ?? []).map((message) =>
      message.id === messageId ? { ...message, ...patch } : message,
    ),
  });
}

function conversationForRecipient(
  flight: Flight,
  recipient: CoordinationMessageRecipient,
): string | undefined {
  if (recipient.kind === "session") return recipient.id;
  if (recipient.kind === "attempt") {
    return flight.attempts?.find((attempt) => attempt.id === recipient.id)?.sessionId;
  }
  if (recipient.kind === "task") {
    const view = selectCooperativeTaskViews(flight).find(
      (candidate) => candidate.task.id === recipient.id,
    );
    return view?.attempt?.sessionId ?? view?.task.sessionId ?? undefined;
  }
  return undefined;
}

function formatDeliveredMessage(message: CoordinationMessage): string {
  return `[Flight coordination · ${message.kind} · ${message.sender.displayName}]\n${message.body}`;
}

async function deliverUserMessage(flight: Flight, message: CoordinationMessage): Promise<void> {
  const conversationId = conversationForRecipient(flight, message.recipient);
  if (!conversationId) {
    if (message.recipient.kind === "flight") {
      patchInboxMessage(flight.id, message.id, {
        status: "delivered",
        deliveredAt: Date.now(),
      });
    }
    return;
  }
  const conversation = useAgentTaskStore
    .getState()
    .conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation || conversation.mode !== "api") return;
  useAgentTaskStore.getState().sendMessage(conversationId, formatDeliveredMessage(message));
  patchInboxMessage(flight.id, message.id, {
    status: "delivered",
    deliveredAt: Date.now(),
    errorMessage: undefined,
  });
}

export async function postCoordinationMessage(
  input: PostCoordinationMessageInput,
): Promise<CoordinationMessage[]> {
  const flight = useFlightStore
    .getState()
    .flights.find((candidate) => candidate.id === input.flightId);
  if (!flight) throw new Error(`Flight '${input.flightId}' was not found.`);
  const now = Date.now();
  const recipients = validateCoordinationMessageInput(flight, input, now);
  const created: CoordinationMessage[] = [];
  for (const recipient of recipients) {
    const dedupeKey =
      input.dedupeKey ??
      fingerprint(
        `${input.sender.kind}:${input.sender.id ?? ""}:${recipientKey(recipient)}:${input.kind}:${input.body.trim()}`,
      );
    const existing = (flight.coordinationInbox ?? []).find(
      (message) =>
        message.dedupeKey === dedupeKey &&
        recipientKey(message.recipient) === recipientKey(recipient) &&
        message.createdAt >= now - 300_000 &&
        message.status !== "archived",
    );
    if (existing) {
      created.push(existing);
      continue;
    }
    const id = generateId("inbox");
    created.push({
      schemaVersion: 1,
      id,
      flightId: flight.id,
      kind: input.kind,
      sender: input.sender,
      recipient,
      body: input.body.trim(),
      artifacts: input.artifacts ?? [],
      status: "queued",
      createdAt: now,
      acknowledgements: [],
      replyToId: input.replyToId,
      dedupeKey,
      hopCount: input.hopCount ?? 0,
      provenance: derivedArtifactProvenance(
        id,
        `Flight coordination message · ${input.kind}`,
        input.provenance ?? [],
        now,
      ),
    });
  }
  const newMessages = created.filter(
    (message) => !(flight.coordinationInbox ?? []).some((existing) => existing.id === message.id),
  );
  if (newMessages.length > 0) {
    useFlightStore.getState().updateFlight(flight.id, {
      coordinationInbox: [...(flight.coordinationInbox ?? []), ...newMessages],
    });
    for (const message of newMessages) {
      useFlightStore.getState().appendCoordinationEvent(flight.id, {
        type: message.kind === "blocker" ? "escalation" : "handoff",
        taskId: message.recipient.kind === "task" ? message.recipient.id : undefined,
        agentId: message.sender.id,
        summary: `${message.sender.displayName} posted a ${message.kind} to ${message.recipient.label ?? recipientKey(message.recipient)}.`,
        metadata: { inboxMessageId: message.id, inboxStatus: message.status },
        provenance: message.provenance,
      });
    }
  }
  if (input.sender.kind === "user") {
    const current =
      useFlightStore.getState().flights.find((candidate) => candidate.id === flight.id) ?? flight;
    for (const message of newMessages) await deliverUserMessage(current, message);
  }
  return created;
}

export function acknowledgeCoordinationMessage(
  flightId: string,
  messageId: string,
  by: CoordinationMessageParty,
  note?: string,
): void {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  const message = flight?.coordinationInbox?.find((candidate) => candidate.id === messageId);
  if (!message) return;
  if (
    message.acknowledgements.some(
      (acknowledgement) => acknowledgement.by.kind === by.kind && acknowledgement.by.id === by.id,
    )
  ) {
    return;
  }
  patchInboxMessage(flightId, messageId, {
    status: "acknowledged",
    acknowledgements: [
      ...message.acknowledgements,
      { by, at: Date.now(), note: note?.trim() || undefined },
    ],
  });
}

export function failCoordinationMessage(
  flightId: string,
  messageId: string,
  errorMessage: string,
): void {
  patchInboxMessage(flightId, messageId, {
    status: "failed",
    errorMessage: errorMessage.slice(0, 2_000),
  });
}

export async function retryCoordinationMessage(flightId: string, messageId: string): Promise<void> {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  const message = flight?.coordinationInbox?.find((candidate) => candidate.id === messageId);
  if (!flight || !message || message.status !== "failed") return;
  patchInboxMessage(flightId, messageId, {
    status: "queued",
    errorMessage: undefined,
  });
  if (message.sender.kind === "user") await deliverUserMessage(flight, message);
}

export function archiveCoordinationMessage(flightId: string, messageId: string): void {
  patchInboxMessage(flightId, messageId, { status: "archived" });
}

/** Explicit PTY fallback. This is called only from the visible Send to Terminal
 * button; inbox posting itself never injects keystrokes into a terminal. */
export async function sendCoordinationMessageToTerminal(
  flightId: string,
  messageId: string,
): Promise<void> {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  const message = flight?.coordinationInbox?.find((candidate) => candidate.id === messageId);
  if (!flight || !message) return;
  const sessionId = conversationForRecipient(flight, message.recipient);
  if (!sessionId) throw new Error("This message does not resolve to a terminal session.");
  await writePty(sessionId, `${formatDeliveredMessage(message)}\r`);
  patchInboxMessage(flightId, messageId, {
    status: "delivered",
    deliveredAt: Date.now(),
    errorMessage: undefined,
  });
}
