import { WORKER_PACKAGE_SCHEMA_VERSION } from "@/types/packet-agent";

export interface ContractSummary {
  schemaVersion?: string;
  /** False = server speaks a different worker-package schema (warning, not failure). */
  schemaMatches: boolean;
  operations: string[];
  allowedOperations: string[];
  credentialDisplayName?: string;
  credentialExpiresAt?: string;
  /** Set when the contract probe itself failed after a healthy /api/health. */
  probeWarning?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Defensive projection of GET /api/worker-packages/contract into the subset
 * the Settings card renders. A malformed body degrades to an empty summary
 * with `schemaMatches: false` rather than throwing. */
export function parseContractSummary(body: unknown): ContractSummary {
  const root = asRecord(body) ?? {};
  const credential = asRecord(root.credential) ?? {};
  const schemaVersion = typeof root.schemaVersion === "string" ? root.schemaVersion : undefined;
  return {
    schemaVersion,
    schemaMatches: schemaVersion === WORKER_PACKAGE_SCHEMA_VERSION,
    operations: stringList(root.operations),
    allowedOperations: stringList(credential.allowedOperations),
    credentialDisplayName:
      typeof credential.displayName === "string" ? credential.displayName : undefined,
    credentialExpiresAt:
      typeof credential.expiresAt === "string" ? credential.expiresAt : undefined,
  };
}
