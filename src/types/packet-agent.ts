/**
 * PacketAgent W9 consumer contract.
 *
 * Frozen from PacketAgent main at cf910c170261d40e03fe82666c6d2363cf72a4b0
 * (adds the contract descriptor route, packet-product attention operations,
 * and the credential-mint CLI — all additive; digest fixture unchanged).
 * PacketAgent owns the normative runtime contract; this file deliberately
 * contains only the subset PacketBench emits or projects.
 */
import { APP_NAME, APP_NAME_LOWER } from "@/lib/brand";

export const PACKET_AGENT_CONTRACT_COMMIT = "cf910c170261d40e03fe82666c6d2363cf72a4b0";
export const WORKER_PACKAGE_SCHEMA_VERSION = "packetagent.worker-package/v1";
export const WORKER_PACKAGE_CANONICALIZATION = "packetagent.worker-package-canonical-json/v1";

/** W9 artifact-by-reference shape. Artifacts are references, never payloads —
 * PacketAgent fetches content itself; PacketBench never inlines file bytes. */
export interface PacketAgentWorkerArtifactReference {
  reference: string;
  name?: string;
  mediaType: string;
  byteLength: number;
  contentDigest: string;
  role: "source" | "configuration" | "acceptance" | "input" | "other";
  classification: string;
}

export interface PacketAgentWorkerCapability {
  id: string;
  tool: string;
  verbs: string[];
  resources: string[];
  effect: "read" | "write" | "execute";
  approval: "never" | "always";
}

export interface PacketAgentWorkerPackage {
  schemaVersion: typeof WORKER_PACKAGE_SCHEMA_VERSION;
  packageId: string;
  packageVersion: number;
  idempotencyKey: string;
  createdAt: string;
  createdBy: {
    type: "packet_product";
    id: string;
    displayName: string;
    product: typeof APP_NAME;
  };
  source: {
    product: typeof APP_NAME;
    kind: typeof APP_NAME_LOWER;
    sourceId?: string;
    /** Optional since PH3 — PacketAgent's WorkerSourceProvenance never
     * required it; conversation-kind packages have no Flight. */
    flightId?: string;
    projectId?: string;
    conversationId?: string;
    repository?: string;
    revision?: string;
  };
  worker: {
    name: string;
    description: string;
    content: {
      objective: string;
      instructions: string;
      inputSchema: {
        fields: Array<{
          key: string;
          label: string;
          type: "string" | "number" | "boolean" | "url" | "enum";
          required: boolean;
          description?: string;
        }>;
        additionalProperties: boolean;
      };
      execution: {
        routeKey: string;
        target: { kind: "packetagent" };
      };
      tools: PacketAgentWorkerCapability[];
      credentialRefs: string[];
      triggers: Array<{
        id: string;
        kind: "manual";
        enabled: boolean;
        description: string;
      }>;
      policy: {
        budgets: {
          maxElapsedMs: number;
          maxIterations: number;
          maxProviderCostUsd: number;
          maxConsecutiveFailures: number;
          maxToolCalls: number;
        };
        retry: {
          maxAttempts: number;
          initialBackoffMs: number;
          maxBackoffMs: number;
          backoffMultiplier: number;
        };
        permissions: {
          default: "deny";
          allowedCapabilityIds: string[];
        };
        attention: {
          approvalTimeoutMs: number;
          escalationAfterMs: number;
          onExpiration: "pause";
        };
      };
      exitPredicates: Array<{
        id: string;
        kind: "objective_satisfied";
        description: string;
      }>;
      acceptanceCommands: string[];
      notificationRoutes: Array<{
        id: string;
        kind: "packetagent";
        reference: string;
        events: string[];
      }>;
    };
  };
  artifacts: PacketAgentWorkerArtifactReference[];
  integrity: {
    canonicalization: typeof WORKER_PACKAGE_CANONICALIZATION;
    algorithm: "sha256";
    digest: string;
  };
}

export interface PacketAgentDeploymentProjection {
  /** Local projection key — historically always a Flight id; conversation
   * deployments (PH3) use the conversation id. */
  flightId: string;
  packageId: string;
  packageVersion: number;
  packageDigest: string;
  deploymentId: string;
  workerRunId?: string;
  revision: number;
  status: string;
  cursor?: string;
  cursorEtag?: string;
  lastEventId?: string;
  lastEventType?: string;
  attentionCount: number;
  evidenceEventIds: string[];
  /** PH6: checkpoint/progress events observed so far. */
  checkpointCount?: number;
  /** PH6: latest total cost reported by event summaries (USD). */
  totalCostUsd?: number;
  updatedAt: number;
}

export interface PacketAgentResponse {
  status: number;
  body: Record<string, unknown>;
  etag?: string;
}

export type PacketAgentOperation =
  | "health"
  | "contract"
  | "validate"
  | "deploy"
  | "inspect"
  | "activate"
  | "pause"
  | "resume"
  | "rollback"
  | "revoke"
  | "runs"
  | "events"
  | "ack_events"
  | "evidence"
  | "attention"
  | "respond_attention";

export interface PacketAgentRequest {
  endpoint: string;
  workspaceId?: string;
  operation: PacketAgentOperation;
  deploymentId?: string;
  eventId?: string;
  attentionId?: string;
  cursor?: string;
  payload?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
}

/** PH8: consumer subset of PacketAgent's WorkerEvidenceEntry. */
export interface PacketAgentEvidence {
  id: string;
  sequence: number;
  summary: string;
  classification: string;
  sourceEventId: string;
  workerRunId?: string;
  traceId?: string;
  artifactManifestIds?: string[];
  evidenceDigest: string;
  createdAt: string;
}

/** PH8: artifact returned BY REFERENCE from a worker run. Content is never
 * inlined — landing records the reference; any fetch is a separate explicit
 * user action. */
export interface PacketAgentReturnedArtifact {
  reference: string;
  name?: string;
  mediaType: string;
  byteLength: number;
  contentDigest: string;
  producerKind: string;
  role?: string;
}

/** PH7: decision verbs accepted by POST /api/worker-attention/:id/respond. */
export type PacketAgentAttentionDecision = "approve_once" | "approve_for_run" | "reject";

/** PH7: consumer subset of PacketAgent's WorkerOperatorAttentionView. Every
 * field beyond `id` is optional — the server owns the normative shape and
 * the card renders what it can. */
export interface PacketAgentAttentionRequest {
  id: string;
  workerDeploymentId?: string;
  workerRunId?: string;
  status?: string;
  summary?: string;
  /** Requested capability descriptor (tool/verb/effect/resource schemes). */
  operation?: {
    tool?: string;
    verb?: string;
    effect?: string;
    resources?: string[];
  };
  requestedAt?: string;
  expiresAt?: string;
  /** Optimistic-concurrency revision echoed back as expectedRevision. */
  revision?: number;
}
