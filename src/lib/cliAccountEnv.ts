/**
 * Turns a selected `CliAccount` into the environment a PTY session is spawned
 * with. This is the entire multi-account mechanism — there is no credential
 * shuffling, no file copying, no login juggling: the CLI reads one env var and
 * relocates its whole state root.
 *
 *   claude-code → `CLAUDE_CONFIG_DIR=<configDir>`
 *   codex       → `CODEX_HOME=<configDir>`
 *
 * No account ⇒ `{}` ⇒ the CLI uses its own default dir ⇒ today's exact
 * behaviour. Callers merge the result into the env object they already build,
 * so `{}` is a genuine no-op rather than a special case.
 *
 * NOTE (macOS, unresolved upstream): whether the Claude CLI namespaces its
 * Keychain entry per config dir is unconfirmed — binary analysis suggests a
 * `sha256(configDir)` suffix, while anthropics/claude-code#20553 says
 * otherwise. Codex IS confirmed namespaced. This is documented, not solved,
 * and is not a reason to hold back Linux/Windows support.
 */
import { CLI_ACCOUNT_ENV_VAR, isCliAccountCli } from "@/types/cliAccount";
import type { CliAccount } from "@/types/cliAccount";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { WorkspaceAgentSlot } from "@/types/workspace";

/**
 * Env fragment for one account. Returns `{}` for a missing account — the
 * caller's spawn env is then unchanged and the ambient login is used.
 */
export function cliAccountEnv(account: CliAccount | undefined | null): Record<string, string> {
  if (!account) return {};
  const key = CLI_ACCOUNT_ENV_VAR[account.cli];
  // Guard against a persisted record with an unknown `cli` (forward compat).
  if (!key) return {};
  if (!account.configDir) return {};
  return { [key]: account.configDir };
}

/**
 * Env fragment for a workspace pane: resolves `accountId` through the store
 * and applies it only if it is meaningful for `slot`.
 *
 * Returns `{}` when:
 *   - `slot` is not an account-capable CLI (`terminal`, `opencode`, …);
 *   - no `accountId` was selected (ambient login);
 *   - the id no longer resolves to a record;
 *   - the record belongs to the *other* CLI — its env var is not the one this
 *     slot's binary reads, so honouring it would be a silent no-op anyway.
 *
 * `{}` here means "ambient login". Callers that must NOT fall back to the
 * ambient login when an account was explicitly selected (i.e. the launch path)
 * are expected to gate on the auth probe before spawning, not to infer intent
 * from an empty env.
 */
export function accountEnvForSlot(
  slot: WorkspaceAgentSlot,
  accountId?: string | null,
): Record<string, string> {
  if (!isCliAccountCli(slot)) return {};
  if (!accountId) return {};
  const account = useCliAccountStore.getState().getAccount(accountId);
  if (!account) return {};
  if (account.cli !== slot) return {};
  return cliAccountEnv(account);
}
