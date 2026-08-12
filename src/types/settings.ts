export type SettingsSection =
  | "general"
  | "workspace"
  | "cli-clients"
  | "cli-accounts"
  | "agents"
  | "packet-agent"
  | "providers"
  | "routing"
  | "memory"
  | "flights"
  | "github"
  | "issues"
  | "servers"
  | "syndicate-machines"
  | "mcp"
  | "project-rules"
  | "modules"
  | "dictation"
  | "advanced";

export type SettingsGroup =
  | "general"
  | "workspaces-terminal"
  | "agents-models"
  | "automation"
  | "integrations-data"
  | "security-diagnostics";

export type SettingsScope =
  | "App"
  | "Project"
  | "Workspace"
  | "New sessions"
  | "New conversations"
  | "New Flights";

/**
 * Narrow, typed Settings deep link. `cliId` is meaningful only for the CLI
 * Clients section and lets recovery affordances reveal the matching CLI card.
 * Older callers that send `{ section: "agents", cliId }` are normalized by
 * the Settings navigation layer for compatibility.
 */
export interface SettingsTarget {
  section: SettingsSection;
  cliId?: string;
}
