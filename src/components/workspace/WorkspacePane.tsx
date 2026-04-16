import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Cpu, Terminal, Sparkles, TerminalSquare, GripHorizontal, RotateCcw, Plus, Palette, Pin, Play, X, Maximize2, Minimize2, ChevronDown } from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { TerminalPane, type TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { buildSshArgs } from "@/lib/ssh";
import { writePty } from "@/lib/tauri";
import { getModelsForAgent } from "@/lib/models";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Bot,
  Cpu,
  Terminal,
  Sparkles,
  TerminalSquare,
};

/** Per-agent CLI flag to bypass all permission prompts.
 * OpenCode is intentionally omitted — it has no equivalent launch flag and
 * passing one makes it print `--help` and exit. Permissions are configured
 * inside the OpenCode TUI/config instead. */
const BYPASS_FLAGS: Record<string, string> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  gemini: "--yolo",
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

const ACCENT_OPTIONS = [
  { token: "accent-green", bg: "bg-accent-green", border: "border-accent-green" },
  { token: "accent-blue", bg: "bg-accent-blue", border: "border-accent-blue" },
  { token: "accent-amber", bg: "bg-accent-amber", border: "border-accent-amber" },
  { token: "accent-purple", bg: "bg-accent-purple", border: "border-accent-purple" },
  { token: "accent-red", bg: "bg-accent-red", border: "border-accent-red" },
  { token: "accent-cyan", bg: "bg-accent-cyan", border: "border-accent-cyan" },
];

/** Map accent token to tailwind text color class. */
const ACCENT_TEXT: Record<string, string> = {
  "accent-green": "text-accent-green",
  "accent-blue": "text-accent-blue",
  "accent-amber": "text-accent-amber",
  "accent-purple": "text-accent-purple",
  "accent-red": "text-accent-red",
  "accent-cyan": "text-accent-cyan",
};

/** Map accent token to tailwind bg tint class (5% opacity). */
const ACCENT_BG_TINT: Record<string, string> = {
  "accent-green": "bg-accent-green/5",
  "accent-blue": "bg-accent-blue/5",
  "accent-amber": "bg-accent-amber/5",
  "accent-purple": "bg-accent-purple/5",
  "accent-red": "bg-accent-red/5",
  "accent-cyan": "bg-accent-cyan/5",
};

/** Map accent token to tailwind left border class. */
const ACCENT_BORDER: Record<string, string> = {
  "accent-green": "border-l-2 border-l-accent-green",
  "accent-blue": "border-l-2 border-l-accent-blue",
  "accent-amber": "border-l-2 border-l-accent-amber",
  "accent-purple": "border-l-2 border-l-accent-purple",
  "accent-red": "border-l-2 border-l-accent-red",
  "accent-cyan": "border-l-2 border-l-accent-cyan",
};

interface WorkspacePaneProps {
  pane: WorkspacePaneType;
  workspaceId: string;
}

