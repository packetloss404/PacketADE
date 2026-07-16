import { KeyRound } from "lucide-react";
import { TransientPtyModal } from "@/components/ui/TransientPtyModal";

interface LoginPtyModalProps {
  /** Which CLI's `login` subcommand to spawn. */
  cli: "claude" | "codex";
  projectPath?: string;
  onClose: () => void;
}

const CLI_LABEL: Record<LoginPtyModalProps["cli"], string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function LoginPtyModal({ cli, projectPath, onClose }: LoginPtyModalProps) {
  return (
    <TransientPtyModal
      title={`Sign in to ${CLI_LABEL[cli]}`}
      icon={<KeyRound size={14} className="text-accent-green" />}
      command={cli}
      args={["login"]}
      projectPath={projectPath}
      onClose={onClose}
      interactive
      doneMessage="Login flow completed."
      runningMessage="Awaiting CLI exit…"
      errorMessage={`Login flow ended. Make sure '${cli}' is installed and on your PATH.`}
    />
  );
}
