/**
 * Install hint URLs for the supported AI CLIs.
 *
 * Kept in a static map (not on AgentConfig) to avoid churning the persisted
 * agent schema for purely UI-side data.
 */

export interface InstallHint {
  label: string;
  url: string;
}

export const INSTALL_HINTS: Record<string, InstallHint> = {
  "claude-code": {
    label: "Install Claude Code",
    url: "https://docs.claude.com/en/docs/claude-code",
  },
  codex: {
    label: "Install Codex CLI",
    url: "https://github.com/openai/codex",
  },
  opencode: {
    label: "Install OpenCode",
    url: "https://opencode.ai",
  },
};
