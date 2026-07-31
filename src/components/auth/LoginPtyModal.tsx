import { KeyRound } from "lucide-react";
import { TransientPtyModal } from "@/components/ui/TransientPtyModal";

interface LoginPtyModalProps {
  /** Which CLI's `login` subcommand to spawn. */
  cli: "claude" | "codex";
  projectPath?: string;
  /**
   * Multi-account: the env that binds this login to ONE account's config dir
   * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Built by `accountEnvForSlot`.
   * Omitted (or `{}`) means the ambient login — today's behaviour.
   */
  env?: Record<string, string>;
  /** Account label to name in the dialog title, when this is a bound login. */
  accountLabel?: string;
  onClose: () => void;
}

const CLI_LABEL: Record<LoginPtyModalProps["cli"], string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function LoginPtyModal({
  cli,
  projectPath,
  env,
  accountLabel,
  onClose,
}: LoginPtyModalProps) {
  const title = accountLabel
    ? `Log in to ${accountLabel} (${CLI_LABEL[cli]})`
    : `Sign in to ${CLI_LABEL[cli]}`;
  return (
    <TransientPtyModal
      title={title}
      icon={<KeyRound size={14} className="text-accent-green" />}
      command={cli}
      args={["login"]}
      projectPath={projectPath}
      env={env}
      onClose={onClose}
      interactive
      doneMessage={
        accountLabel
          ? `Login flow completed. Credentials were written to the "${accountLabel}" config dir.`
          : "Login flow completed."
      }
      runningMessage="Awaiting CLI exit…"
      errorMessage={`Login flow ended. Make sure '${cli}' is installed and on your PATH.`}
    />
  );
}
