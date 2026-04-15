import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createPtySession, writePty, killPty } from "@/lib/tauri";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import { useActivityStore } from "@/stores/activityStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { usePtyStateDetector, type PtyDetectorState } from "@/hooks/usePtyStateDetector";
import {
  notifyApprovalNeeded,
  notifySessionComplete,
  notifySessionError,
} from "@/lib/notifications";

/** Keep a stable ref for a callback so it can be used inside effects without adding it as a dependency. */
function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

interface UseTerminalSessionOptions {
  paneId: string;
  cliCommand: string;
  cliArgs?: string[];
  projectPath?: string;
  initialPrompt?: string;
  issueId?: string;
  taskId?: string;
  xtermRef: RefObject<Terminal | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  sessionIdRef: RefObject<string | null>;
  onSessionCreated?: (sessionId: string) => void;
  onSessionEnded?: () => void;
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
  projectPath: paneProjectPath,
  initialPrompt,
  issueId,
  taskId,
  xtermRef,
  fitAddonRef,
  sessionIdRef,
  onSessionCreated,
  onSessionEnded,
}: UseTerminalSessionOptions) {
  const tabIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const exitRequestedRef = useRef(false);

  // Store callbacks in refs so they never destabilize memoised effects.
  const onSessionCreatedRef = useLatestRef(onSessionCreated);
  const onSessionEndedRef = useLatestRef(onSessionEnded);

  const [alive, setAlive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApproval, setShowApproval] = useState(false);
  const [activityInfo, setActivityInfo] = useState<TerminalActivityInfo>({
    tool: null,
    file: null,
    state: "idle",
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const globalProjectPath = useLayoutStore((s) => s.projectPath);
  const projectPath = paneProjectPath ?? globalProjectPath;

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
        if (taskId) {
          void useOrchestrationStore.getState().onTaskApprovalNeeded(taskId);
        }
      } else if (!next.needsApproval && prev.needsApproval) {
        useTabStore.getState().updateTabStatus(tabId, "running");
        if (taskId) {
          void useOrchestrationStore.getState().onTaskApprovalResolved(taskId);
        }
      }
    }
  }, [taskId]);

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
      exitRequestedRef.current = true;
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
    exitRequestedRef.current = false;
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
        ticketId: issueId ?? null,
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
      onSessionCreatedRef.current?.(sessionId);
      if (taskId) {
        useOrchestrationStore.getState().attachSessionToTask(taskId, sessionId);
      }

      useTabStore.getState().updateTabStatus(tabId, "running");
      useTabStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId: sessionId } : t)),
      }));

      startDurationTimer(tabId);

      const outputUnlisten = await listen<string>(ptyOutputEvent(sessionId), (event) => {
        term.write(event.payload);
      });

      const exitUnlisten = await listen<string>(ptyExitEvent(sessionId), () => {
        const wasRequested = exitRequestedRef.current;
        setAlive(false);
        setShowApproval(false);
        setCurrentSessionId(null);
        sessionIdRef.current = null;
        useLayoutStore.getState().setPaneSession(paneId, null);
        onSessionEndedRef.current?.();
        term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
        useTabStore.getState().updateTabStatus(tabId, "done");
        stopDurationTimer();

        const tab = useTabStore.getState().getTab(tabId);
        if (tab) {
          notifySessionComplete(sessionId, tab.name);
        }

        useActivityStore.getState().clearActivity(tabId);

        // Auto-learn from completed sessions (skip task sessions — those are captured via orchestration)
        if (!taskId && tab && projectPath && tab.durationMs > 30_000 && !wasRequested) {
          import("@/stores/memoryStore").then(({ useMemoryStore }) => {
            void useMemoryStore.getState().learnFromSession(
              sessionId,
              cliCommand,
              projectPath,
              tab.durationMs,
            );
          }).catch(() => {});
        }

        if (taskId) {
          const success = !wasRequested;
          void useOrchestrationStore.getState().onTaskComplete(taskId, success);
        }
      });

      unlistenersRef.current = [outputUnlisten, exitUnlisten];

      if (initialPrompt?.trim()) {
        // Claude Code is ready for input immediately; other CLIs (OpenCode, Gemini)
        // need time to initialize their TUI before accepting stdin.
        const delay = cliCommand === "claude" ? 0 : 3000;
        if (delay > 0) {
          setTimeout(() => {
            writePty(sessionId, `${initialPrompt.trim()}\n`).catch(() => {});
          }, delay);
        } else {
          writePty(sessionId, `${initialPrompt.trim()}\n`).catch(() => {});
        }
      }
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
    issueId,
    initialPrompt,
    xtermRef,
    fitAddonRef,
    taskId,
  ]);

  // Auto-start on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      startSession();
    }, 200);
    return () => clearTimeout(timer);
  }, [startSession]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const fn of unlistenersRef.current) {
        fn();
      }
      stopDurationTimer();
      const sid = sessionIdRef.current;
      if (sid) {
        exitRequestedRef.current = true;
        killPty(sid).catch(() => {});
      }
      useLayoutStore.getState().setPaneSession(paneId, null);
      onSessionEndedRef.current?.();
      const tid = tabIdRef.current;
      if (tid) {
        useTabStore.getState().removeTab(tid);
        useActivityStore.getState().clearActivity(tid);
      }
    };
  }, [paneId, stopDurationTimer]);

  const handleKill = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      exitRequestedRef.current = true;
      await killPty(sid).catch(() => {});
      setAlive(false);
    }
    setShowApproval(false);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    useLayoutStore.getState().setPaneSession(paneId, null);
    onSessionEndedRef.current?.();
    stopDurationTimer();
    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().updateTabStatus(tid, "done");
      useActivityStore.getState().clearActivity(tid);
    }
  }, [paneId, stopDurationTimer]);

  const handleRestart = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      exitRequestedRef.current = true;
      await killPty(sid).catch(() => {});
    }
    sessionIdRef.current = null;
    setAlive(false);
    setShowApproval(false);
    setCurrentSessionId(null);
    useLayoutStore.getState().setPaneSession(paneId, null);
    onSessionEndedRef.current?.();
    stopDurationTimer();

    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().removeTab(tid);
      useActivityStore.getState().clearActivity(tid);
    }
    tabIdRef.current = null;

    await startSession();
  }, [paneId, startSession, stopDurationTimer]);

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
