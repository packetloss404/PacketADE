import { useFlightStore } from "@/stores/flightStore";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { ISSUE_STATUS_LABELS } from "@/lib/flight-colors";
import type { Flight } from "@/types/flight";
import type { WorkspaceAgentSlot } from "@/types/workspace";

const AGENT_SLOT_MAP: Record<string, WorkspaceAgentSlot> = {
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

export interface LaunchWorkspaceResult {
  workspaceId: string;
  reused: boolean;
}

/**
 * Launch (or open) a workspace tied to a flight.
 *
 * Fixes the previous flow's two bugs:
 *  1. flightId is now passed through createWorkspace so it persists via commitWorkspaces.
 *  2. flight.projectPath falls back to the global project path when empty,
 *     and the resolved value is written back onto the flight so subsequent
 *     launches stay consistent.
 */
export function launchWorkspaceFromFlight(flight: Flight): LaunchWorkspaceResult {
  const { workspaces, setActiveWorkspace, createWorkspace } = useWorkspaceStore.getState();

  // Reuse an existing linked workspace if one exists.
  const linked = workspaces.find(
    (w) => w.flightId === flight.id && w.status === "active"
  );
  if (linked) {
    setActiveWorkspace(linked.id);
    useAppStore.getState().setActiveView("workspace");
    return { workspaceId: linked.id, reused: true };
  }

  // Resolve project path with fallback to current global path.
  const fallbackPath = useLayoutStore.getState().projectPath;
  const projectPath = flight.projectPath || fallbackPath;
  if (projectPath && projectPath !== flight.projectPath) {
    useFlightStore.getState().updateFlight(flight.id, { projectPath });
  }

  // Derive agents from task assignments, deduplicated.
  const taskAgents = new Set<string>();
  for (const milestone of flight.milestones) {
    for (const task of milestone.tasks) {
      if (task.agentConfigId) taskAgents.add(task.agentConfigId);
    }
  }

  const agents: WorkspaceAgentSlot[] = [];
  for (const agentId of taskAgents) {
    const slot = AGENT_SLOT_MAP[agentId];
    if (slot && !agents.includes(slot)) agents.push(slot);
  }
  if (agents.length === 0) agents.push("claude-code");

  // Build a context prompt from the flight + linked issues.
  const issues = useIssueStore.getState().issues;
  const linkedIssues = issues.filter((i) => flight.issueIds.includes(i.id));
  const lines: string[] = [];
  lines.push(`Work on this flight:`);
  lines.push(``);
  lines.push(`## ${flight.title}`);
  if (flight.objective) {
    lines.push(``);
    lines.push(flight.objective);
  }
  lines.push(``);
  lines.push(`Priority: ${flight.priority}`);
  if (linkedIssues.length > 0) {
    lines.push(``);
    lines.push(`### Linked Issues (${linkedIssues.length})`);
    for (const issue of linkedIssues) {
      const statusStr = ISSUE_STATUS_LABELS[issue.status];
      lines.push(``);
      lines.push(`- **${issue.ticketId}: ${issue.title}** [${statusStr}]`);
      if (issue.description) lines.push(`  ${issue.description}`);
      const criteria = issue.acceptanceCriteria;
      if (criteria?.length) {
        for (const c of criteria) {
          lines.push(`  - [${c.checked ? "x" : " "}] ${c.text}`);
        }
      }
    }
  }

  const wsId = createWorkspace(
    flight.title,
    agents,
    projectPath,
    {
      prompt: lines.join("\n"),
      flightId: flight.id,
    },
  );

  setActiveWorkspace(wsId);
  useAppStore.getState().setActiveView("workspace");
  return { workspaceId: wsId, reused: false };
}
