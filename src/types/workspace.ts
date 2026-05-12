export type WorkspaceAgentSlot = "terminal" | "claude-code" | "codex" | "gemini" | "opencode" | "packetcode";

export interface WorkspacePane {
  id: string;
  agentId: WorkspaceAgentSlot;
  sessionId: string | null;
  gridPosition?: { row: number; col: number };
  accentColor?: string; // tailwind color token, e.g. "accent-green", "accent-blue", "accent-amber", "accent-purple", "accent-red"
  pinnedCommands?: string[]; // max 5 saved commands
}

export interface Workspace {
  id: string;
  name: string;
  agents: WorkspaceAgentSlot[];
  panes: WorkspacePane[];
  projectPath: string;
  prompt?: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  bypassPermissions?: boolean;
  modelOverrides?: Record<string, string | null>;
  effortOverrides?: Record<string, string | null>;
  serverId?: string;
  remoteProjectPath?: string;
}
