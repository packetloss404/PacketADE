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
  onKill: () => void;
}

interface TerminalPaneProps {
  paneId: string;
  onClose?: () => void;
  showCloseButton?: boolean;
  cliCommand?: string;
  cliArgs?: string[];
  initialPrompt?: string;
  projectPath?: string;
  issueId?: string;
  onSessionCreated?: (sessionId: string) => void;
  onSessionEnded?: () => void;
  /** When provided, replaces the default TerminalHeader bar entirely. */
  renderHeader?: (state: TerminalHeaderRenderState) => React.ReactNode;
}

export function TerminalPane({
  paneId,
  onClose,
  showCloseButton = false,
  cliCommand = "claude",
  cliArgs,
  initialPrompt,
  projectPath: paneProjectPath,
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
    cliCommand,
    cliArgs,
    projectPath: paneProjectPath,
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
    xtermRef,
    onApprove: handleApprove,
    onDeny: handleDeny,
    onAbort: handleAbort,
  });

  const showActivityStrip = alive && activityInfo.state !== "idle" && activityInfo.tool !== null;

  return (
    <div className="flex h-full flex-col bg-bg-primary" onClick={() => setActivePaneId(paneId)}>
      {renderHeader ? (
        renderHeader({ alive, error, showApproval, cliCommand, onRestart: handleRestart, onKill: handleKill })
      ) : (
        <TerminalHeader
          alive={alive}
          error={error}
          showApproval={showApproval}
          cliCommand={cliCommand}
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
