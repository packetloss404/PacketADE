import {
  isPacketAgentAttentionEvent,
  packetAgentTerminalState,
  type ObservedPacketAgentEvent,
} from "@/lib/packetAgentProjection";
import type { PostCoordinationMessageInput } from "@/stores/coordinationInboxStore";
import type { CoordinationArtifactRef } from "@/types/flight";

/** PH9: deep-link target carried on every PacketAgent inbox message. */
export interface PacketAgentDeepLink {
  deploymentId: string;
  workerRunId?: string;
  attentionRequestId?: string;
}

const DEEP_LINK_PREFIX = "packetagent://worker-deployments/";

export function buildPacketAgentDeepLinkUri(link: PacketAgentDeepLink): string {
  const query = new URLSearchParams();
  if (link.workerRunId) query.set("workerRunId", link.workerRunId);
  if (link.attentionRequestId) query.set("attentionRequestId", link.attentionRequestId);
  const suffix = query.toString();
  return `${DEEP_LINK_PREFIX}${encodeURIComponent(link.deploymentId)}${suffix ? `?${suffix}` : ""}`;
}

export function parsePacketAgentDeepLink(uri: string | undefined): PacketAgentDeepLink | undefined {
  if (!uri?.startsWith(DEEP_LINK_PREFIX)) return undefined;
  const rest = uri.slice(DEEP_LINK_PREFIX.length);
  const [rawId, rawQuery] = rest.split("?", 2);
  if (!rawId) return undefined;
  const query = new URLSearchParams(rawQuery ?? "");
  return {
    deploymentId: decodeURIComponent(rawId),
    workerRunId: query.get("workerRunId") ?? undefined,
    attentionRequestId: query.get("attentionRequestId") ?? undefined,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * PH9: map one attention/terminal PacketAgent event onto a coordination-inbox
 * message. Returns undefined for every other event type (and for id-less
 * events, which cannot carry a stable dedupe key). The dedupe key is
 * `packetagent:{eventId}`, so replaying the same event posts exactly one
 * message.
 */
export function buildPacketAgentCoordinationMessage(args: {
  flightId: string;
  deploymentId: string;
  workerRunId?: string;
  event: ObservedPacketAgentEvent;
}): PostCoordinationMessageInput | undefined {
  const { flightId, deploymentId, event } = args;
  if (!event.eventId) return undefined;
  const attention = isPacketAgentAttentionEvent(event.type);
  const terminal = packetAgentTerminalState(event.type);
  if (!attention && !terminal) return undefined;

  const workerRunId = args.workerRunId ?? str(event.data.workerRunId);
  const attentionRequestId =
    str(event.data.attentionRequestId) ?? str(record(event.data.attention)?.id);
  const summary = str(event.data.summary) ?? str(record(event.data.attention)?.summary);

  let kind: PostCoordinationMessageInput["kind"];
  let body: string;
  if (attention) {
    kind = "blocker";
    body =
      `PacketAgent worker requests approval (${event.type}).` +
      (summary ? ` ${summary}` : "") +
      " Review it on the PacketAgent card.";
  } else if (terminal === "completed") {
    kind = "finding";
    body = `PacketAgent worker completed (${event.type}). Load and land its evidence from the PacketAgent card.`;
  } else {
    kind = "blocker";
    body = `PacketAgent worker ended without success: ${terminal} (${event.type}). Review the PacketAgent card.`;
  }

  const link: CoordinationArtifactRef = {
    id: `packetagent:link:${event.eventId}`,
    label: "PacketAgent deployment",
    uri: buildPacketAgentDeepLinkUri({ deploymentId, workerRunId, attentionRequestId }),
  };

  return {
    flightId,
    kind,
    sender: { kind: "system", id: "packetagent", displayName: "PacketAgent" },
    recipients: [{ kind: "flight" }],
    body,
    artifacts: [link],
    dedupeKey: `packetagent:${event.eventId}`,
  };
}
