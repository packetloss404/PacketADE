import { derivedArtifactProvenance } from "@/lib/provenance";
import type { PostCoordinationMessageInput } from "@/stores/coordinationInboxStore";
import type { CoordinationArtifactRef } from "@/types/flight";
import type {
  PacketAgentDeploymentProjection,
  PacketAgentEvidence,
  PacketAgentReturnedArtifact,
} from "@/types/packet-agent";
import { PACKET_AGENT_TERMINAL_STATES } from "@/lib/packetAgentProjection";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface PacketAgentEvidenceParseResult {
  evidence: PacketAgentEvidence[];
  artifacts: PacketAgentReturnedArtifact[];
  /** Server-typed codes (e.g. missing-evidence codes), surfaced verbatim. */
  codes: string[];
  /** Locally-detected integrity problems (malformed/mismatched digests). */
  integrityErrors: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseEvidenceEntry(value: unknown, integrityErrors: string[]): PacketAgentEvidence | undefined {
  const row = record(value);
  const id = str(row?.id);
  if (!row || !id) return undefined;
  const evidenceDigest = str(row.evidenceDigest) ?? "";
  if (!DIGEST_PATTERN.test(evidenceDigest)) {
    integrityErrors.push(`Evidence ${id} carries a malformed digest.`);
  }
  const manifestIds = stringList(row.artifactManifestIds);
  return {
    id,
    sequence: typeof row.sequence === "number" ? row.sequence : 0,
    summary: str(row.summary) ?? "",
    classification: str(row.classification) ?? "unclassified",
    sourceEventId: str(row.sourceEventId) ?? "",
    workerRunId: str(row.workerRunId),
    traceId: str(row.traceId),
    ...(manifestIds.length > 0 ? { artifactManifestIds: manifestIds } : {}),
    evidenceDigest,
    createdAt: str(row.createdAt) ?? "",
  };
}

function parseArtifact(value: unknown, integrityErrors: string[]): PacketAgentReturnedArtifact | undefined {
  const row = record(value);
  const reference = str(row?.reference);
  if (!row || !reference) return undefined;
  const contentDigest = str(row.contentDigest) ?? "";
  if (!DIGEST_PATTERN.test(contentDigest)) {
    integrityErrors.push(`Artifact ${reference} carries a malformed content digest.`);
  }
  return {
    reference,
    name: str(row.name),
    mediaType: str(row.mediaType) ?? "application/octet-stream",
    byteLength: typeof row.byteLength === "number" ? row.byteLength : 0,
    contentDigest,
    producerKind: str(row.producerKind) ?? "worker",
    role: str(row.role),
  };
}

/**
 * PH8: typed projection of GET /api/worker-events/:id/evidence, replacing the
 * raw JSON dump. Tolerant of shape drift: evidence rows under `evidence` or
 * `entries` (or one bare entry), artifacts under `artifacts`, server codes
 * under `code`/`codes`/`error.code` — surfaced verbatim, never rewritten.
 */
export function parsePacketAgentEvidence(body: unknown): PacketAgentEvidenceParseResult {
  const integrityErrors: string[] = [];
  const root = record(body) ?? {};
  const rows = Array.isArray(root.evidence)
    ? root.evidence
    : Array.isArray(root.entries)
      ? root.entries
      : record(root.evidence)
        ? [root.evidence]
        : str(root.id)
          ? [root]
          : [];
  const evidence = rows
    .map((row) => parseEvidenceEntry(row, integrityErrors))
    .filter((entry): entry is PacketAgentEvidence => Boolean(entry))
    .sort((a, b) => a.sequence - b.sequence);
  const artifacts = (Array.isArray(root.artifacts) ? root.artifacts : [])
    .map((row) => parseArtifact(row, integrityErrors))
    .filter((entry): entry is PacketAgentReturnedArtifact => Boolean(entry));
  const codes = [
    ...stringList(root.codes),
    ...(str(root.code) ? [root.code as string] : []),
    ...(str(record(root.error)?.code) ? [record(root.error)?.code as string] : []),
  ];
  return { evidence, artifacts, codes, integrityErrors };
}

// === Terminal-state verdict =================================================

export interface PacketAgentTerminalVerdict {
  tone: "success" | "warning" | "error";
  label: string;
}

/**
 * PH8: verdict shown when a projection reaches a terminal run state.
 * "Completed without available evidence" is explicitly NOT success — the
 * worker claims completion but produced nothing verifiable.
 */
export function packetAgentTerminalVerdict(
  projection: PacketAgentDeploymentProjection,
): PacketAgentTerminalVerdict | undefined {
  const status = projection.status as (typeof PACKET_AGENT_TERMINAL_STATES)[number];
  if (!PACKET_AGENT_TERMINAL_STATES.includes(status)) return undefined;
  if (status === "completed") {
    if (projection.evidenceEventIds.length === 0) {
      return { tone: "warning", label: "completed — evidence unavailable" };
    }
    return { tone: "success", label: "completed with evidence" };
  }
  if (status === "budget_exhausted") return { tone: "error", label: "budget exhausted" };
  return { tone: "error", label: status };
}

// === Landing ================================================================

/**
 * PH8: build the coordination-inbox message that lands evidence/artifact
 * REFERENCES into a Flight. Every artifact ref is provenance-stamped as a
 * generated derivative (evidence-only authority) via
 * `derivedArtifactProvenance`; nothing is fetched or checked out — landing
 * records references, and any content fetch stays a separate explicit action.
 */
export function buildPacketAgentEvidenceLanding(args: {
  flightId: string;
  deploymentId: string;
  eventId: string;
  result: PacketAgentEvidenceParseResult;
}): PostCoordinationMessageInput {
  const { flightId, deploymentId, eventId, result } = args;
  const capturedAt = Date.now();
  const artifacts: CoordinationArtifactRef[] = [
    ...result.evidence.map((entry) => ({
      id: `packetagent:evidence:${entry.id}`,
      label: entry.summary || `PacketAgent evidence ${entry.id}`,
      uri: `packetagent://worker-events/${entry.sourceEventId || eventId}/evidence/${entry.id}`,
      provenance: derivedArtifactProvenance(
        `packetagent_evidence_${entry.id}`,
        `PacketAgent evidence · ${entry.classification}`,
        [],
        capturedAt,
      ),
    })),
    ...result.artifacts.map((artifact) => ({
      id: `packetagent:artifact:${artifact.reference}`,
      label: artifact.name ?? artifact.reference,
      uri: artifact.reference,
      mimeType: artifact.mediaType,
      provenance: derivedArtifactProvenance(
        `packetagent_artifact_${artifact.contentDigest.slice(0, 24)}`,
        `PacketAgent returned artifact · ${artifact.producerKind}`,
        [],
        capturedAt,
      ),
    })),
  ];
  // The coordination inbox caps artifacts per message (INBOX_MAX_ARTIFACTS);
  // land the first 8 references and say so rather than failing the post.
  const capped = artifacts.slice(0, 8);
  const summaryLine =
    `PacketAgent evidence landed for deployment ${deploymentId} (event ${eventId}): ` +
    `${result.evidence.length} evidence entr${result.evidence.length === 1 ? "y" : "ies"}, ` +
    `${result.artifacts.length} artifact reference(s).` +
    (artifacts.length > capped.length
      ? ` (${artifacts.length - capped.length} additional reference(s) not attached.)`
      : "") +
    (result.codes.length > 0 ? ` Server codes: ${result.codes.join(", ")}.` : "") +
    (result.integrityErrors.length > 0
      ? ` Integrity problems: ${result.integrityErrors.join(" ")}`
      : "");
  return {
    flightId,
    kind: "artifact",
    sender: { kind: "system", id: "packetagent", displayName: "PacketAgent" },
    recipients: [{ kind: "flight" }],
    body: summaryLine,
    artifacts: capped,
    dedupeKey: `packetagent:evidence:${eventId}`,
  };
}
