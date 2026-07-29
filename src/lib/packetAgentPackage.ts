import { APP_NAME, APP_NAME_LOWER } from "@/lib/brand";
import type { Flight } from "@/types/flight";
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

export async function buildPacketAgentPackage(flight: Flight): Promise<PacketAgentWorkerPackage> {
  const firstTask = flight.milestones.flatMap((milestone) => milestone.tasks)[0];
  // Millisecond revision preserves idempotency when a Flight changes more than
  // once inside the same second; the W9 contract accepts any positive safe int.
  const packageVersion = Math.max(1, Math.floor(flight.updatedAt));
  const packageId = `${APP_NAME_LOWER}:${flight.id}:worker`;
  const idempotencyKey = `${packageId}:v${packageVersion}`;
  const objective =
    flight.objective.trim() || flight.title.trim() || "Complete the delegated Flight";
  const instructions =
    flight.prompt?.trim() ||
    `Continue working on this Flight until its bounded objective is satisfied: ${objective}`;
  const workerPackage: PacketAgentWorkerPackage = {
    schemaVersion: WORKER_PACKAGE_SCHEMA_VERSION,
    packageId,
    packageVersion,
    idempotencyKey,
    createdAt: new Date(flight.updatedAt).toISOString(),
    createdBy: {
      type: "packet_product",
      id: `${APP_NAME_LOWER}:${flight.id}`,
      displayName: `${APP_NAME} Flight ${flight.title || flight.id}`,
      product: APP_NAME,
    },
    source: {
      product: APP_NAME,
      kind: APP_NAME_LOWER,
      ...(firstTask ? { sourceId: firstTask.id } : {}),
      flightId: flight.id,
      ...(flight.workspaceId ? { projectId: flight.workspaceId } : {}),
      ...(flight.planningConversationId ? { conversationId: flight.planningConversationId } : {}),
    },
    worker: {
      name: flight.title.trim() || "Delegated Flight worker",
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
            id: `${APP_NAME_LOWER}-flight`,
            kind: "packetagent",
            reference: `flight:${flight.id}`,
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
  if (!/^sha256:[a-f0-9]{64}$/.test(value.integrity.digest)) {
    issues.push("Package digest is malformed.");
  }
  return issues;
}
