import { TerminalPane } from "@/components/session/TerminalPane";
import { useAgentStore } from "@/stores/agentStore";
import { Bot, Cpu, Terminal, Sparkles, TerminalSquare } from "lucide-react";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";

const ICON_MAP: Record<string, React.ComponentType<{ size?: number }>> = {
  Bot,
  Cpu,
  Terminal,
  Sparkles,
  TerminalSquare,
};

interface WorkspacePaneProps {
  pane: WorkspacePaneType;
  workspaceId: string;
}

export function WorkspacePane({ pane }: WorkspacePaneProps) {
  const agents = useAgentStore((s) => s.agents);
  const agentConfig = agents.find((a) => a.id === pane.agentId);

  const agentName = agentConfig?.name ?? pane.agentId;
  const agentColor = agentConfig?.color ?? "text-text-secondary";
  const iconName = agentConfig?.icon ?? "Terminal";
  const Icon = ICON_MAP[iconName] ?? Terminal;
  const command = agentConfig?.command ?? pane.agentId;

  return (
    <div className="flex flex-col h-full overflow-hidden border border-bg-border rounded">
      {/* Agent header bar */}
      <div className={`flex items-center gap-1.5 px-2 py-1 bg-bg-tertiary border-b border-bg-border ${agentColor}`}>
        <Icon size={11} />
        <span className="text-[10px] font-medium truncate">{agentName}</span>
        {agentConfig && !agentConfig.installed && (
          <span className="text-[9px] text-text-muted ml-auto">not installed</span>
        )}
      </div>

      {/* Terminal */}
      <div className="flex-1 overflow-hidden">
        <TerminalPane
          paneId={pane.id}
          cliCommand={command}
          showCloseButton={false}
        />
      </div>
    </div>
  );
}
