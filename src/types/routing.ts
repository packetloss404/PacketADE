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
