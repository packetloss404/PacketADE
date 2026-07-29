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

export type ProvenanceTransform =
  | "truncated"
  | "extracted"
  | "redacted"
  | "summarized";

export interface ProvenanceEnvelope {
  schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  id: string;
  origin: ProvenanceOrigin;
  authority: ProvenanceAuthority;
  identity: {
    label: string;
    /** Safe display locator only. Never a credential-bearing command/URL. */
    locator?: string;
  };
  integrity: {
    capturedAt: number;
    state: "verified" | "unverified" | "unknown";
    contentHash?: string;
    hashAlgorithm?: "fnv1a64";
    transforms: ProvenanceTransform[];
  };
  lineage: {
    parentIds: string[];
  };
}
