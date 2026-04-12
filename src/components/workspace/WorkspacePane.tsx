import { useCallback, useContext, useMemo } from "react";
import { Bot, Cpu, Terminal, Sparkles, TerminalSquare, GripHorizontal, RotateCcw, Plus } from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { TerminalPane, type TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Bot,
  Cpu,
  Terminal,
  Sparkles,
  TerminalSquare,
};

/** Per-agent CLI flag to bypass all permission prompts. */
const BYPASS_FLAGS: Record<string, string> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  gemini: "--yolo",
  opencode: "--dangerously-skip-permissions",
};

const CLI_PILL_COLOR: Record<string, string> = {
  claude: "#f0b400",
  gemini: "#8ab4f8",
  opencode: "#3fb950",
  codex: "#58a6ff",
};

const CLI_PILL_LABEL: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  opencode: "OpenCode",
  codex: "Codex",
};

interface WorkspacePaneProps {
  pane: WorkspacePaneType;
  workspaceId: string;
}

export function WorkspacePane({ pane, workspaceId }: WorkspacePaneProps) {
  const agents = useAgentStore((s) => s.agents);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const agentConfig = agents.find((a) => a.id === pane.agentId);

  // Reach the mosaic drag source from the surrounding MosaicWindow so the
  // unified header bar acts as the drag handle for reordering tiles.
  const { mosaicWindowActions } = useContext(MosaicWindowContext);

  const agentName = agentConfig?.name ?? pane.agentId;
  const agentColor = agentConfig?.color ?? "text-text-secondary";
  const iconName = agentConfig?.icon ?? "Terminal";
  const Icon = ICON_MAP[iconName] ?? Terminal;
  const command = agentConfig?.command ?? pane.agentId;

  // Keep CLI args stable so terminal startup is only driven by real config changes.
  const bypassPermissions = workspace?.bypassPermissions ?? false;
  const model = workspace?.modelOverrides?.[pane.agentId] ?? null;
  const effort = workspace?.effortOverrides?.[pane.agentId] ?? null;
  const initialPrompt =
    pane.agentId !== "terminal" ? workspace?.prompt : undefined;

  const cliArgs: string[] | undefined = useMemo(() => {
    const args: string[] = [];

    if (bypassPermissions) {
      const flag = BYPASS_FLAGS[pane.agentId];
      if (flag) args.push(flag);
    }

    if (model) {
      args.push("--model", model);
    }

    if (effort) {
      args.push("--effort", effort);
    }

    return args.length > 0 ? args : undefined;
  }, [bypassPermissions, effort, model, pane.agentId]);

  // Render the unified header bar — combines drag handle, agent identity,
  // CLI status, and lifecycle controls into a single row.
  const renderHeader = useCallback(
    (state: TerminalHeaderRenderState) => {
      const pillLabel = CLI_PILL_LABEL[state.cliCommand] ?? state.cliCommand;
      const pillColor = CLI_PILL_COLOR[state.cliCommand] ?? "#58a6ff";
      const statusColor = state.showApproval
        ? "bg-accent-amber animate-pulse"
        : state.alive
          ? "bg-accent-green animate-pulse"
          : state.error
            ? "bg-accent-red"
            : "bg-text-muted";

      const headerContent = (
        <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border cursor-grab active:cursor-grabbing select-none">
          <GripHorizontal size={11} className="text-text-muted shrink-0" />
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
          <Icon size={11} className={`${agentColor} shrink-0`} />
          <span className="text-[10px] font-medium text-text-primary truncate">{agentName}</span>
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full text-white font-medium shrink-0"
            style={{ backgroundColor: pillColor }}
          >
            {pillLabel}
          </span>
          {agentConfig && !agentConfig.installed && (
            <span className="text-[9px] text-accent-amber">not installed</span>
          )}
          <div className="flex-1" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              state.onRestart();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-0.5 text-text-muted hover:text-accent-green transition-colors shrink-0"
            title={state.alive ? "Restart session" : "Start session"}
          >
            {state.alive ? <RotateCcw size={11} /> : <Plus size={11} />}
          </button>
        </div>
      );

      // Wire the bar as the mosaic drag source so users can drag it to reorder tiles.
      return mosaicWindowActions?.connectDragSource(headerContent) ?? headerContent;
    },
    [Icon, agentColor, agentConfig, agentName, mosaicWindowActions],
  );

  return (
    <TerminalPane
      paneId={pane.id}
      cliCommand={command}
      cliArgs={cliArgs}
      projectPath={workspace?.projectPath}
      initialPrompt={initialPrompt}
      renderHeader={renderHeader}
      onSessionCreated={(sessionId) =>
        useWorkspaceStore.getState().setPaneSession(workspaceId, pane.id, sessionId)
      }
      onSessionEnded={() =>
        useWorkspaceStore.getState().setPaneSession(workspaceId, pane.id, null)
      }
      showCloseButton={false}
    />
  );
}
