import type { TaskType } from "./flight";

// === Task Type Metadata ===

export const ALL_TASK_TYPES: TaskType[] = [
  "implementation",
  "testing",
  "review",
  "validation",
  "research",
  "refactor",
  "documentation",
];

export const TASK_TYPE_LABELS: Record<TaskType, { label: string; description: string }> = {
  implementation: { label: "Implementation", description: "Writing new code" },
  testing: { label: "Testing", description: "Writing & running tests" },
  review: { label: "Code Review", description: "Reviewing code changes" },
  validation: { label: "Validation", description: "Verifying correctness" },
  research: { label: "Research", description: "Exploring solutions" },
  refactor: { label: "Refactoring", description: "Improving existing code" },
  documentation: { label: "Documentation", description: "Writing docs" },
};

// === Provider Routing ===

export interface RouteMapping {
  taskType: TaskType;
  agentConfigId: string;
  model: string | null; // null = system default
}

// === Auxiliary AI task routing (WI-1) ===
//
// Distinct from the `TaskType` routing above, which assigns a coding AGENT to a
// workflow role. These are the short, single-shot generation tasks PacketADE
// runs on the user's behalf: parse a spec, explain a lint failure, write PR
// prose. They do not need a frontier model and they are never routed through a
// Claude / ChatGPT subscription login — see `src-tauri/src/core/aux_llm.rs`.
//
// Ids must match `AuxTaskClass::id()` in that module exactly.

export type AuxTaskClass =
  | "spec-import"
  | "code-quality-explain"
  | "code-quality-summarize"
  | "pr-description"
  | "pr-review";

export const ALL_AUX_TASK_CLASSES: AuxTaskClass[] = [
  "spec-import",
  "code-quality-explain",
  "code-quality-summarize",
  "pr-description",
  "pr-review",
];

export const AUX_TASK_CLASS_LABELS: Record<
  AuxTaskClass,
  { label: string; description: string }
> = {
  "spec-import": { label: "Spec import", description: "Spec / PRD → issue drafts" },
  "code-quality-explain": {
    label: "Explain diagnostic",
    description: "Code Quality error explanations",
  },
  "code-quality-summarize": {
    label: "Summarize checks",
    description: "Code Quality run summaries",
  },
  "pr-description": { label: "PR description", description: "GitHub PR write-ups" },
  "pr-review": { label: "PR review", description: "GitHub pre-flight reviews" },
};

/**
 * Settings-card grouping for the auxiliary task classes. Rendered as
 * headed sections once the flat list outgrows a single screenful (>8 rows);
 * every class must appear in exactly one group.
 */
export const AUX_TASK_CLASS_GROUPS: { label: string; classes: AuxTaskClass[] }[] = [
  { label: "Spec & issues", classes: ["spec-import"] },
  { label: "Code Quality", classes: ["code-quality-explain", "code-quality-summarize"] },
  { label: "GitHub", classes: ["pr-description", "pr-review"] },
];

/**
 * A user-pinned auxiliary route. `provider: null` means "Auto" — the backend
 * picks the cheapest configured API-key provider using the shared rate table.
 */
export interface AuxRouteMapping {
  taskClass: AuxTaskClass;
  provider: string | null;
  model: string | null;
}

/** What a task class resolves to right now, straight from the backend. */
export interface AuxRouteResolution {
  taskClass: string;
  label: string;
  provider: string | null;
  model: string | null;
  explicit: boolean;
  error: string | null;
}

/** A provider an auxiliary task class may be pinned to. */
export interface AuxProviderOption {
  provider: string;
  defaultModel: string;
  needsApiKey: boolean;
  configured: boolean;
}
