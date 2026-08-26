import { APP_NAME, APP_NAME_LOWER } from "@/lib/brand";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt, Flight } from "@/types/flight";
import {
  WORKER_PACKAGE_CANONICALIZATION,
  WORKER_PACKAGE_SCHEMA_VERSION,
  type PacketAgentWorkerPackage,
} from "@/types/packet-agent";

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${path} contains an unpaired Unicode surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${path} contains an unpaired Unicode surrogate`);
    }
  }
}

export function canonicalPacketAgentJson(value: unknown, path = "$"): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => {
        if (entry === undefined) throw new Error(`${path}[${index}] is undefined`);
        return canonicalPacketAgentJson(entry, `${path}[${index}]`);
      })
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON values`);
    }
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => {
        assertUnicodeScalarString(key, `${path} property name`);
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined) throw new Error(`${path}.${key} is undefined`);
        return `${JSON.stringify(key)}:${canonicalPacketAgentJson(entry, `${path}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`${path} must contain only plain JSON values`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computePacketAgentPackageDigest(
  workerPackage: PacketAgentWorkerPackage,
): Promise<string> {
  const content = { ...workerPackage } as Record<string, unknown>;
  delete content.integrity;
  const subject = {
    ...content,
    integrity: {
      canonicalization: WORKER_PACKAGE_CANONICALIZATION,
      algorithm: "sha256",
    },
  };
  return `sha256:${await sha256Hex(canonicalPacketAgentJson(subject))}`;
}

/**
 * PH3: discriminated source union for `buildWorkerPackage`.
 * - `flight` — the original whole-Flight handoff. Output is byte-identical to
 *   the historical `buildPacketAgentPackage(flight)` when no git context is
 *   passed (the pinned digest fixture must never move).
 * - `attempt` — one worktree-backed attempt of an async Flight.
 * - `conversation` — a standalone `AgentConversation` (worktree or in-place).
 */
export type PackageSource =
  | { kind: "flight"; flight: Flight }
  | { kind: "attempt"; flight: Flight; attempt: Attempt }
  | { kind: "conversation"; conversation: AgentConversation };

/** Optional git enrichment resolved by the caller (origin URL, branch/SHA).
 * Kept out of the builder so package construction stays synchronous and
 * deterministic for tests. */
export interface PackageGitContext {
  repository?: string;
  revision?: string;
}

interface WorkerPackageDescriptor {
  packageId: string;
  packageVersion: number;
  createdAtMs: number;
  createdById: string;
  createdByDisplayName: string;
  source: PacketAgentWorkerPackage["source"];
  name: string;
  objective: string;
  instructions: string;
  notificationReference: string;
}

const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_TURN_CHARS = 400;

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** Bounded plain-text summary of a conversation transcript, newest-last.
 * Never includes tool payloads — only user/assistant turn text. */
export function summarizeConversationTranscript(conversation: AgentConversation): string {
  const turns: string[] = [];
  let total = 0;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = trimmed(message.content);
    if (!text) continue;
    const clipped = text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text;
    const line = `${message.role === "user" ? "User" : "Agent"}: ${clipped}`;
    if (total + line.length > MAX_TRANSCRIPT_CHARS) break;
    turns.unshift(line);
    total += line.length;
  }
  return turns.join("\n\n");
}

function firstUserTurn(conversation: AgentConversation): string | undefined {
  const message = conversation.messages.find(
    (candidate) => candidate.role === "user" && trimmed(candidate.content),
  );
  return message ? trimmed(message.content) : undefined;
}

function attemptDescriptor(
  flight: Flight,
  attempt: Attempt,
  git: PackageGitContext | undefined,
): WorkerPackageDescriptor {
  const repository = trimmed(git?.repository) || trimmed(attempt.target.basePath);
  const revision = trimmed(git?.revision) || trimmed(attempt.branch);
  if (!repository || !revision) {
    throw new Error(
      "Attempt handoff requires a resolvable repository and revision — a bare " +
        `worktree path is not portable. Missing: ${[
          !repository && "repository",
          !revision && "revision (attempt branch)",
        ]
          .filter(Boolean)
          .join(", ")}.`,
    );
  }
  const packageVersion = Math.max(1, Math.floor(flight.updatedAt));
  const flightObjective =
    trimmed(flight.objective) || trimmed(flight.title) || "Complete the delegated Flight";
  const objective = `${flightObjective} (attempt ${attempt.branch})`;
  const instructionLines = [
    trimmed(flight.prompt) ||
      `Continue working on this Flight until its bounded objective is satisfied: ${flightObjective}`,
    `Work on branch ${attempt.branch} (based on ${attempt.baseBranch}) of repository ${repository}.`,
  ];
  if (attempt.draftPrNumber !== undefined) {
    instructionLines.push(`Draft PR #${attempt.draftPrNumber} is already open for this branch.`);
  }
  return {
    packageId: `${APP_NAME_LOWER}:${flight.id}:attempt:${attempt.id}:worker`,
    packageVersion,
    createdAtMs: flight.updatedAt,
    createdById: `${APP_NAME_LOWER}:${flight.id}:${attempt.id}`,
    createdByDisplayName: `${APP_NAME} Attempt ${attempt.branch} of Flight ${flight.title || flight.id}`,
    source: {
      product: APP_NAME,
      kind: APP_NAME_LOWER,
      sourceId: attempt.id,
      flightId: flight.id,
      ...(flight.workspaceId ? { projectId: flight.workspaceId } : {}),
      repository,
      revision,
    },
    name: trimmed(flight.title)
      ? `${trimmed(flight.title)} — ${attempt.branch}`
      : `Delegated attempt ${attempt.branch}`,
    objective,
    instructions: instructionLines.join("\n\n"),
    notificationReference: `attempt:${attempt.id}`,
  };
}