export function WorkspacePane({ pane, workspaceId }: WorkspacePaneProps) {
  const agents = useAgentStore((s) => s.agents);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const isZoomed = zoomedPaneId === pane.id;
  const agentConfig = agents.find((a) => a.id === pane.agentId);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const [showPinPopover, setShowPinPopover] = useState(false);
  const [newPinCmd, setNewPinCmd] = useState("");
  const pinPopoverRef = useRef<HTMLDivElement>(null);

  // Close pin popover on outside click
  useEffect(() => {
    if (!showPinPopover) return;
    const handler = (e: MouseEvent) => {
      if (pinPopoverRef.current && !pinPopoverRef.current.contains(e.target as Node)) {
        setShowPinPopover(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPinPopover]);

  // Close model picker on outside click
  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelPicker]);

  const pinnedCommands = pane.pinnedCommands ?? [];

  const runCommand = useCallback((cmd: string) => {
    if (pane.sessionId) {
      writePty(pane.sessionId, cmd + "\r");
    }
  }, [pane.sessionId]);

  // Reach the mosaic drag source from the surrounding MosaicWindow so the
  // unified header bar acts as the drag handle for reordering tiles.
  // Context may be null when pane is rendered outside Mosaic (e.g. zoomed overlay).
  const mosaicCtx = useContext(MosaicWindowContext);
  const mosaicWindowActions = mosaicCtx?.mosaicWindowActions ?? null;

  const agentName = agentConfig?.name ?? pane.agentId;
  const iconName = agentConfig?.icon ?? "Terminal";
  const Icon = ICON_MAP[iconName] ?? Terminal;
  const command = agentConfig?.command ?? pane.agentId;

  // Keep CLI args stable so terminal startup is only driven by real config changes.
  const bypassPermissions = workspace?.bypassPermissions ?? false;
  const model = workspace?.modelOverrides?.[pane.agentId] ?? null;
  const effort = workspace?.effortOverrides?.[pane.agentId] ?? null;
  const initialPrompt =
    pane.agentId !== "terminal" ? workspace?.prompt : undefined;

  // Model selection
  const availableModels = useMemo(() => getModelsForAgent(pane.agentId), [pane.agentId]);
  const hasModelOptions = availableModels.length > 0 && pane.agentId !== "terminal";
  const modelLabel = model
    ? availableModels.find((m) => m.value === model)?.label ?? model
    : "Default";

  const cliArgs: string[] | undefined = useMemo(() => {
    const args: string[] = [];

    // Include agent-specific default args (e.g., opencode needs "." to start TUI)
    if (agentConfig?.defaultArgs?.length) {
      args.push(...agentConfig.defaultArgs);
    }

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
  }, [agentConfig?.defaultArgs, bypassPermissions, effort, model, pane.agentId]);

  // SSH override for remote workspaces
  const server = workspace?.serverId
    ? useServerStore.getState().getServer(workspace.serverId)
    : undefined;
  const isRemote = !!server;
  const effectiveCommand = isRemote ? "ssh" : command;
  const effectiveArgs = useMemo(() => {
    if (!isRemote || !server) return cliArgs;
    return buildSshArgs(
      server,
      workspace?.remoteProjectPath ?? server.remotePath ?? "",
      command,
      cliArgs,
    );
  }, [isRemote, server, command, cliArgs, workspace?.remoteProjectPath]);

  // Accent color derivations
  const accent = pane.accentColor ?? "accent-green";
  const accentTextClass = ACCENT_TEXT[accent] ?? "text-text-secondary";
  const accentBgTint = ACCENT_BG_TINT[accent] ?? "";
  const accentBorderClass = ACCENT_BORDER[accent] ?? "";

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
        <div
          className={`flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border cursor-grab active:cursor-grabbing select-none ${accentBgTint}`}
          onDoubleClick={() => setZoomedPane(isZoomed ? null : pane.id)}
        >
          <GripHorizontal size={11} className="text-text-muted shrink-0" />
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
          <Icon size={11} className={`${accentTextClass} shrink-0`} />
          <span className={`text-[10px] font-medium truncate ${accentTextClass}`}>{agentName}</span>
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full text-white font-medium shrink-0"
            style={{ backgroundColor: pillColor }}
          >
            {pillLabel}
          </span>
          {agentConfig && !agentConfig.installed && (
            <span className="text-[9px] text-accent-amber">not installed</span>
          )}
          {hasModelOptions && (
            <div ref={modelPickerRef} className="relative shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowModelPicker(!showModelPicker);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={`flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full border transition-colors ${
                  model
                    ? "border-accent-green/40 text-accent-green bg-accent-green/10 hover:bg-accent-green/20"
                    : "border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted"
                }`}
                title="Change model (applies on next session)"
              >
                {modelLabel}
                <ChevronDown size={8} className={`transition-transform ${showModelPicker ? "rotate-180" : ""}`} />
              </button>
              {showModelPicker && (
                <div className="absolute top-full mt-1 left-0 z-50 min-w-[140px] bg-bg-elevated border border-bg-border rounded-md shadow-xl py-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      useWorkspaceStore.getState().setModelOverride(workspaceId, pane.agentId, null);
                      setShowModelPicker(false);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-bg-hover transition-colors ${
                      !model ? "text-accent-green font-medium" : "text-text-primary"
                    }`}
                  >
                    Default
                  </button>
                  {availableModels.map((m) => (
                    <button
                      key={m.value}
                      onClick={(e) => {
                        e.stopPropagation();
                        useWorkspaceStore.getState().setModelOverride(workspaceId, pane.agentId, m.value);
                        setShowModelPicker(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-bg-hover transition-colors ${
                        model === m.value ? "text-accent-green font-medium" : "text-text-primary"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                  <div className="border-t border-bg-border mt-1 pt-1 px-3 py-1">
                    <span className="text-[9px] text-text-muted">Takes effect on next session</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex-1" />
          {/* Color picker button */}
          <div className="relative shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowColorPicker((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
              title="Change accent color"
            >
              <Palette size={11} />
            </button>
            {showColorPicker && (
              <div
                className="absolute right-0 top-full mt-1 z-50 flex items-center gap-1 px-2 py-1.5 bg-bg-tertiary border border-bg-border rounded-md shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {ACCENT_OPTIONS.map((opt) => (
                  <button
                    key={opt.token}
                    onClick={(e) => {
                      e.stopPropagation();
                      useWorkspaceStore.getState().updatePane(workspaceId, pane.id, { accentColor: opt.token });
                      setShowColorPicker(false);
                    }}
                    className={`w-4 h-4 rounded-full ${opt.bg} transition-transform hover:scale-125 ${accent === opt.token ? `ring-2 ring-offset-1 ring-offset-bg-tertiary ${opt.border}` : ""}`}
                    title={opt.token}
                  />
                ))}
              </div>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowPinPopover((v) => !v);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`p-0.5 transition-colors shrink-0 ${pinnedCommands.length > 0 ? "text-accent-blue" : "text-text-muted"} hover:text-accent-blue`}
            title="Pinned commands"
          >
            <Pin size={11} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setZoomedPane(isZoomed ? null : pane.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-0.5 text-text-muted hover:text-accent-blue transition-colors shrink-0"
            title={isZoomed ? "Exit zoom (Esc)" : "Zoom to focus"}
          >
            {isZoomed ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
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
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (state.alive) state.onKill();
              useWorkspaceStore.getState().removePane(workspaceId, pane.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-0.5 text-text-muted hover:text-accent-red transition-colors shrink-0"
            title="Close pane"
          >
            <X size={11} />
          </button>
        </div>
      );

      const pinPopover = showPinPopover ? (
        <div
          ref={pinPopoverRef}
          className="absolute right-1 top-full z-50 mt-0.5 w-64 bg-bg-primary border border-bg-border rounded shadow-lg"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="p-2 space-y-1.5">
            <div className="text-[10px] text-text-muted font-medium uppercase tracking-wider">
              Pinned Commands ({pinnedCommands.length}/5)
            </div>
            {pinnedCommands.map((cmd, i) => (
              <div key={i} className="flex items-center gap-1 group">
                <span className="flex-1 text-[11px] text-text-secondary truncate" title={cmd}>
                  {cmd}
                </span>
                <button
                  onClick={() => {
                    runCommand(cmd);
                    setShowPinPopover(false);
                  }}
                  className="p-0.5 text-text-muted hover:text-accent-green transition-colors shrink-0"
                  title="Run"
                  disabled={!pane.sessionId}
                >
                  <Play size={10} />
                </button>
                <button
                  onClick={() =>
                    useWorkspaceStore.getState().removePinnedCommand(workspaceId, pane.id, i)
                  }
                  className="p-0.5 text-text-muted hover:text-accent-red transition-colors shrink-0"
                  title="Remove"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {pinnedCommands.length < 5 && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newPinCmd.trim()) {
                    useWorkspaceStore.getState().addPinnedCommand(workspaceId, pane.id, newPinCmd);
                    setNewPinCmd("");
                  }
                }}
                className="flex items-center gap-1 pt-1 border-t border-bg-border"
              >
                <input
                  type="text"
                  value={newPinCmd}
                  onChange={(e) => setNewPinCmd(e.target.value)}
                  placeholder="Add command..."
                  className="flex-1 text-[11px] bg-bg-secondary text-text-primary px-1.5 py-0.5 rounded border border-bg-border focus:outline-none focus:border-accent-blue"
                />
                <button
                  type="submit"
                  className="p-0.5 text-text-muted hover:text-accent-green transition-colors shrink-0"
                  title="Add"
                >
                  <Plus size={10} />
                </button>
              </form>
            )}
          </div>
        </div>
      ) : null;

      const quickBar =
        pinnedCommands.length > 0 ? (
          <div className="flex gap-1 px-2 py-1 border-b border-bg-border bg-bg-secondary/50 overflow-x-auto">
            {pinnedCommands.map((cmd, i) => (
              <button
                key={i}
                onClick={() => runCommand(cmd)}
                disabled={!pane.sessionId}
                className="px-2 py-0.5 text-[9px] bg-bg-hover rounded text-text-secondary hover:text-text-primary truncate max-w-[120px] disabled:opacity-40"
                title={cmd}
              >
                {cmd}
              </button>
            ))}
          </div>
        ) : null;

      const fullHeader = (
        <div className="relative">
          {headerContent}
          {pinPopover}
          {quickBar}
        </div>
      );

      // Wire the bar as the mosaic drag source so users can drag it to reorder tiles.
      return mosaicWindowActions?.connectDragSource(fullHeader) ?? fullHeader;
    },
    [Icon, accentTextClass, accentBgTint, accent, agentConfig, agentName, mosaicWindowActions, isZoomed, setZoomedPane, pane.id, pane.agentId, hasModelOptions, model, modelLabel, availableModels, showModelPicker, showColorPicker, workspaceId, pinnedCommands, showPinPopover, newPinCmd, runCommand, pane.sessionId],
  );

  return (
    <div className={`h-full flex flex-col ${accentBorderClass}`}>
      <TerminalPane
        paneId={pane.id}
        cliCommand={effectiveCommand}
        cliArgs={effectiveArgs}
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
    </div>
  );
}
