import { Check, AlertCircle, Loader2 } from "lucide-react";
import type { AgentConfig } from "@/types/agent";
import { INSTALL_HINTS } from "@/lib/agent-install-hints";

interface AgentDetectionListProps {
  agents: AgentConfig[];
  detecting: boolean;
  /** When supplied, render checkboxes for selectable agents. */
  selectedIds?: Set<string>;
  onToggle?: (id: string) => void;
  showInstallHints?: boolean;
}

export function AgentDetectionList({
  agents,
  detecting,
  selectedIds,
  onToggle,
  showInstallHints = false,
}: AgentDetectionListProps) {
  // Show only the four AI CLIs (skip the bare terminal slot).
  const aiAgents = agents.filter((a) => a.isBuiltin && a.id !== "terminal");
  const selectable = !!selectedIds && !!onToggle;

  return (
    <div className="flex flex-col gap-1">
      {aiAgents.map((agent) => {
        const installed = !!agent.installed;
        const checked = selectedIds?.has(agent.id) ?? false;
        const canSelect = selectable && installed;
        const hint = INSTALL_HINTS[agent.id];

        const handleClick = () => {
          if (!canSelect) return;
          onToggle?.(agent.id);
        };

        return (
          <div
            key={agent.id}
            className={`flex items-center gap-2 px-2.5 py-1.5 bg-bg-secondary border border-bg-border rounded ${
              canSelect ? "cursor-pointer hover:border-accent-green/30" : ""
            } ${selectable && !installed ? "opacity-60" : ""}`}
            onClick={handleClick}
          >
            {selectable && (
              <div
                className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                  checked && installed
                    ? "bg-accent-green border-accent-green"
                    : "border-bg-border"
                }`}
              >
                {checked && installed && <Check size={8} className="text-bg-primary" />}
              </div>
            )}

            <span className="text-[11px] text-text-primary flex-1 truncate">{agent.name}</span>

            {detecting ? (
              <span className="flex items-center gap-1 text-[10px] text-text-muted">
                <Loader2 size={10} className="animate-spin" />
                Checking…
              </span>
            ) : installed ? (
              <span className="flex items-center gap-1 text-[10px] text-accent-green">
                <Check size={10} />
                Installed
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-accent-amber">
                <AlertCircle size={10} />
                Not found
              </span>
            )}

            {showInstallHints && !installed && !detecting && hint && (
              <a
                href={hint.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] text-accent-amber underline opacity-80 hover:opacity-100"
                title={hint.label}
              >
                install
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
