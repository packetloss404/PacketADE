import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccountCli } from "@/types/cliAccount";
import type { WorkspaceAgentSlot } from "@/types/workspace";

/**
 * Multi-account CLI support — session-creation resolution helpers.
 *
 * The account selector lives at SESSION-CREATION time (the Add Session picker
 * and the New Workspace modal), never as a Workspace-record field. Panes carry
 * the resolved `accountId`; the runtime turns it into `CLAUDE_CONFIG_DIR` /
 * `CODEX_HOME`.
 *
 * The STICKY DEFAULT is the safety mechanism: a good handful of programmatic
 * `createWorkspace` / `addPane` call sites bypass the modals entirely (issue
 * "send to workspace", the Toolbar quick-launch, Investigation/Quality
 * hand-offs, agent hand-offs). Those must not silently launch under the ambient
 * login when the project already has a remembered account — so resolution lives
 * in `workspaceStore` itself, where every one of those paths funnels through.
 */

/**
 * The only slots that can be bound to an account. `terminal` / `opencode` /
 * `packetcode` have no vendor-documented config-dir env var, so they are
 * unaffected by multi-account entirely.
 */
export const ACCOUNT_AWARE_SLOTS = ["claude-code", "codex"] as const;

export function isAccountAwareSlot(slot: WorkspaceAgentSlot): slot is CliAccountCli {
  return slot === "claude-code" || slot === "codex";
}

/**
 * Resolve the account a new session for `slot` under `projectPath` should launch
 * with, honouring the sticky per-project default.
 *
 * Returns `undefined` for "ambient login" — the pre-multi-account behaviour —
 * which is also what you get for a non-account-aware slot, a blank project path,
 * or a sticky default pointing at an account that has since been deleted (a
 * dangling id must never resurrect as a bogus config dir).
 */
export function resolveAccountId(
  projectPath: string,
  slot: WorkspaceAgentSlot,
): string | undefined {
  if (!isAccountAwareSlot(slot)) return undefined;
  const path = projectPath?.trim();
  if (!path) return undefined;
  const store = useCliAccountStore.getState();
  const remembered = store.defaultFor(path, slot);
  if (!remembered) return undefined;
  const account = store.getAccount(remembered);
  // Guard both existence and CLI agreement: a claude-code sticky default must
  // never resolve to a codex account (e.g. after an id was reused).
  if (!account || account.cli !== slot) return undefined;
  return account.id;
}

/**
 * Persist the user's explicit choice as the project's sticky default. `null`
 * records an explicit "ambient login" so a later launch does not re-apply an
 * older remembered account.
 */
export function rememberAccountChoice(
  projectPath: string,
  slot: WorkspaceAgentSlot,
  accountId: string | null,
): void {
  if (!isAccountAwareSlot(slot)) return;
  const path = projectPath?.trim();
  if (!path) return;
  useCliAccountStore.getState().rememberDefault(path, slot, accountId);
}

/** Display label for a resolved account id — the chip/dropdown caption. */
export function accountLabel(accountId: string | null | undefined): string {
  if (!accountId) return "Ambient login";
  return useCliAccountStore.getState().getAccount(accountId)?.label ?? "Unknown account";
}
