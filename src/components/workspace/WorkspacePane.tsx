import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Cpu,
  Terminal,
  Sparkles,
  TerminalSquare,
  GripHorizontal,
  RotateCcw,
  Plus,
  Palette,
  Pin,
  Play,
  X,
  Maximize2,
  Minimize2,
  ChevronDown,
  BookOpen,
} from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { TerminalPane, type TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
import { usePromptStore } from "@/stores/promptStore";
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

const CLI_PILL_LABEL: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  opencode: "OpenCode",
  codex: "Codex",
  packetcode: "PacketCode",
};

/** Tailwind classes for the agent identity dot (background + glow shadow). */
const AGENT_DOT_CLASS: Record<string, string> = {
  claude: "bg-accent-green shadow-[0_0_8px_var(--color-accent-green,#6fb89a)]",
  codex: "bg-accent-amber shadow-[0_0_8px_var(--color-accent-amber,#d4b25c)]",
  gemini: "bg-accent-blue shadow-[0_0_8px_var(--color-accent-blue,#6b9ed9)]",
  opencode: "bg-accent-purple shadow-[0_0_8px_var(--color-accent-purple,#a89ad9)]",
  packetcode: "bg-accent-purple shadow-[0_0_8px_var(--color-accent-purple,#a89ad9)]",
};

