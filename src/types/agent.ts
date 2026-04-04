// === Agent Configuration ===

export type AgentCapability =
  | "code_edit"
  | "code_review"
  | "testing"
  | "research"
  | "shell"
  | "refactor";

export interface AgentStatusPatterns {
  approval: string[];
  thinking: string[];
  toolUse: { pattern: string; tool: string; fileGroup?: number }[];
  idle: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  defaultArgs: string[];
  description: string;
  installed: boolean;
  capabilities: AgentCapability[];
  icon: string;
  color: string;
  statusPatterns: AgentStatusPatterns;
  approvalActions?: {
    approve: string;
    deny: string;
    abort: string;
  };
  isBuiltin: boolean;
}

// === Agent Adapter Interface ===

export interface AgentStateUpdate {
  agentState: "idle" | "thinking" | "tool_use" | "responding" | "approval_needed";
  currentTool?: string | null;
  currentFile?: string | null;
  approvalText?: string | null;
}

export interface AgentAdapter {
  config: AgentConfig;
  buildLaunchArgs(taskDescription: string, model?: string): { command: string; args: string[] };
  formatPrompt(taskDescription: string, context?: string): string;
  parseOutput(data: string): AgentStateUpdate | null;
  approveAction(): string;
  denyAction(): string;
  abortAction(): string;
}

// === Agent Session ===

export interface AgentSession {
  id: string;
  taskId: string;
  flightId: string;
  agentConfigId: string;
  status: "starting" | "running" | "done" | "failed";
  agentState: AgentStateUpdate["agentState"];
  currentTool: string | null;
  currentFile: string | null;
  projectPath: string;
  startedAt: number;
  endedAt?: number;
  cost: number;
}
