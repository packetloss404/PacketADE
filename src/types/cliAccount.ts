/**
 * Multi-account support for the PTY-backed coding CLIs.
 *
 * Both vendors document an environment variable that relocates the CLI's
 * ENTIRE state root — credentials, settings, MCP config, session history:
 *   - claude-code → `CLAUDE_CONFIG_DIR`
 *   - codex       → `CODEX_HOME`
 *
 * A `CliAccount` is therefore nothing but a *named pointer* at one such
 * directory. It holds no secrets: the CLI itself writes the credentials
 * inside `configDir`, and deleting the record never deletes the login.
 *
 * Absence of an account means "ambient login" — the CLI's own default
 * `~/.claude` / `~/.codex` — which is the exact pre-multi-account behaviour.
 * That is why the DEFAULT directory may never be registered as an account:
 * a record shadowing it would give two names to one login.
 *
 * Scope note: this is Workspaces / PTY / CLI sessions only. The Agents
 * surface (the `api-*` sidecar and `LlmProvider` rows) stays single-account
 * by design.
 */

/** The CLIs that support a relocatable config root. */
export type CliAccountCli = "claude-code" | "codex";

export interface CliAccount {
  /** `generateId("acct")`. */
  id: string;
  /** Human label, e.g. "Personal / OSS", "Client work". */
  label: string;
  cli: CliAccountCli;
  /** Absolute path. Never the CLI's default dir — see the module note. */
  configDir: string;
  /** Display only. NEVER used for auth or for matching accounts. */
  email?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** Every CLI that can carry accounts, in display order. */
export const CLI_ACCOUNT_CLIS: readonly CliAccountCli[] = ["claude-code", "codex"];

/** Display names for the two account-capable CLIs. */
export const CLI_ACCOUNT_LABELS: Record<CliAccountCli, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * The env var each CLI reads to relocate its state root. Exported from the
 * type module (not just the env helper) so callers can name the mechanism in
 * user-facing copy without importing the resolution logic.
 */
export const CLI_ACCOUNT_ENV_VAR: Record<CliAccountCli, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/**
 * The directory name, under the user's home, that each CLI uses when no
 * account is selected. Registering an account on one of these is rejected —
 * it IS the ambient login.
 */
export const CLI_ACCOUNT_DEFAULT_DIR_NAME: Record<CliAccountCli, string> = {
  "claude-code": ".claude",
  codex: ".codex",
};

/** Narrows an arbitrary agent slot / string to an account-capable CLI. */
export function isCliAccountCli(value: string | null | undefined): value is CliAccountCli {
  return value === "claude-code" || value === "codex";
}
