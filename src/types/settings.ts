export type SettingsSection =
  | "general"
  | "workspace"
  | "agents"
  | "packet-agent"
  | "providers"
  | "routing"
  | "memory"
  | "flights"
  | "github"
  | "issues"
  | "servers"
  | "mcp"
  | "project-rules"
  | "modules"
  | "dictation"
  | "advanced";

/**
 * Narrow, typed Settings deep link. `cliId` is meaningful only for the Agents
 * section and lets recovery affordances reveal the matching CLI card.
 */
export interface SettingsTarget {
  section: SettingsSection;
  cliId?: string;
}
