export interface PaneConfig {
  id: string;
  sessionId: string | null;
  cliCommand: string;
  cliArgs?: string[];
  initialPrompt?: string;
  projectPath?: string;
  agentConfigId?: string;
  taskId?: string;
  flightId?: string;
  issueId?: string;
}
