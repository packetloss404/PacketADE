export type WorkspaceAgentSlot = "terminal" | "claude-code" | "codex" | "gemini" | "opencode" | "packetcode";

export interface WorkspacePane {
  id: string;
  agentId: WorkspaceAgentSlot;
  sessionId: string | null;
  gridPosition?: { row: number; col: number };
  accentColor?: string; // tailwind color token, e.g. "accent-green", "accent-blue", "accent-amber", "accent-purple", "accent-red"
  pinnedCommands?: string[]; // max 5 saved commands

  // === Orchestration metadata (Track B migration from layoutStore) ===
  // Set when this pane was spawned by `orchestrationStore.tick()` for a
  // flight task. The fields mirror the legacy `PaneConfig` shape so that
  // `useTerminalSession` can wire `attachSessionToTask` and command/args
  // overrides the same way it did off the mosaic.
  taskId?: string;
  flightId?: string;
  agentConfigId?: string;
  /** Initial prompt to write to the PTY once it spawns; takes precedence over `workspace.prompt`. */
  initialPrompt?: string;
  /** Overrides `agentConfig.command` (and the workspace's CLI resolution) when set. */
  overrideCommand?: string;
  /** Overrides the computed cliArgs (workspace bypass/model/effort flags) when set. */
  overrideArgs?: string[];
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
  /**
   * v0.8-15: auto-bound GitHub repo, derived from `git remote get-url
   * origin` at workspace-creation time. Absent for workspaces whose
   * project path is not a GitHub-backed git repo. Used by the
   * `WorkspaceSidebar` badge and (eventually) the GitHub pane's
   * repo-context picker.
   */
  githubRepo?: { owner: string; repo: string };
}
