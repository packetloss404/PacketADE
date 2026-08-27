/**
 * The ONE way to authenticate a specific CLI account.
 *
 * Runs `claude login` / `codex login` with the account's own
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so the credentials land in that account's
 * config dir instead of the ambient one — without this, a second account can
 * never be signed in and the launch gate would block its panes forever.
 *
 * Shared seam: the blocked-pane "Log in to <label>" action (WorkspacePane) and
 * the accounts list in Settings (`CliAccountsCard`) both render this, so there
 * is exactly one place that knows how to bind a login to an account.
 *
 * Before the PTY starts, the config dir is seeded from the ambient dir. Those
 * env vars relocate the CLI's ENTIRE state root, so an unseeded account starts
 * with no statusline hook and none of the MCP servers PacketBench writes into
 * `~/.claude/settings.json`: the pane's status bar goes blank and its tools go
 * missing, with nothing on screen to explain why. Seeding is best-effort and
 * never blocks the login — a failed copy costs configuration, not access.
 */
import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { LoginPtyModal } from "@/components/auth/LoginPtyModal";
import { cliAccountEnv } from "@/lib/cliAccountEnv";
import { defaultConfigDirFor } from "@/lib/cliAccountPaths";
import { seedCliAccountConfigDir } from "@/lib/tauri";
import type { CliAccount } from "@/types/cliAccount";

interface AccountLoginModalProps {
  account: CliAccount;
  /** Optional cwd for the login PTY. */
  projectPath?: string;
  /** Called when the modal closes — a good place to re-probe auth status. */
  onClose: () => void;
}

/** `CliAccount.cli` → the binary whose `login` subcommand we spawn. */
const LOGIN_CLI: Record<CliAccount["cli"], "claude" | "codex"> = {
  "claude-code": "claude",
  codex: "codex",
};

export function AccountLoginModal({ account, projectPath, onClose }: AccountLoginModalProps) {
  // Hold the PTY until seeding settles. Mounting TransientPtyModal starts the
  // login immediately, and the CLI reads its settings at startup — seeding
  // afterwards would land a turn too late.
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const finish = () => {
      if (!cancelled) setSeeded(true);
    };
    void homeDir()
      .then((home) =>
        seedCliAccountConfigDir(
          defaultConfigDirFor(account.cli, home.replace(/[\\/]+$/, "")),
          account.configDir,
        ),
      )
      .then(finish)
      .catch((err) => {
        // Non-fatal by design: the user came here to log in. Losing the
        // statusline/MCP carry-over is a degraded pane, not a blocked one.
        console.warn("[AccountLoginModal] config-dir seeding failed", err);
        finish();
      });
    return () => {
      cancelled = true;
    };
  }, [account.cli, account.configDir]);

  if (!seeded) return null;

  return (
    <LoginPtyModal
      cli={LOGIN_CLI[account.cli]}
      projectPath={projectPath}
      env={cliAccountEnv(account)}
      accountLabel={account.label}
      onClose={onClose}
    />
  );
}
