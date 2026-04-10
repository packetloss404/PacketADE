import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createPtySession, writePty, killPty } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import { useActivityStore } from "@/stores/activityStore";
import { usePtyStateDetector, type PtyDetectorState } from "@/hooks/usePtyStateDetector";
import {
  notifyApprovalNeeded,
  notifySessionComplete,
  notifySessionError,
} from "@/lib/notifications";

interface PtyOutput {
  session_id: string;
  data: string;
}

interface UseTerminalSessionOptions {
  paneId: string;
  cliCommand: string;
  cliArgs?: string[];
  xtermRef: RefObject<Terminal | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  sessionIdRef: RefObject<string | null>;
}

export interface TerminalActivityInfo {
  tool: string | null;
  file: string | null;
  state: PtyDetectorState["agentState"];
}

let sessionCounter = 0;

export function useTerminalSession({
  paneId,
  cliCommand,
  cliArgs,
  xtermRef,
  fitAddonRef,
  sessionIdRef,
}: UseTerminalSessionOptions) {
  const tabIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  const [alive, setAlive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApproval, setShowApproval] = useState(false);
  const [activityInfo, setActivityInfo] = useState<TerminalActivityInfo>({
    tool: null,
    file: null,
    state: "idle",
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const projectPath = useLayoutStore((s) => s.projectPath);

  const handleStateChange = useCallback((prev: PtyDetectorState, next: PtyDetectorState) => {
    const tabId = tabIdRef.current;
    const sessionId = sessionIdRef.current;

    setShowApproval(next.needsApproval);
    setActivityInfo({
      tool: next.currentTool,
      file: next.currentFile,
      state: next.agentState,
    });

    if (tabId) {
      useActivityStore.getState().setActivity(tabId, {
        currentTool: next.currentTool,
        currentFile: next.currentFile,
        agentState: next.agentState,
        lastActivityAt: next.lastActivityAt,
      });
    }

    if (tabId) {
      if (next.needsApproval && !prev.needsApproval) {
        useTabStore.getState().updateTabStatus(tabId, "waiting_approval");
        const tab = useTabStore.getState().getTab(tabId);
        if (sessionId && tab) {
          notifyApprovalNeeded(sessionId, tab.name);
        }
      } else if (!next.needsApproval && prev.needsApproval) {
        useTabStore.getState().updateTabStatus(tabId, "running");
      }
    }
  }, []);

  const detectorResult = usePtyStateDetector({
    sessionId: currentSessionId,
    onStateChange: handleStateChange,
  });

  const startDurationTimer = useCallback((tabId: string) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      useTabStore.getState().updateTabDuration(tabId, elapsed);
    }, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startSession = useCallback(async () => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    // Kill any existing PTY session before starting a new one to prevent orphans
    const prevSid = sessionIdRef.current;
    if (prevSid) {
      await killPty(prevSid).catch(() => {});
      sessionIdRef.current = null;
    }

    for (const fn of unlistenersRef.current) {
      fn();
    }
    unlistenersRef.current = [];
    stopDurationTimer();

    setError(null);
    setShowApproval(false);
    setActivityInfo({ tool: null, file: null, state: "idle" });
    term.reset();

    try {
      fitAddon.fit();
    } catch {
      // ignore
    }

    const cols = term.cols;
    const rows = term.rows;

    sessionCounter++;
    const tabId = `tab_${Date.now()}_${sessionCounter}`;
    tabIdRef.current = tabId;

    try {
      useTabStore.getState().addTab({
        id: tabId,
        ptySessionId: "",
        name: `Session ${sessionCounter}`,
        ticketId: null,
        status: "starting",
        startedAt: Date.now(),
        projectPath,
      });

      const sessionId = await createPtySession(
        projectPath,
        cols,
        rows,
        cliCommand,
        cliArgs || null,
      );

      sessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
      setAlive(true);

      useLayoutStore.getState().setPaneSession(paneId, sessionId);

      useTabStore.getState().updateTabStatus(tabId, "running");
      useTabStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId: sessionId } : t)),
      }));

      startDurationTimer(tabId);

      const outputUnlisten = await listen<PtyOutput>("pty:output", (event) => {
        if (event.payload.session_id === sessionId) {
          term.write(event.payload.data);
        }
      });

      const exitUnlisten = await listen<string>("pty:exit", (event) => {
        if (event.payload === sessionId) {
          setAlive(false);
          setShowApproval(false);
          setCurrentSessionId(null);
          term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
          useTabStore.getState().updateTabStatus(tabId, "done");
          stopDurationTimer();

          const tab = useTabStore.getState().getTab(tabId);
          if (tab) {
            notifySessionComplete(sessionId, tab.name);
          }

          useActivityStore.getState().clearActivity(tabId);
        }
      });

      unlistenersRef.current = [outputUnlisten, exitUnlisten];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      const label = cliCommand.charAt(0).toUpperCase() + cliCommand.slice(1);
      term.write(`\x1b[31mFailed to start ${label}: ${msg}\x1b[0m\r\n`);
      term.write(`\x1b[90mMake sure '${cliCommand}' is installed and on your PATH.\x1b[0m\r\n`);
      useTabStore.getState().updateTabStatus(tabId, "error");
      stopDurationTimer();

      notifySessionError(tabId, `Session ${sessionCounter}`);
    }
  }, [
    projectPath,
    cliCommand,
    cliArgs,
    startDurationTimer,
    stopDurationTimer,
    paneId,
    xtermRef,
    fitAddonRef,
  ]);

  // Auto-start on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      startSession();
    }, 200);
    return () => clearTimeout(timer);
  }, [startSession]);

  // Issue prompt listener
  useEffect(() => {
    function handleIssuePrompt(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!detail?.prompt) return;
      const sid = sessionIdRef.current;
      if (!sid) return;

      const prompt = detail.prompt as string;
      writePty(sid, prompt + "\n").catch(() => {});

      if (detail.issueId) {
        const tid = tabIdRef.current;
        if (tid) {
          useTabStore.getState().setTabTicket(tid, detail.issueId);
        }
      }

      window.removeEventListener("packetcode:issue-prompt", handleIssuePrompt);
    }

    window.addEventListener("packetcode:issue-prompt", handleIssuePrompt);
    return () => window.removeEventListener("packetcode:issue-prompt", handleIssuePrompt);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const fn of unlistenersRef.current) {
        fn();
      }
      stopDurationTimer();
      const sid = sessionIdRef.current;
      if (sid) {
        killPty(sid).catch(() => {});
      }
      const tid = tabIdRef.current;
      if (tid) {
        useTabStore.getState().removeTab(tid);
        useActivityStore.getState().clearActivity(tid);
      }
    };
  }, [stopDurationTimer]);

  const handleKill = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      await killPty(sid).catch(() => {});
      setAlive(false);
    }
    setShowApproval(false);
    setCurrentSessionId(null);
    stopDurationTimer();
    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().updateTabStatus(tid, "done");
      useActivityStore.getState().clearActivity(tid);
    }
  }, [stopDurationTimer]);

  const handleRestart = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      await killPty(sid).catch(() => {});
    }
    sessionIdRef.current = null;
    setAlive(false);
    setShowApproval(false);
    setCurrentSessionId(null);
    stopDurationTimer();

    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().removeTab(tid);
      useActivityStore.getState().clearActivity(tid);
    }
    tabIdRef.current = null;

    await startSession();
  }, [startSession, stopDurationTimer]);

  const handleApprove = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "y\n").catch(() => {});
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult]);

  const handleDeny = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "n\n").catch(() => {});
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult]);

  const handleAbort = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "\x03").catch(() => {});
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult]);

  const clearApproval = detectorResult.clearApproval;

  return {
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
  };
}
