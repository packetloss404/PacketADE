export type WorkspaceAgentSlot = "terminal" | "claude-code" | "codex" | "gemini" | "opencode" | "packetcode";

export interface WorkspacePane {
  id: string;
  agentId: WorkspaceAgentSlot;
  sessionId: string | null;
  gridPosition?: { row: number; col: number };
  pinnedCommands?: string[]; // max 5 saved commands
  /**
   * Pane kind discriminant (tile program, P1-S1). Absent ⇒ terminal — an old
   * cache or an old binary that never wrote this field degrades to a plain
   * terminal pane. `kind` is the SOLE discriminant; `agentId` is never
   * overloaded with "conversation". Conversation panes persist the inert
   * carrier `agentId: "terminal"` so a downgraded binary renders a harmless
   * terminal pane (its `From<String>` catch-all never sees "conversation").
   */
  kind?: "terminal" | "conversation";
  /**
   * Set iff `kind === "conversation"`. Points at the owning AgentConversation
   * (reference direction is pane→conversationId only). Enforced by
   * `normalizePanes`: a conversation pane whose id was stripped self-heals to a
   * terminal pane.
   */
  conversationId?: string;
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
