import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createPtySession,
  killPty,
  listPtySessions,
  readPtyTranscript,
  writePty,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";
import {
  bufferedPtyRemainder,
  parsePtyOutputPayload,
  type PtyOutputPayload,
} from "@/lib/ptyReplay";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import { useActivityStore } from "@/stores/activityStore";
import { useMemoryStore } from "@/stores/memoryStore";
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
  /** Gate the single automatic launch performed by this hook instance. */
  autoStart?: boolean;
  cliCommand: string;
  cliArgs?: string[];
  env?: Record<string, string>;
  projectPath?: string;
  initialPrompt?: string;
  issueId?: string;
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

// Panes with an in-flight `startSession()`. StrictMode / double-mount can fire
// two auto-starts for the same pane a few ms apart; without deduping, each spawns
// its own PTY. That's invisible for claude/codex (multiple instances coexist) but
// fatal for opencode, whose second instance exits 1 and leaves the pane's xterm
// bound to a dead session — i.e. a permanently blank pane. Module-scoped so it
// dedupes across separate hook/component instances of the same pane.
const panesStarting = new Set<string>();

export function useTerminalSession({
  paneId,
  autoStart = true,
  cliCommand,
  cliArgs,
  env,
  projectPath: paneProjectPath,
  initialPrompt,
  issueId,
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
  const endedSessionIdsRef = useRef(new Set<string>());
  const autoStartTriggeredRef = useRef(false);

  // Store callbacks in refs so they never destabilize memoised effects.
  const onSessionCreatedRef = useLatestRef(onSessionCreated);
  const onSessionEndedRef = useLatestRef(onSessionEnded);
  const emitSessionEnded = useCallback(
    (sessionId: string | null) => {
      if (!sessionId || endedSessionIdsRef.current.has(sessionId)) return;
      endedSessionIdsRef.current.add(sessionId);
      onSessionEndedRef.current?.();
    },
    [onSessionEndedRef],
  );

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

  const handleStateChange = useCallback(
    (prev: PtyDetectorState, next: PtyDetectorState) => {
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
    },
    [sessionIdRef],
  );

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

    // Dedupe concurrent starts for the same pane (set synchronously before the
    // first await, so a near-simultaneous duplicate start bails out here). The
    // flag is cleared once the spawn resolves/fails, so legitimate restarts later
    // still work.
    if (paneId) {
      if (panesStarting.has(paneId)) return;
      panesStarting.add(paneId);
    }

    // Kill any existing PTY session before starting a new one to prevent
    // orphans. Swallow kill errors — the PTY may already have exited; the
    // restart will succeed regardless.
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
        env ?? null,
      );

      sessionIdRef.current = sessionId;
      if (paneId) panesStarting.delete(paneId);
      setCurrentSessionId(sessionId);
      setAlive(true);

      useLayoutStore.getState().setPaneSession(paneId, sessionId);
      onSessionCreatedRef.current?.(sessionId);

      useTabStore.getState().updateTabStatus(tabId, "running");
      useTabStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId: sessionId } : t)),
      }));

      startDurationTimer(tabId);

      let buffering = true;
      const buffered: PtyOutputPayload[] = [];
      let exitWhileBuffering = false;
      let sessionFinished = false;
      const finishSession = () => {
        if (sessionFinished) return;
        if (buffering) {
          exitWhileBuffering = true;
          return;
        }
        sessionFinished = true;
        for (const fn of unlistenersRef.current) {
          try {
            fn();
          } catch {
            // listener already gone
          }
        }
        unlistenersRef.current = [];

        const wasRequested = exitRequestedRef.current;
        setAlive(false);
        setShowApproval(false);
        setCurrentSessionId(null);
        sessionIdRef.current = null;
        useLayoutStore.getState().setPaneSession(paneId, null);
        emitSessionEnded(sessionId);
        term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
        useTabStore.getState().updateTabStatus(tabId, "done");
        stopDurationTimer();

        const tab = useTabStore.getState().getTab(tabId);
        if (tab) {
          notifySessionComplete(sessionId, tab.name);
        }

        useActivityStore.getState().clearActivity(tabId);

        // Auto-learn from completed sessions.
        if (tab && projectPath && tab.durationMs > 30_000 && !wasRequested) {
          void useMemoryStore
            .getState()
            .learnFromSession(sessionId, cliCommand, projectPath, tab.durationMs);
        }
      };

      const outputUnlisten = await listen<unknown>(ptyOutputEvent(sessionId), (event) => {
        const output = parsePtyOutputPayload(event.payload);
        if (buffering) {
          buffered.push(output);
        } else {
          term.write(output.data);
        }
      });

      const exitUnlisten = await listen<unknown>(ptyExitEvent(sessionId), () => {
        finishSession();
      });

      unlistenersRef.current = [outputUnlisten, exitUnlisten];
      if (sessionFinished) {
        outputUnlisten();
        exitUnlisten();
        unlistenersRef.current = [];
      }

      const transcript = await readPtyTranscript(sessionId).catch(() => null);
      const replayed = transcript?.data ?? "";
      if (replayed) term.write(replayed);
      const bufferedRemainder = bufferedPtyRemainder(replayed, transcript?.sequence, buffered);
      if (bufferedRemainder) term.write(bufferedRemainder);
      buffering = false;
      if (exitWhileBuffering) finishSession();

      const sessions = await listPtySessions().catch(() => null);
      const liveSession = sessions?.find((s) => s.id === sessionId);
      if (sessions && (!liveSession || !liveSession.alive)) finishSession();
      if (sessionFinished) return;

      if (initialPrompt?.trim()) {
        // Claude Code is ready for input immediately; other CLIs (OpenCode, Gemini)
        // need time to initialize their TUI before accepting stdin.
        const delay = cliCommand === "claude" ? 0 : 3000;
        const sendInitialPrompt = () => {
          writePty(sessionId, `${initialPrompt.trim()}\n`).catch((err) => {
            // Surface — a swallowed failure here means the memory /
            // workspace initial prompt never reached the agent and the
            // user can't tell why their first turn looks empty.
            console.error(
              `[useTerminalSession] failed to write initial prompt to ${cliCommand} session ${sessionId}:`,
              err,
            );
          });
        };
        if (delay > 0) {
          setTimeout(sendInitialPrompt, delay);
        } else {
          sendInitialPrompt();
        }
      }
    } catch (err) {
      if (paneId) panesStarting.delete(paneId);
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
    env,
    startDurationTimer,
    stopDurationTimer,
    paneId,
    issueId,
    initialPrompt,
    xtermRef,
    fitAddonRef,
    sessionIdRef,
    onSessionCreatedRef,
    emitSessionEnded,
  ]);

  // Auto-start at most once, and only after the owning Workspace is both
  // visible and selected. The component remains mounted after navigation so a
  // live PTY survives, but toggling visibility or changing memoized launch
  // options must never silently restart it.
  useEffect(() => {
    if (!autoStart || autoStartTriggeredRef.current) return;
    const timer = setTimeout(() => {
      if (autoStartTriggeredRef.current) return;
      autoStartTriggeredRef.current = true;
      void startSession();
    }, 200);
    return () => clearTimeout(timer);
  }, [autoStart, startSession]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const fn of unlistenersRef.current) {
        fn();
      }
      stopDurationTimer();
      // Release the start-dedupe flag in case we unmount mid-spawn.
      if (paneId) panesStarting.delete(paneId);
      const sid = sessionIdRef.current;
      if (sid) {
        exitRequestedRef.current = true;
        // Unmount cleanup — swallow errors; PTY may already be dead.
        killPty(sid).catch(() => {});
      }
      useLayoutStore.getState().setPaneSession(paneId, null);
      emitSessionEnded(sid);
      const tid = tabIdRef.current;
      if (tid) {
        useTabStore.getState().removeTab(tid);
        useActivityStore.getState().clearActivity(tid);
      }
    };
  }, [paneId, stopDurationTimer, sessionIdRef, emitSessionEnded]);

  const handleKill = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      exitRequestedRef.current = true;
      // User-initiated kill — swallow if already exited.
      await killPty(sid).catch(() => {});
      setAlive(false);
    }
    setShowApproval(false);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    useLayoutStore.getState().setPaneSession(paneId, null);
    emitSessionEnded(sid);
    stopDurationTimer();
    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().updateTabStatus(tid, "done");
      useActivityStore.getState().clearActivity(tid);
    }
  }, [paneId, stopDurationTimer, sessionIdRef, emitSessionEnded]);

  const handleRestart = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      exitRequestedRef.current = true;
      // Restart kills the prior PTY — swallow if already exited.
      await killPty(sid).catch(() => {});
    }
    sessionIdRef.current = null;
    setAlive(false);
    setShowApproval(false);
    setCurrentSessionId(null);
    useLayoutStore.getState().setPaneSession(paneId, null);
    emitSessionEnded(sid);
    stopDurationTimer();

    const tid = tabIdRef.current;
    if (tid) {
      useTabStore.getState().removeTab(tid);
      useActivityStore.getState().clearActivity(tid);
    }
    tabIdRef.current = null;

    // Clear the terminal so restart feels like a fresh session
    xtermRef.current?.clear();

    await startSession();
  }, [paneId, startSession, stopDurationTimer, xtermRef, sessionIdRef, emitSessionEnded]);

  const handleApprove = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "y\n").catch(logSwallowed("useTerminalSession.approve"));
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult, sessionIdRef]);

  const handleDeny = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "n\n").catch(logSwallowed("useTerminalSession.deny"));
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult, sessionIdRef]);

  const handleAbort = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      writePty(sid, "\x03").catch(logSwallowed("useTerminalSession.abort"));
    }
    setShowApproval(false);
    detectorResult.clearApproval();
  }, [detectorResult, sessionIdRef]);

  const clearApproval = detectorResult.clearApproval;

  return {
    sessionId: currentSessionId,
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
