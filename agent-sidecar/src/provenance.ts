/**
 * Sidecar mirror of PacketADE's provenance v1 contract. The host currently
 * stamps canonical api-agent events after transport normalization, so this
 * envelope type itself does not alter protocol v11's wire shape.
 */
export const PROVENANCE_SCHEMA_VERSION = 1 as const;

export type ProvenanceOrigin =
  | "user"
  | "local_workspace"
  | "remote_workspace"
  | "web"
  | "mcp"
  | "imported_file"
  | "memory"
  | "agent"
  | "generated_derivative"
  | "unknown";

export type ProvenanceAuthority =
  | "user_intent"
  | "policy_authorized"
  | "evidence_only";

export interface ProvenanceEnvelope {
  schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  id: string;
  origin: ProvenanceOrigin;
  authority: ProvenanceAuthority;
  identity: { label: string; locator?: string };
  integrity: {
    capturedAt: number;
    state: "verified" | "unverified" | "unknown";
    contentHash?: string;
    hashAlgorithm?: "fnv1a64";
    transforms: Array<"truncated" | "extracted" | "redacted" | "summarized">;
  };
  lineage: { parentIds: string[] };
}
