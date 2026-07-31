export type WorkspaceAgentSlot = "terminal" | "claude-code" | "codex" | "opencode" | "packetcode";

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
  /**
   * Multi-account CLI support: the `CliAccount.id` this pane launches under.
   * Absent ⇒ ambient login — exactly today's behaviour, and what an old cache
   * or an old binary that never wrote the field degrades to. Only meaningful
   * for the `claude-code` / `codex` slots; the runtime translates it into
   * `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Same inert `#[serde(default)]`
   * round-trip pattern as `kind`/`conversationId`.
   */
  accountId?: string;
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
  /**
   * Tile program (P1-S2): origin marker for auto-materialized conversation
   * wrappers. `"conversation"` tags a workspace created by
   * `sessionGlue.openSession` (deterministic id `ws-wrap-<convId>`) to wrap a
   * standalone conversation; absent for normal user-created workspaces. Round-
   * trips through the DTO via the same `#[serde(default)]` inert pattern as the
   * pane-level `kind`/`conversationId`, so an old binary that drops it degrades
   * cleanly. The reconciliation sweep uses it to identify orphaned wrappers
   * whose conversation pane was stripped by an old-binary re-save.
   */
  origin?: "conversation";
}
