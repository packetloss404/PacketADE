import { X, RotateCcw, Plus } from "lucide-react";
import { getAgentColor } from "@/lib/agentColors";

interface TerminalHeaderProps {
  alive: boolean;
  error: string | null;
  showApproval: boolean;
  cliCommand: string;
  onRestart: () => void;
  onKill: () => void;
  onClose?: () => void;
  showCloseButton: boolean;
}

export function TerminalHeader({
  alive,
  error,
  showApproval,
  cliCommand,
  onRestart,
  onKill,
  onClose,
  showCloseButton,
}: TerminalHeaderProps) {
  const c = getAgentColor(cliCommand);
  return (
    <div className="flex items-center justify-between px-3 py-1 bg-bg-secondary border-b border-bg-border">
      <div className="flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full ${
            showApproval
              ? "bg-accent-amber animate-pulse"
              : alive
                ? "bg-accent-green animate-pulse"
                : error
                  ? "bg-accent-red"
                  : "bg-text-muted"
          }`}
        />
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${c.text} ${c.bg} border ${c.border}`}
        >
          {cliCommand === "claude" ? "Claude"
            : cliCommand === "opencode" ? "OpenCode"
            : cliCommand === "packetcode" ? "PacketCode"
            : "Codex"}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {!alive && (
          <button
            onClick={onRestart}
            className="p-1 text-text-muted hover:text-accent-green transition-colors"
            title={`New ${cliCommand.charAt(0).toUpperCase() + cliCommand.slice(1)} session`}
          >
            <Plus size={12} />
          </button>
        )}
        {alive && (
          <button
            onClick={onRestart}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title="Restart session"
          >
            <RotateCcw size={12} />
          </button>
        )}
        {showCloseButton && onClose && (
          <button
            onClick={() => {
              onKill();
              onClose();
            }}
            className="p-1 text-text-muted hover:text-accent-red transition-colors"
            title="Close pane"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
