import { X, RotateCcw, Plus } from "lucide-react";
import { getAgentColor } from "@/lib/agentColors";
import { AccountChip } from "@/components/session/AccountChip";

interface TerminalHeaderProps {
  alive: boolean;
  error: string | null;
  showApproval: boolean;
  cliCommand: string;
  /** Multi-account: the CLI account this session is bound to. Undefined =
   *  ambient login, and nothing extra is rendered. */
  accountId?: string | null;
  onRestart: () => void;
  onKill: () => void | Promise<void>;
  onClose?: () => void;
  showCloseButton: boolean;
}

export function TerminalHeader({
  alive,
  error,
  showApproval,
  cliCommand,
  accountId,
  onRestart,
  onKill,
  onClose,
  showCloseButton,
}: TerminalHeaderProps) {
  const c = getAgentColor(cliCommand);
  return (
    <div className="flex items-center justify-between border-b border-bg-border bg-bg-secondary px-3 py-1">
      <div className="flex items-center gap-2">
        <div
          className={`h-2 w-2 rounded-full ${
            showApproval
              ? "animate-pulse bg-accent-amber"
              : alive
                ? "animate-pulse bg-accent-green"
                : error
                  ? "bg-accent-red"
                  : "bg-text-muted"
          }`}
        />
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${c.text} ${c.bg} border ${c.border}`}
        >
          {cliCommand === "claude"
            ? "Claude"
            : cliCommand === "opencode"
              ? "OpenCode"
              : cliCommand === "packetcode"
                ? "PacketCode"
                : "Codex"}
        </span>
        {/* Sits immediately beside the agent identity so "which CLI" and
            "which login" read as one unit. Renders nothing when ambient. */}
        <AccountChip accountId={accountId} className="max-w-[140px]" />
      </div>
      <div className="flex items-center gap-1">
        {!alive && (
          <button
            onClick={onRestart}
            className="p-1 text-text-muted transition-colors hover:text-accent-green"
            title={`New ${cliCommand.charAt(0).toUpperCase() + cliCommand.slice(1)} session`}
          >
            <Plus size={12} />
          </button>
        )}
        {alive && (
          <button
            onClick={onRestart}
            className="p-1 text-text-muted transition-colors hover:text-text-primary"
            title="Restart session"
          >
            <RotateCcw size={12} />
          </button>
        )}
        {showCloseButton && onClose && (
          <button
            onClick={() => {
              // `onKill` may be asynchronous and may reject — stopping a
              // remote session can fail. Closing regardless would drop the
              // pane while its session kept running, with the rejection
              // unhandled and nothing shown. Keep the pane; its own error
              // surface explains why it is still here.
              void Promise.resolve(onKill())
                .then(() => onClose())
                .catch(() => {});
            }}
            className="p-1 text-text-muted transition-colors hover:text-accent-red"
            title="Close pane"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
