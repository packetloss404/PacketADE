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

interface TerminalPaneProps {
  paneId: string;
  onClose?: () => void;
  showCloseButton?: boolean;
  cliCommand?: string;
  cliArgs?: string[];
  initialPrompt?: string;
}

export function TerminalPane({
  paneId,
  onClose,
  showCloseButton = false,
  cliCommand = "claude",
  cliArgs,
  initialPrompt: _initialPrompt,
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
    xtermRef,
    fitAddonRef,
    sessionIdRef,
  });

  clearApprovalRef.current = clearApproval;

  useApprovalShortcuts({
    showApproval,
    xtermRef,
    onApprove: handleApprove,
    onDeny: handleDeny,
    onAbort: handleAbort,
  });

  const showActivityStrip =
    alive && activityInfo.state !== "idle" && activityInfo.tool !== null;

  return (
    <div
      className="flex flex-col h-full bg-bg-primary"
      onClick={() => setActivePaneId(paneId)}
    >
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

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={termContainerRef}
          className="h-full overflow-hidden"
          style={{ padding: "4px 2px 0 4px" }}
        />
        {showApproval && alive && (
          <ApprovalOverlay
            onApprove={handleApprove}
            onDeny={handleDeny}
            onAbort={handleAbort}
          />
        )}
      </div>

      {showActivityStrip && (
        <ActivityStrip state={activityInfo.state} tool={activityInfo.tool} file={activityInfo.file} />
      )}

      {alive && activityInfo.state === "thinking" && !activityInfo.tool && (
        <ActivityStrip state="thinking" tool={null} file={null} />
      )}

      <SessionStatusBar cliCommand={cliCommand} alive={alive} projectPath={projectPath} />
    </div>
  );
}
