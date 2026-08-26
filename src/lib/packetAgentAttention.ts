import type { PacketAgentAttentionRequest } from "@/types/packet-agent";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseOne(value: unknown): PacketAgentAttentionRequest | undefined {
  const row = record(value);
  const id = str(row?.id) ?? str(row?.attentionRequestId);
  if (!row || !id) return undefined;
  const operation = record(row.operation) ?? record(row.capability);
  const resources = Array.isArray(operation?.resources)
    ? operation.resources.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const verbs = operation?.verbs;
  const verb =
    str(operation?.verb) ??
    (Array.isArray(verbs)
      ? verbs.filter((entry): entry is string => typeof entry === "string").join("/") || undefined
      : str(verbs));
  return {
    id,
    workerDeploymentId: str(row.workerDeploymentId),
    workerRunId: str(row.workerRunId),
    status: str(row.status),
    summary: str(row.summary) ?? str(row.description) ?? str(row.reason),
    ...(operation
      ? {
          operation: {
            tool: str(operation.tool),
            verb,
            effect: str(operation.effect),
            ...(resources ? { resources } : {}),
          },
        }
      : {}),
    requestedAt: str(row.requestedAt) ?? str(row.createdAt),
    expiresAt: str(row.expiresAt),
    revision: typeof row.revision === "number" ? row.revision : undefined,
  };
}

/** PH7: tolerant projection of the attention-list response body. Accepts the
 * rows under `attention`, `requests`, or a bare array. */
export function parsePacketAgentAttentionList(body: unknown): PacketAgentAttentionRequest[] {
  const root = record(body);
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(root?.attention)
      ? root.attention
      : Array.isArray(root?.requests)
        ? root.requests
        : [];
  return rows
    .map(parseOne)
    .filter((entry): entry is PacketAgentAttentionRequest => Boolean(entry));
}
