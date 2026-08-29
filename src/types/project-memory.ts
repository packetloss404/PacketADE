export const PROJECT_MEMORY_SCHEMA_VERSION = 1;
export const PROJECT_MEMORY_DIRECTORY = ".agents/memory";

export interface ProjectMemoryMetadata {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  tags: string[];
  provenanceIds: string[];
}

export interface ProjectMemoryNote {
  metadata: ProjectMemoryMetadata;
  body: string;
  revision: string;
  relativePath: string;
  outboundIds: string[];
  backlinkIds: string[];
  brokenLinks: string[];
  orphaned: boolean;
}

export interface ProjectMemoryWarning {
  relativePath: string;
  code:
    | "unreadable"
    | "symlink_rejected"
    | "oversized"
    | "binary_rejected"
    | "invalid_utf8"
    | "malformed_frontmatter"
    | "unsupported_schema"
    | "invalid_metadata"
    | "duplicate_id"
    | "ambiguous_link"
    | "count_limit"
    | string;
  message: string;
}

export interface ProjectMemorySnapshot {
  schemaVersion: number;
  directory: string;
  notes: ProjectMemoryNote[];
  warnings: ProjectMemoryWarning[];
  revision: string;
}

export interface CreateProjectMemoryInput {
  title: string;
  body: string;
  tags?: string[];
  provenanceIds?: string[];
}

export interface UpdateProjectMemoryInput extends CreateProjectMemoryInput {
  id: string;
  expectedRevision: string;
}

export interface ProjectMemoryChangedEvent {
  projectPath: string;
}
