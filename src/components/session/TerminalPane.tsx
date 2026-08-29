import { useRef } from "react";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTerminalSession } from "@/hooks/useTerminalSession";
import { useXterm } from "@/hooks/useXterm";
import { useApprovalShortcuts } from "@/hooks/useApprovalShortcuts";
import { ActivityStrip } from "@/components/session/ActivityStrip";
import { TerminalHeader } from "@/components/session/TerminalHeader";
import { ApprovalOverlay } from "@/components/session/ApprovalOverlay";
import { SessionStatusBar } from "@/components/session/SessionStatusBar";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHeaderRenderState {
  alive: boolean;
  error: string | null;
  showApproval: boolean;
  cliCommand: string;
  onRestart: () => void;
  onKill: () => void | Promise<void>;
}

interface TerminalPaneProps {
  paneId: string;
  /** Whether this mounted pane may perform its one automatic PTY launch. */
  autoStart?: boolean;
  onClose?: () => void;
  showCloseButton?: boolean;
  cliCommand?: string;
  cliArgs?: string[];
  env?: Record<string, string>;
  /** Multi-account: forwarded to the default header's account chip. Callers
   *  supplying `renderHeader` render their own chip. */
  accountId?: string | null;
  initialPrompt?: string;
  projectPath?: string;
  /** Owning workspace — memory capture resolves its (local vs ssh) scope from it. */
  workspaceId?: string;
  issueId?: string;
  onSessionCreated?: (sessionId: string) => void;
  onSessionEnded?: () => void;
  /** When provided, replaces the default TerminalHeader bar entirely. */
  renderHeader?: (state: TerminalHeaderRenderState) => React.ReactNode;
}

export function TerminalPane({
  paneId,
  autoStart = true,
  onClose,
  showCloseButton = false,
  cliCommand = "claude",
  cliArgs,
  env,
  accountId,
  initialPrompt,
  projectPath: paneProjectPath,
  workspaceId,
  issueId,
  onSessionCreated,
  onSessionEnded,
  renderHeader,
}: TerminalPaneProps) {
  const termContainerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);

  const clearApprovalRef = useRef<() => void>(() => {});
  const { xtermRef, fitAddonRef } = useXterm({
    containerRef: termContainerRef,
    sessionIdRef,
    onUserInput: () => clearApprovalRef.current(),
  });

  const {
    sessionId,
    alive,
    error,
    showApproval,
    activityInfo,
    projectPath,
    handleKill,
    handleRestart,
    handleApprove,
    handleDeny,
    handleAbort,
    clearApproval,
  } = useTerminalSession({
    paneId,
    autoStart,
    cliCommand,
    cliArgs,
    env,
    projectPath: paneProjectPath,
    workspaceId,
    initialPrompt,
    issueId,
    xtermRef,
    fitAddonRef,
    sessionIdRef,
    onSessionCreated,
    onSessionEnded,
  });

  clearApprovalRef.current = clearApproval;

  useApprovalShortcuts({
    showApproval,
    paneId,
    xtermRef,
    onApprove: handleApprove,
    onDeny: handleDeny,
    onAbort: handleAbort,
  });

  const showActivityStrip = alive && activityInfo.state !== "idle" && activityInfo.tool !== null;

  return (
    <div
      className="flex h-full flex-col bg-bg-primary"
      data-dictation-pty-session={sessionId ?? undefined}
      onClick={() => setActivePaneId(paneId)}
    >
      {renderHeader ? (
        renderHeader({
          alive,
          error,
          showApproval,
          cliCommand,
          onRestart: handleRestart,
          onKill: handleKill,
        })
      ) : (
        <TerminalHeader
          alive={alive}
          error={error}
          showApproval={showApproval}
          cliCommand={cliCommand}
          accountId={accountId}
          onRestart={handleRestart}
          onKill={handleKill}
          onClose={onClose}
          showCloseButton={showCloseButton}
        />
      )}

      <div className="relative flex-1 overflow-hidden" style={{ padding: "4px 2px 0 4px" }}>
        <div ref={termContainerRef} className="h-full w-full overflow-hidden" />
        {showApproval && alive && (
          <ApprovalOverlay onApprove={handleApprove} onDeny={handleDeny} onAbort={handleAbort} />
        )}
      </div>

      {showActivityStrip && (
        <ActivityStrip
          state={activityInfo.state}
          tool={activityInfo.tool}
          file={activityInfo.file}
        />
      )}

      {alive && activityInfo.state === "thinking" && !activityInfo.tool && (
        <ActivityStrip state="thinking" tool={null} file={null} />
      )}

      <SessionStatusBar cliCommand={cliCommand} alive={alive} projectPath={projectPath} />
    </div>
  );
}
