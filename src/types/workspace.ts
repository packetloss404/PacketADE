export type WorkspaceAgentSlot = "terminal" | "claude-code" | "codex" | "gemini" | "opencode";

export interface WorkspacePane {
  id: string;
  agentId: WorkspaceAgentSlot;
  sessionId: string | null;
  gridPosition: { row: number; col: number };
}

export interface Workspace {
  id: string;
  name: string;
  agents: WorkspaceAgentSlot[];
  panes: WorkspacePane[];
  projectPath: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  bypassPermissions?: boolean;
  effortOverrides?: Record<string, string | null>;
}
