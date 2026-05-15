import type { FlightStatus, FlightPriority, TaskRole } from "@/types/flight";
import type { IssueStatus } from "@/stores/issueStore";

export const FLIGHT_STATUS_CONFIG: Record<FlightStatus, { dot: string; bg: string; text: string; label: string }> = {
  spec: { dot: "bg-accent-purple", bg: "bg-accent-purple/10", text: "text-accent-purple", label: "Spec" },
  draft: { dot: "bg-text-muted", bg: "bg-text-muted/10", text: "text-text-muted", label: "Draft" },
  planning: { dot: "bg-accent-purple", bg: "bg-accent-purple/10", text: "text-accent-purple", label: "Planning" },
  ready: { dot: "bg-accent-blue", bg: "bg-accent-blue/10", text: "text-accent-blue", label: "Ready" },
  active: { dot: "bg-accent-blue", bg: "bg-accent-blue/10", text: "text-accent-blue", label: "Active" },
  paused: { dot: "bg-accent-amber", bg: "bg-accent-amber/10", text: "text-accent-amber", label: "Paused" },
  review: { dot: "bg-accent-purple", bg: "bg-accent-purple/10", text: "text-accent-purple", label: "Review" },
  done: { dot: "bg-accent-green", bg: "bg-accent-green/10", text: "text-accent-green", label: "Done" },
  failed: { dot: "bg-accent-red", bg: "bg-accent-red/10", text: "text-accent-red", label: "Failed" },
  cancelled: { dot: "bg-text-muted", bg: "bg-text-muted/10", text: "text-text-muted", label: "Cancelled" },
};

export const FLIGHT_PRIORITY_COLORS: Record<FlightPriority, string> = {
  critical: "text-accent-red",
  high: "text-accent-amber",
  medium: "text-accent-blue",
  low: "text-text-muted",
};

export const ISSUE_STATUS_COLORS: Record<IssueStatus, string> = {
  todo: "bg-text-muted",
  in_progress: "bg-accent-blue",
  qa: "bg-accent-purple",
  done: "bg-accent-green",
  blocked: "bg-accent-red",
  needs_human: "bg-accent-amber",
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  qa: "QA",
  done: "Done",
  blocked: "Blocked",
  needs_human: "Needs Human",
};

export const TASK_ROLE_CONFIG: Record<TaskRole, { label: string; color: string; icon: string }> = {
  coordinator: { label: "Coordinator", color: "text-accent-purple", icon: "crown" },
  builder: { label: "Builder", color: "text-accent-green", icon: "hammer" },
  reviewer: { label: "Reviewer", color: "text-accent-blue", icon: "eye" },
  scout: { label: "Scout", color: "text-accent-amber", icon: "compass" },
};

/** Activity dot color per agent state, used by Flights live tiles. */
export const ACTIVITY_DOT_COLORS: Record<string, string> = {
  idle: "bg-text-muted",
  thinking: "bg-accent-blue",
  tool_use: "bg-accent-green",
  responding: "bg-accent-green",
  approval_needed: "bg-accent-amber",
};