function conversationDescriptor(
  conversation: AgentConversation,
  git: PackageGitContext | undefined,
): WorkerPackageDescriptor {
  const worktree = conversation.worktree;
  const repository =
    trimmed(git?.repository) ||
    trimmed(worktree?.basePath) ||
    trimmed(conversation.projectPath);
  const revision = trimmed(git?.revision) || trimmed(worktree?.branch);
  if (worktree && (!repository || !revision)) {
    throw new Error(
      "Conversation handoff from a worktree requires a resolvable repository " +
        "and revision — a bare worktree path is not portable. Missing: " +
        `${[!repository && "repository", !revision && "revision (worktree branch)"]
          .filter(Boolean)
          .join(", ")}.`,
    );
  }
  if (!repository) {
    throw new Error("Conversation handoff requires a project path or repository.");
  }
  const packageVersion = Math.max(1, Math.floor(conversation.updatedAt));
  const objective =
    trimmed(conversation.title) ||
    firstUserTurn(conversation)?.slice(0, 200) ||
    "Continue the delegated conversation";
  const transcript = summarizeConversationTranscript(conversation);
  const instructions = [
    `Continue the delegated conversation until its objective is satisfied: ${objective}`,
    revision ? `Work in repository ${repository} on branch ${revision}.` : `Work in repository ${repository}.`,
    transcript ? `Conversation so far (bounded summary):\n\n${transcript}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
  return {
    packageId: `${APP_NAME_LOWER}:conversation:${conversation.id}:worker`,
    packageVersion,
    createdAtMs: conversation.updatedAt,
    createdById: `${APP_NAME_LOWER}:conversation:${conversation.id}`,
    createdByDisplayName: `${APP_NAME} Conversation ${conversation.title || conversation.id}`,
    source: {
      product: APP_NAME,
      kind: APP_NAME_LOWER,
      sourceId: conversation.id,
      conversationId: conversation.id,
      repository,
      ...(revision ? { revision } : {}),
    },
    name: trimmed(conversation.title) || "Delegated conversation worker",
    objective,
    instructions,
    notificationReference: `conversation:${conversation.id}`,
  };
}

function flightDescriptor(flight: Flight, git: PackageGitContext | undefined): WorkerPackageDescriptor {
  const firstTask = flight.milestones.flatMap((milestone) => milestone.tasks)[0];
  const objective =
    flight.objective.trim() || flight.title.trim() || "Complete the delegated Flight";
  const instructions =
    flight.prompt?.trim() ||
    `Continue working on this Flight until its bounded objective is satisfied: ${objective}`;
  return {
    packageId: `${APP_NAME_LOWER}:${flight.id}:worker`,
    // Millisecond revision preserves idempotency when a Flight changes more
    // than once inside the same second; the W9 contract accepts any positive
    // safe int.
    packageVersion: Math.max(1, Math.floor(flight.updatedAt)),
    createdAtMs: flight.updatedAt,
    createdById: `${APP_NAME_LOWER}:${flight.id}`,
    createdByDisplayName: `${APP_NAME} Flight ${flight.title || flight.id}`,
    source: {
      product: APP_NAME,
      kind: APP_NAME_LOWER,
      ...(firstTask ? { sourceId: firstTask.id } : {}),
      flightId: flight.id,
      ...(flight.workspaceId ? { projectId: flight.workspaceId } : {}),
      ...(flight.planningConversationId ? { conversationId: flight.planningConversationId } : {}),
      ...(git?.repository ? { repository: git.repository } : {}),
      ...(git?.revision ? { revision: git.revision } : {}),
    },
    name: flight.title.trim() || "Delegated Flight worker",
    objective,
    instructions,
    notificationReference: `flight:${flight.id}`,
  };
}

export async function buildWorkerPackage(
  source: PackageSource,
  git?: PackageGitContext,
): Promise<PacketAgentWorkerPackage> {
  const descriptor =
    source.kind === "flight"
      ? flightDescriptor(source.flight, git)
      : source.kind === "attempt"
        ? attemptDescriptor(source.flight, source.attempt, git)
        : conversationDescriptor(source.conversation, git);
  const idempotencyKey = `${descriptor.packageId}:v${descriptor.packageVersion}`;
  const { objective, instructions } = descriptor;
  const workerPackage: PacketAgentWorkerPackage = {
    schemaVersion: WORKER_PACKAGE_SCHEMA_VERSION,
    packageId: descriptor.packageId,
    packageVersion: descriptor.packageVersion,
    idempotencyKey,
    createdAt: new Date(descriptor.createdAtMs).toISOString(),
    createdBy: {
      type: "packet_product",
      id: descriptor.createdById,
      displayName: descriptor.createdByDisplayName,
      product: APP_NAME,
    },
    source: descriptor.source,
    worker: {
      name: descriptor.name,
      description: objective,
      content: {
        objective,
        instructions,
        inputSchema: { fields: [], additionalProperties: false },
        execution: { routeKey: "smart", target: { kind: "packetagent" } },
        tools: [],
        credentialRefs: [],
        triggers: [
          {
            id: "manual",
            kind: "manual",
            enabled: true,
            description: `Start when ${APP_NAME} requests this handoff.`,
          },
        ],
        policy: {
          budgets: {
            maxElapsedMs: 3_600_000,
            maxIterations: 24,
            maxProviderCostUsd: 10,
            maxConsecutiveFailures: 3,
            maxToolCalls: 100,
          },
          retry: {
            maxAttempts: 3,
            initialBackoffMs: 1_000,
            maxBackoffMs: 30_000,
            backoffMultiplier: 2,
          },
          permissions: { default: "deny", allowedCapabilityIds: [] },
          attention: {
            approvalTimeoutMs: 1_800_000,
            escalationAfterMs: 600_000,
            onExpiration: "pause",
          },
        },
        exitPredicates: [
          {
            id: "flight-objective",
            kind: "objective_satisfied",
            description: "The delegated Flight objective is satisfied with evidence.",
          },
        ],
        acceptanceCommands: [],
        notificationRoutes: [
          {
            id: `${APP_NAME_LOWER}-${source.kind}`,
            kind: "packetagent",
            reference: descriptor.notificationReference,
            events: ["attention", "terminal"],
          },
        ],
      },
    },
    artifacts: [],
    integrity: {
      canonicalization: WORKER_PACKAGE_CANONICALIZATION,
      algorithm: "sha256",
      digest: `sha256:${"0".repeat(64)}`,
    },
  };
  workerPackage.integrity.digest = await computePacketAgentPackageDigest(workerPackage);
  return workerPackage;
}

/** Historical flight-only entry point. Kept because its output is contract-
 * frozen: `buildWorkerPackage({ kind: "flight", flight })` with no git context
 * is byte-identical to what this produced before PH3. */
export async function buildPacketAgentPackage(flight: Flight): Promise<PacketAgentWorkerPackage> {
  return buildWorkerPackage({ kind: "flight", flight });
}

export function validatePacketAgentPackageLocally(value: PacketAgentWorkerPackage): string[] {
  const issues: string[] = [];
  if (value.schemaVersion !== WORKER_PACKAGE_SCHEMA_VERSION) {
    issues.push(`Unsupported schema: ${value.schemaVersion}`);
  }
  if (!value.packageId.trim() || !Number.isSafeInteger(value.packageVersion)) {
    issues.push("Package identity is invalid.");
  }
  if (!value.worker.name.trim() || !value.worker.content.objective.trim()) {
    issues.push("Worker name and objective are required.");
  }
  const ids = new Set<string>();
  for (const capability of value.worker.content.tools) {
    if (ids.has(capability.id)) issues.push(`Duplicate capability: ${capability.id}`);
    ids.add(capability.id);
  }
  if (
    value.worker.content.policy.permissions.allowedCapabilityIds.some(
      (capabilityId) => !ids.has(capabilityId),
    )
  ) {
    issues.push("Permission policy names an undeclared capability.");
  }
  const artifactReferences = new Set<string>();
  for (const artifact of value.artifacts) {
    if (artifactReferences.has(artifact.reference)) {
      issues.push(`Duplicate artifact reference: ${artifact.reference}`);
    }
    artifactReferences.add(artifact.reference);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.integrity.digest)) {
    issues.push("Package digest is malformed.");
  }
  return issues;
}
