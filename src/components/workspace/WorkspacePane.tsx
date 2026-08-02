import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, Plus, Play, X, Maximize2, Minimize2, MoreVertical } from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { TerminalPane, type TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
import { usePromptStore } from "@/stores/promptStore";
import {
  isAbsolutePacketCodePath,
  usePacketCodeIntegrationStore,
} from "@/stores/packetCodeIntegrationStore";
import { buildSshArgs } from "@/lib/ssh";
import { writePty } from "@/lib/tauri";
import { getModelsForAgent } from "@/lib/models";
import { getAgentColor } from "@/lib/agentColors";
import { accountEnvForSlot } from "@/lib/cliAccountEnv";
import { AccountChip } from "@/components/session/AccountChip";
import { AccountBlockedPane } from "@/components/workspace/AccountBlockedPane";
import { LoginPtyModal } from "@/components/auth/LoginPtyModal";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { accountLoginCliForSlot, useAccountLaunchGate } from "@/hooks/useAccountLaunchGate";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";

/** Per-agent CLI flag to bypass all permission prompts.
 * OpenCode is intentionally omitted — it has no equivalent launch flag and
 * passing one makes it print `--help` and exit. Permissions are configured
 * inside the OpenCode TUI/config instead. */
const BYPASS_FLAGS: Record<string, string> = {
  "claude-code": "--dangerously-skip-permissions",
  // codex >= 0.x dropped `--full-auto`; the full-bypass equivalent is this.
  codex: "--dangerously-bypass-approvals-and-sandbox",
};

interface WorkspacePaneProps {
  pane: WorkspacePaneType;
  workspaceId: string;
  /** Gate the pane's one-time automatic PTY launch. */
  autoStart?: boolean;
}

export function WorkspacePane({ pane, workspaceId, autoStart = true }: WorkspacePaneProps) {
  const agents = useAgentStore((s) => s.agents);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const isZoomed = zoomedPaneId === pane.id;
  const isFocused = activePaneId === pane.id;
  // Tile program (P4-S1): transient focus-flash when a focusPaneRequest targets
  // this pane. Purely derived from the auto-clearing store request.
  const isFlashing = useWorkspaceStore(
    (s) =>
      s.focusPaneRequest?.paneId === pane.id && s.focusPaneRequest?.workspaceId === workspaceId,
  );
  const agentConfig = agents.find((a) => a.id === pane.agentId);
  // Single overflow menu replaces the standalone model/prompt/pin popovers —
  // "root" is the menu list, the other views are drilled-into sub-panels.
  const [showOverflow, setShowOverflow] = useState(false);
  const [overflowView, setOverflowView] = useState<"root" | "model" | "prompts" | "pins">("root");
  const [pendingClose, setPendingClose] = useState<{ onKill: () => void } | null>(null);
  const [newPinCmd, setNewPinCmd] = useState("");
  const overflowRef = useRef<HTMLDivElement>(null);
  const promptTemplates = usePromptStore((s) => s.templates);
  const packetCodeLocalDataHome = usePacketCodeIntegrationStore((s) => s.localDataHome);
  const packetCodeRemoteDataHomes = usePacketCodeIntegrationStore((s) => s.remoteDataHomes);

  // Close the overflow menu on outside click; reset to the root view so it
  // doesn't reopen mid-drill-down next time.
  useEffect(() => {
    if (!showOverflow) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
        setOverflowView("root");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showOverflow]);

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
      const tpl = usePromptStore.getState().templates.find((t) => t.id === templateId);
      if (!tpl) return;
      // Use CR ("\r") to match `runCommand` — TTY line discipline submits on
      // CR, not LF; some Windows ConPTY configs won't fire the agent's
      // Enter handler on bare LF.
      void writePty(pane.sessionId, tpl.content + "\r");
      setShowOverflow(false);
      setOverflowView("root");
    },
    [pane.sessionId],
  );

  // Reach the mosaic drag source from the surrounding MosaicWindow so the
  // unified header bar acts as the drag handle for reordering tiles.
  // Context null-guard is defensive — panes are always rendered inside Mosaic
  // (zoom reuses the mounted tile rather than rendering outside the mosaic).
  const mosaicCtx = useContext(MosaicWindowContext);
  const mosaicWindowActions = mosaicCtx?.mosaicWindowActions ?? null;

  const agentName = agentConfig?.name ?? pane.agentId;
  const command = agentConfig?.command ?? pane.agentId;

  // Keep CLI args stable so terminal startup is only driven by real config changes.
  const bypassPermissions = workspace?.bypassPermissions ?? false;
  const model = workspace?.modelOverrides?.[pane.agentId] ?? null;
  const effort = workspace?.effortOverrides?.[pane.agentId] ?? null;
  const initialPrompt = pane.agentId !== "terminal" ? workspace?.prompt : undefined;

  // Model selection
  const availableModels = useMemo(() => getModelsForAgent(pane.agentId), [pane.agentId]);
  const hasModelOptions = availableModels.length > 0 && pane.agentId !== "terminal";
  const modelLabel = model
    ? (availableModels.find((m) => m.value === model)?.label ?? model)
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
  const knownHostsPath = useServerStore((s) => s.knownHostsPath);
  const isRemote = !!server;
  const localPlatform =
    typeof navigator !== "undefined" &&
    /windows|win32|win64/i.test(navigator.userAgent || navigator.platform || "")
      ? "windows"
      : "posix";
  const packetCodeHome =
    pane.agentId === "packetcode"
      ? isRemote && server
        ? packetCodeRemoteDataHomes[server.id]?.trim()
        : packetCodeLocalDataHome.trim()
      : "";
  // Multi-account CLI binding. `pane.accountId` is absent for ambient panes,
  // in which case `accountEnvForSlot` returns `{}` and this whole feature is
  // inert — the env object below is byte-identical to what it was before.
  const accountId = pane.accountId ?? null;
  const accountEnv = useMemo(
    () => accountEnvForSlot(pane.agentId, accountId),
    [pane.agentId, accountId],
  );

  // REFUSE-TO-LAUNCH. `gate.state === "ambient"` for every pane without an
  // explicit accountId, and the hook short-circuits before any IPC in that
  // case — existing panes gain no probe and no new failure mode.
  const { gate, recheck } = useAccountLaunchGate(pane.agentId, accountId);
  const gateHolds = gate.state === "probing" || gate.state === "blocked";
  const accountCaveat = gate.state === "ready" ? gate.caveat : undefined;
  const [showAccountLogin, setShowAccountLogin] = useState(false);
  const loginCli = accountLoginCliForSlot(pane.agentId);

  /**
   * The ONE env object for this pane. It reaches both spawn paths:
   *   - local: `<TerminalPane env={…}>` → `useTerminalSession` → `create_pty_session`
   *   - SSH:   `buildSshArgs(…, paneEnv)` → remote `env K=V …` prefix
   * so a pane's account binding cannot be honoured on one transport and
   * dropped on the other.
   *
   * PACKETCODE_HOME and the account vars compose rather than compete: they are
   * disjoint keys, the PACKETCODE_HOME branch only ever fires for the
   * `packetcode` slot, and the account branch only ever fires for
   * `claude-code`/`codex`. In practice at most one of the two contributes, but
   * the merge is written so both could without either clobbering the other.
   *
   * Caveat (documented, not solved here): for SSH workspaces the account's
   * `configDir` is a path on the *local* machine. Remote account config dirs
   * are a separate problem; the binding is still forwarded so the remote CLI
   * cannot silently pick up the remote ambient login without a trace.
   */
  const paneEnv = useMemo<Record<string, string> | undefined>(() => {
    const merged: Record<string, string> = {};
    if (packetCodeHome) {
      const platform = isRemote ? "posix" : localPlatform;
      if (isAbsolutePacketCodePath(packetCodeHome, platform)) {
        merged.PACKETCODE_HOME = packetCodeHome;
      }
    }
    Object.assign(merged, accountEnv);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [isRemote, localPlatform, packetCodeHome, accountEnv]);
  const effectiveCommand = isRemote ? "ssh" : command;
  const remoteCommand = isRemote && pane.agentId === "packetcode" ? "packetcode" : command;
  const effectiveArgs = useMemo(() => {
    if (!isRemote || !server) return cliArgs;
    return buildSshArgs(
      server,
      workspace?.remoteProjectPath ?? server.remotePath ?? "",
      remoteCommand,
      cliArgs,
      knownHostsPath ?? undefined,
      paneEnv,
    );
  }, [
    isRemote,
    server,
    remoteCommand,
    cliArgs,
    workspace?.remoteProjectPath,
    knownHostsPath,
    paneEnv,
  ]);

  // Render the unified header bar — combines drag handle, agent identity,
  // CLI status, and lifecycle controls into a single row.
  const renderHeader = useCallback(
    (state: TerminalHeaderRenderState) => {
      const c = getAgentColor(state.cliCommand);
      const notInstalled = !!agentConfig && !agentConfig.installed;
      const statusLabel = notInstalled
        ? "not installed"
        : state.showApproval
          ? "approval"
          : state.alive
            ? "running"
            : state.error
              ? "error"
              : "idle";
      const statusPillClass = notInstalled
        ? "bg-bg-elevated text-accent-amber"
        : state.showApproval
          ? "bg-accent-soft text-accent-amber"
          : state.alive
            ? "bg-accent-soft text-accent-green"
            : state.error
              ? "bg-bg-elevated text-accent-red"
              : "bg-bg-elevated text-text-muted";

      const headerContent = (
        <div
          className="flex cursor-grab select-none items-center gap-2 border-b border-line-soft bg-bg-secondary px-2 py-1 active:cursor-grabbing"
          onDoubleClick={() => setZoomedPane(isZoomed ? null : pane.id)}
        >
          <GripHorizontal size={11} className="shrink-0 text-text-muted" />
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${c.text} bg-current ${state.alive ? "animate-pulse" : ""}`}
          />
          <span className={`truncate text-ui font-semibold ${c.text}`}>{agentName}</span>
          {/* Right next to the agent identity: two tiles running the same CLI
              under two logins are otherwise identical. Ambient panes render
              nothing here. */}
          <AccountChip
            accountId={accountId}
            caveat={accountCaveat}
            className="max-w-[130px]"
          />
          <div className="flex-1" />
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-meta ${statusPillClass}`}
            title={state.error ?? statusLabel}
          >
            {statusLabel}
          </span>
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
          <div ref={overflowRef} className="relative shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowOverflow((v) => !v);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
              title="More"
            >
              <MoreVertical size={11} />
            </button>
            {showOverflow && (
              <div
                className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-bg-border bg-bg-elevated shadow-xl"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {overflowView === "root" && (
                  <div className="py-1">
                    {hasModelOptions && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOverflowView("model");
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        Model: {modelLabel}
                      </button>
                    )}
                    {pane.sessionId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOverflowView("prompts");
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        Send prompt…
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("pins");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                    >
                      Pinned commands ({pinnedCommands.length}/5)
                    </button>
                    <div className="my-1 border-t border-bg-border" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        state.onRestart();
                        setShowOverflow(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                    >
                      {state.alive ? "Restart session" : "Start session"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingClose({ onKill: state.onKill });
                        setShowOverflow(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="hover:bg-accent-red/10 w-full px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:text-accent-red"
                    >
                      Close pane
                    </button>
                  </div>
                )}
                {overflowView === "model" && (
                  <div className="py-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1 text-left text-meta uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                    >
                      ← Back
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        useWorkspaceStore
                          .getState()
                          .setModelOverride(workspaceId, pane.agentId, null);
                        setShowOverflow(false);
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`w-full px-3 py-1.5 text-left text-ui transition-colors hover:bg-bg-hover ${
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
                          setShowOverflow(false);
                          setOverflowView("root");
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`w-full px-3 py-1.5 text-left text-ui transition-colors hover:bg-bg-hover ${
                          model === m.value ? "font-medium text-accent-green" : "text-text-primary"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                    <div className="mt-1 border-t border-bg-border px-3 py-1 pt-1">
                      <span className="text-meta text-text-muted">
                        Takes effect on next session
                      </span>
                    </div>
                  </div>
                )}
                {overflowView === "prompts" && (
                  <div className="max-h-[280px] overflow-y-auto py-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1 text-left text-meta uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                    >
                      ← Back
                    </button>
                    {promptTemplates.length === 0 ? (
                      <div className="px-3 py-2 text-ui text-text-muted">
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
                          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
                          title={t.content}
                        >
                          <span className="truncate">{t.name}</span>
                          <span className="ml-auto text-meta text-text-muted">{t.category}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {overflowView === "pins" && (
                  <div className="py-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOverflowView("root");
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-full px-3 py-1 text-left text-meta uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                    >
                      ← Back
                    </button>
                    <div className="space-y-1.5 px-3 pb-2">
                      <div className="text-meta font-medium uppercase tracking-wider text-text-muted">
                        Pinned Commands ({pinnedCommands.length}/5)
                      </div>
                      {pinnedCommands.map((cmd, i) => (
                        <div key={i} className="group flex items-center gap-1">
                          <span className="flex-1 truncate text-ui text-text-secondary" title={cmd}>
                            {cmd}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              runCommand(cmd);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
                            title="Run"
                            disabled={!pane.sessionId}
                          >
                            <Play size={10} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              useWorkspaceStore
                                .getState()
                                .removePinnedCommand(workspaceId, pane.id, i);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
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
                              useWorkspaceStore
                                .getState()
                                .addPinnedCommand(workspaceId, pane.id, newPinCmd);
                              setNewPinCmd("");
                            }
                          }}
                          className="flex items-center gap-1 border-t border-bg-border pt-1"
                        >
                          <input
                            type="text"
                            value={newPinCmd}
                            onChange={(e) => setNewPinCmd(e.target.value)}
                            onMouseDown={(e) => e.stopPropagation()}
                            placeholder="Add command..."
                            className="flex-1 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-ui text-text-primary focus:border-accent-blue focus:outline-none"
                          />
                          <button
                            type="submit"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-green"
                            title="Add"
                          >
                            <Plus size={10} />
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );

      const quickBar =
        pinnedCommands.length > 0 ? (
          <div className="bg-bg-secondary/50 flex gap-1 overflow-x-auto border-b border-bg-border px-2 py-1">
            {pinnedCommands.map((cmd, i) => (
              <button
                key={i}
                onClick={() => runCommand(cmd)}
                disabled={!pane.sessionId}
                className="max-w-[120px] truncate rounded bg-bg-hover px-2 py-0.5 text-meta text-text-secondary hover:text-text-primary disabled:opacity-40"
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
          {quickBar}
        </div>
      );

      // Wire the bar as the mosaic drag source so users can drag it to reorder tiles.
      return mosaicWindowActions?.connectDragSource(fullHeader) ?? fullHeader;
    },
    [
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
      showOverflow,
      overflowView,
      workspaceId,
      accountId,
      accountCaveat,
      pinnedCommands,
      newPinCmd,
      runCommand,
      pane.sessionId,
      promptTemplates,
      sendPromptTemplate,
    ],
  );

  const closeConfirmation = pendingClose
    ? createPortal(
        <ConfirmDeleteModal
          title="Close terminal pane?"
          entityName={agentName}
          description="will be removed from this Workspace."
          warnings={["Any live PTY and CLI process in this pane will be stopped."]}
          warningTitle="Session lifecycle"
          confirmLabel="Close pane"
          onClose={() => setPendingClose(null)}
          onConfirm={() => {
            pendingClose.onKill();
            useWorkspaceStore.getState().removePane(workspaceId, pane.id);
            setPendingClose(null);
          }}
        />,
        document.body,
      )
    : null;

  const wrapperBorderClass = isFocused ? "border border-accent-line" : "border border-bg-border";
  // Focus-flash highlight (P4-S1): amber ring pulse while a focusPaneRequest
  // targets this pane.
  const flashClass = isFlashing
    ? "ring-2 ring-accent-amber animate-pulse motion-reduce:animate-none"
    : "";

  // While the gate holds we mount NO TerminalPane. Disabling `autoStart` alone
  // would not be enough: the header's "Start session" item calls straight into
  // `useTerminalSession`, so an unmounted terminal is the only way to be sure
  // the CLI cannot be spawned with the wrong (or missing) account env.
  if (gateHolds) {
    return (
      <>
        <div
          data-pane-zoomed={isZoomed || undefined}
          className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass} ${flashClass}`}
        >
          {renderHeader({
            alive: false,
            error: null,
            showApproval: false,
            cliCommand: effectiveCommand,
            // "Start session" in the overflow menu re-probes instead of spawning.
            onRestart: recheck,
            onKill: () => {},
          })}
          <AccountBlockedPane
            accountId={accountId ?? ""}
            label={gate.label}
            reason={gate.state === "blocked" ? gate.reason : ""}
            probing={gate.state === "probing"}
            onLogin={
              gate.state === "blocked" && gate.loginCli
                ? () => setShowAccountLogin(true)
                : undefined
            }
            onRecheck={recheck}
          />
          {showAccountLogin && loginCli && (
            <LoginPtyModal
              cli={loginCli}
              projectPath={workspace?.projectPath}
              // The whole point: the login writes credentials into THIS
              // account's config dir, not the ambient one.
              env={accountEnv}
              accountLabel={gate.label}
              onClose={() => {
                setShowAccountLogin(false);
                recheck();
              }}
            />
          )}
        </div>
        {closeConfirmation}
      </>
    );
  }

  return (
    <>
      {/* data-pane-zoomed lets mosaic-overrides.css maximize this pane's
          already-mounted mosaic tile when zoomed (.mosaic-zoom-active) instead
          of mounting a duplicate WorkspacePane (which would spawn a second PTY). */}
      <div
        data-pane-zoomed={isZoomed || undefined}
        className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass} ${flashClass}`}
      >
        <TerminalPane
          paneId={pane.id}
          autoStart={autoStart}
          cliCommand={effectiveCommand}
          cliArgs={effectiveArgs}
          env={isRemote ? undefined : paneEnv}
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
      {closeConfirmation}
    </>
  );
}