const AGENT_TEXT_CLASS: Record<string, string> = {
  claude: "text-accent-green",
  codex: "text-accent-amber",
  gemini: "text-accent-blue",
  opencode: "text-accent-purple",
  packetcode: "text-accent-purple",
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
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const isZoomed = zoomedPaneId === pane.id;
  const isFocused = activePaneId === pane.id;
  const agentConfig = agents.find((a) => a.id === pane.agentId);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const [showPinPopover, setShowPinPopover] = useState(false);
  const [newPinCmd, setNewPinCmd] = useState("");
  const pinPopoverRef = useRef<HTMLDivElement>(null);
  // Prompt-template dropdown — paste-affordance for sending a saved
  // template body to this pane's PTY. Replaces the Toolbar Prompts modal
  // for the "I want to inject a prompt here" flow.
  const [showPromptMenu, setShowPromptMenu] = useState(false);
  const promptMenuRef = useRef<HTMLDivElement>(null);
  const promptTemplates = usePromptStore((s) => s.templates);

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

  // Close prompt-template menu on outside click
  useEffect(() => {
    if (!showPromptMenu) return;
    const handler = (e: MouseEvent) => {
      if (promptMenuRef.current && !promptMenuRef.current.contains(e.target as Node)) {
        setShowPromptMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPromptMenu]);

  const pinnedCommands = useMemo(() => pane.pinnedCommands ?? [], [pane.pinnedCommands]);

  const runCommand = useCallback(
    (cmd: string) => {
      if (pane.sessionId) {
        writePty(pane.sessionId, cmd + "\r");
      }
    },
    [pane.sessionId],
  );

  // Paste a prompt template's body into this pane's PTY. Mirrors the
  // pre-overhaul Prompt Library "Send to Terminal" affordance, scoped to
  // the specific pane the user clicked on.
  const sendPromptTemplate = useCallback(
    (templateId: string) => {
      if (!pane.sessionId) return;
      const tpl = usePromptStore
        .getState()
        .templates.find((t) => t.id === templateId);
      if (!tpl) return;
      // Use CR ("\r") to match `runCommand` — TTY line discipline submits on
      // CR, not LF; some Windows ConPTY configs won't fire the agent's
      // Enter handler on bare LF.
      void writePty(pane.sessionId, tpl.content + "\r");
      setShowPromptMenu(false);
    },
    [pane.sessionId],
  );

  // Reach the mosaic drag source from the surrounding MosaicWindow so the
  // unified header bar acts as the drag handle for reordering tiles.
  // Context may be null when pane is rendered outside Mosaic (e.g. zoomed overlay).
  const mosaicCtx = useContext(MosaicWindowContext);
  const mosaicWindowActions = mosaicCtx?.mosaicWindowActions ?? null;

  const agentName = agentConfig?.name ?? pane.agentId;
  const iconName = agentConfig?.icon ?? "Terminal";
  const Icon = ICON_MAP[iconName] ?? Terminal;
  // Track B: orchestrated panes carry an explicit `overrideCommand` so they
  // can use a CLI other than the WorkspaceAgentSlot's default (e.g. a flight
  // task launched as `gemini` inside a `claude-code` slot).
  const command = pane.overrideCommand ?? agentConfig?.command ?? pane.agentId;

  // Keep CLI args stable so terminal startup is only driven by real config changes.
  const bypassPermissions = workspace?.bypassPermissions ?? false;
  const model = workspace?.modelOverrides?.[pane.agentId] ?? null;
  const effort = workspace?.effortOverrides?.[pane.agentId] ?? null;
  const initialPrompt =
    pane.initialPrompt ?? (pane.agentId !== "terminal" ? workspace?.prompt : undefined);

  // Model selection
  const availableModels = useMemo(() => getModelsForAgent(pane.agentId), [pane.agentId]);
  const hasModelOptions = availableModels.length > 0 && pane.agentId !== "terminal";
  const modelLabel = model
    ? (availableModels.find((m) => m.value === model)?.label ?? model)
    : "Default";

  const cliArgs: string[] | undefined = useMemo(() => {
    // Track B: orchestrated panes pass the full arg vector through
    // `overrideArgs` (set by `orchestrationStore.tick()` from the task's
    // configured command + agentArgs), so we skip the workspace's
    // bypass/model/effort augmentation in that case.
    if (pane.overrideArgs) {
      return pane.overrideArgs.length > 0 ? pane.overrideArgs : undefined;
    }

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
  }, [agentConfig?.defaultArgs, bypassPermissions, effort, model, pane.agentId, pane.overrideArgs]);

  // SSH override for remote workspaces
  const server = workspace?.serverId
    ? useServerStore.getState().getServer(workspace.serverId)
    : undefined;
  const knownHostsPath = useServerStore((s) => s.knownHostsPath);
  const isRemote = !!server;
  const effectiveCommand = isRemote ? "ssh" : command;
  const effectiveArgs = useMemo(() => {
    if (!isRemote || !server) return cliArgs;
    return buildSshArgs(
      server,
      workspace?.remoteProjectPath ?? server.remotePath ?? "",
      command,
      cliArgs,
      knownHostsPath ?? undefined,
    );
  }, [isRemote, server, command, cliArgs, workspace?.remoteProjectPath, knownHostsPath]);

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
      const dotClass = AGENT_DOT_CLASS[state.cliCommand] ?? "bg-text-muted";
      const agentTextClass = AGENT_TEXT_CLASS[state.cliCommand] ?? accentTextClass;
      const statusLabel = state.showApproval
        ? "approval"
        : state.alive
          ? "running"
          : state.error
            ? "error"
            : "idle";
      const statusPillClass = state.showApproval
        ? "bg-accent-soft text-accent-amber border border-accent-line"
        : state.alive
          ? "bg-accent-soft text-accent-green border border-accent-line"
          : state.error
            ? "bg-bg-elevated text-accent-red border border-bg-border"
            : "bg-bg-elevated text-text-muted border border-bg-border";

      const headerContent = (
        <div
          className={`flex cursor-grab select-none items-center gap-2 border-b border-line-soft bg-bg-secondary px-2 py-1 active:cursor-grabbing ${accentBgTint}`}
          onDoubleClick={() => setZoomedPane(isZoomed ? null : pane.id)}
        >
          <GripHorizontal size={11} className="shrink-0 text-text-muted" />
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${dotClass} ${state.alive ? "animate-pulse" : ""}`}
          />
          <Icon size={11} className={`${agentTextClass} shrink-0`} />
          <span className={`truncate text-[11px] font-semibold ${agentTextClass}`}>
            {agentName}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-text-muted">
            {pillLabel.toLowerCase()}
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
                className={`flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[9px] transition-colors ${
                  model
                    ? "border-accent-green/40 bg-accent-green/10 hover:bg-accent-green/20 text-accent-green"
                    : "border-bg-border text-text-muted hover:border-text-muted hover:text-text-secondary"
                }`}
                title="Change model (applies on next session)"
              >
                {modelLabel}
                <ChevronDown
                  size={8}
                  className={`transition-transform ${showModelPicker ? "rotate-180" : ""}`}
                />
              </button>
              {showModelPicker && (
                <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-bg-border bg-bg-elevated py-1 shadow-xl">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      useWorkspaceStore
                        .getState()
                        .setModelOverride(workspaceId, pane.agentId, null);
                      setShowModelPicker(false);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={`w-full px-3 py-1.5 text-left text-[10px] transition-colors hover:bg-bg-hover ${
                      !model ? "font-medium text-accent-green" : "text-text-primary"
                    }`}
                  >
                    Default
                  </button>
                  {availableModels.map((m) => (
                    <button
                      key={m.value}
                      onClick={(e) => {
                        e.stopPropagation();
                        useWorkspaceStore
                          .getState()
                          .setModelOverride(workspaceId, pane.agentId, m.value);
                        setShowModelPicker(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`w-full px-3 py-1.5 text-left text-[10px] transition-colors hover:bg-bg-hover ${
                        model === m.value ? "font-medium text-accent-green" : "text-text-primary"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                  <div className="mt-1 border-t border-bg-border px-3 py-1 pt-1">
                    <span className="text-[9px] text-text-muted">Takes effect on next session</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex-1" />
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] ${statusPillClass}`}
            title={state.error ?? statusLabel}
          >
            {statusLabel}
          </span>
          {/* Color picker button */}
          <div className="relative shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowColorPicker((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
              title="Change accent color"
            >
              <Palette size={11} />
            </button>
            {showColorPicker && (
              <div
                className="absolute right-0 top-full z-50 mt-1 flex items-center gap-1 rounded-md border border-bg-border bg-bg-tertiary px-2 py-1.5 shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {ACCENT_OPTIONS.map((opt) => (
                  <button
                    key={opt.token}
                    onClick={(e) => {
                      e.stopPropagation();
                      useWorkspaceStore
                        .getState()
                        .updatePane(workspaceId, pane.id, { accentColor: opt.token });
                      setShowColorPicker(false);
                    }}
                    className={`h-4 w-4 rounded-full ${opt.bg} transition-transform hover:scale-125 ${accent === opt.token ? `ring-2 ring-offset-1 ring-offset-bg-tertiary ${opt.border}` : ""}`}
                    title={opt.token}
                  />
                ))}
              </div>
            )}
          </div>
          {/* Prompts paste-affordance — opens a dropdown of saved templates;
              selecting one writes the body to this pane's PTY. Disabled
              until the PTY session is up. */}
          <div ref={promptMenuRef} className="relative shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!pane.sessionId) return;
                setShowPromptMenu((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={!pane.sessionId}
              className={`p-0.5 transition-colors ${
                pane.sessionId
                  ? "text-text-muted hover:text-accent-green"
                  : "text-text-faint opacity-50 cursor-not-allowed"
              }`}
              title={
                pane.sessionId
                  ? "Send a prompt template to this pane"
                  : "PTY not ready"
              }
            >
              <BookOpen size={11} />
            </button>
            {showPromptMenu && pane.sessionId && (
              <div
                className="absolute right-0 top-full z-50 mt-1 max-h-[280px] w-64 overflow-y-auto rounded-md border border-bg-border bg-bg-elevated py-1 shadow-xl"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-text-muted">
                  Send a prompt to this pane
                </div>
                {promptTemplates.length === 0 ? (
                  <div className="px-3 py-2 text-[10px] text-text-muted">
                    No templates yet. Add some in Settings → Prompt Templates.
                  </div>
                ) : (
                  promptTemplates.map((t) => (
                    <button
                      key={t.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        sendPromptTemplate(t.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] text-text-primary transition-colors hover:bg-bg-hover"
                      title={t.content}
                    >
                      <span className="truncate">{t.name}</span>
                      <span className="ml-auto text-[9px] text-text-muted">
                        {t.category}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowPinPopover((v) => !v);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`shrink-0 p-0.5 transition-colors ${pinnedCommands.length > 0 ? "text-accent-blue" : "text-text-muted"} hover:text-accent-blue`}
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
            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-blue"
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
            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
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
            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-red"
            title="Close pane"
          >
            <X size={11} />
          </button>
        </div>
      );

      const pinPopover = showPinPopover ? (
        <div
          ref={pinPopoverRef}
          className="absolute right-1 top-full z-50 mt-0.5 w-64 rounded border border-bg-border bg-bg-primary shadow-lg"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="space-y-1.5 p-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
              Pinned Commands ({pinnedCommands.length}/5)
            </div>
            {pinnedCommands.map((cmd, i) => (
              <div key={i} className="group flex items-center gap-1">
                <span className="flex-1 truncate text-[11px] text-text-secondary" title={cmd}>
                  {cmd}
                </span>
                <button
                  onClick={() => {
                    runCommand(cmd);
                    setShowPinPopover(false);
                  }}
                  className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
                  title="Run"
                  disabled={!pane.sessionId}
                >
                  <Play size={10} />
                </button>
                <button
                  onClick={() =>
                    useWorkspaceStore.getState().removePinnedCommand(workspaceId, pane.id, i)
                  }
                  className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-red"
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
                className="flex items-center gap-1 border-t border-bg-border pt-1"
              >
                <input
                  type="text"
                  value={newPinCmd}
                  onChange={(e) => setNewPinCmd(e.target.value)}
                  placeholder="Add command..."
                  className="flex-1 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-[11px] text-text-primary focus:border-accent-blue focus:outline-none"
                />
                <button
                  type="submit"
                  className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
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
          <div className="bg-bg-secondary/50 flex gap-1 overflow-x-auto border-b border-bg-border px-2 py-1">
            {pinnedCommands.map((cmd, i) => (
              <button
                key={i}
                onClick={() => runCommand(cmd)}
                disabled={!pane.sessionId}
                className="max-w-[120px] truncate rounded bg-bg-hover px-2 py-0.5 text-[9px] text-text-secondary hover:text-text-primary disabled:opacity-40"
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
    [
      Icon,
      accentTextClass,
      accentBgTint,
      accent,
      agentConfig,
      agentName,
      mosaicWindowActions,
      isZoomed,
      setZoomedPane,
      pane.id,
      pane.agentId,
      hasModelOptions,
      model,
      modelLabel,
      availableModels,
      showModelPicker,
      showColorPicker,
      workspaceId,
      pinnedCommands,
      showPinPopover,
      newPinCmd,
      runCommand,
      pane.sessionId,
      promptTemplates,
      showPromptMenu,
      sendPromptTemplate,
    ],
  );

  const wrapperBorderClass = isFocused
    ? "border border-accent-line"
    : `border border-bg-border ${accentBorderClass}`;

  return (
    <div className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass}`}>
      <TerminalPane
        paneId={pane.id}
        cliCommand={effectiveCommand}
        cliArgs={effectiveArgs}
        projectPath={workspace?.projectPath}
        initialPrompt={initialPrompt}
        taskId={pane.taskId}
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
