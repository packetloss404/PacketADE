import type { TaskType } from "./flight";

export interface TicketCandidate {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  labels: string[];
  acceptanceCriteria: string[];
  selected: boolean;
}

// === Flight Plan (from spec import) ===

export interface FlightPlanTaskCandidate {
  title: string;
  description: string;
  type: TaskType;
  dependsOn: string[]; // positional refs: "m0-t0"
  selected: boolean;   // added client-side for toggle UI
}

export interface FlightPlanMilestoneCandidate {
  title: string;
  description: string;
  validationCriteria: string[];
  tasks: FlightPlanTaskCandidate[];
  selected: boolean;
}

export interface FlightPlanCandidate {
  title: string;
  objective: string;
  priority: "low" | "medium" | "high" | "critical";
  milestones: FlightPlanMilestoneCandidate[];
}
