import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createPtySession,
  killPty,
  listPtySessions,
  readPtyTranscript,
  writePty,
} from "@/lib/tauri";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";
import {
  bufferedPtyRemainder,
  parsePtyOutputPayload,
  type PtyOutputPayload,
} from "@/lib/ptyReplay";

export type TransientPtyStatus = "idle" | "spawning" | "running" | "done" | "error";

export interface UseTransientPtyOptions {
  command: string;
  args?: string[] | null;
  projectPath?: string;
  /** Sent (with a trailing CR) after the PTY spawns. Useful for one-shot
   *  commands that need to be typed into a shell pane. */
  initialInput?: string;
  /** Extra environment for the spawned process. The multi-account CLI flow
   *  relies on this to run `claude login` / `codex login` against a specific
   *  account's config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) instead of the
   *  ambient one — without it, a second account could never be authenticated. */
  env?: Record<string, string>;
  /** Default xterm-ish geometry; callers rendering into a real xterm
   *  container should overwrite via `resizePty` after mounting. */
  cols?: number;
  rows?: number;
  /** If set, kill the PTY after this many ms of no exit. */
  timeoutMs?: number;
  onSpawn?: (sessionId: string) => void;
  onOutput?: (chunk: string) => void;
  onExit?: (success: boolean) => void;
  onError?: (err: unknown) => void;
}

export interface UseTransientPtyResult {
  status: TransientPtyStatus;
  sessionId: string | null;
  start: () => void;
  kill: () => void;
}

/**
 * Spawn a one-shot PTY, watch for completion, auto-cleanup on unmount.
 *
 * Imperative — caller decides when via `start()`. The hook tracks its own
 * lifecycle and guarantees the spawned PTY is killed when the component
 * unmounts (best-effort; PTY may already be dead).
 */
export function useTransientPty(opts: UseTransientPtyOptions): UseTransientPtyResult {
  const [status, setStatus] = useState<TransientPtyStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Pin callbacks into a ref so `start()` keeps a stable identity but always
  // sees the latest handlers.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const sessionIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);
  const mountedRef = useRef(true);

  const cleanup = useCallback(() => {
    for (const u of unlistenersRef.current) {
      try {
        u();
      } catch {
        // listener already torn down
      }
    }
    unlistenersRef.current = [];
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const kill = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void killPty(sid).catch(() => {});
  }, []);

  const start = useCallback(() => {
    if (finishedRef.current || sessionIdRef.current) return;
    const current = optsRef.current;
    setStatus("spawning");

    void (async () => {
      try {
        const sid = await createPtySession(
          current.projectPath ?? "",
          current.cols ?? 120,
          current.rows ?? 40,
          current.command,
          current.args ?? null,
          current.env ?? null,
        );
        if (!mountedRef.current) {
          void killPty(sid).catch(() => {});
          return;
        }
        sessionIdRef.current = sid;
        setSessionId(sid);
        setStatus("running");
        current.onSpawn?.(sid);

        let buffering = true;
        const buffered: PtyOutputPayload[] = [];
        let exitWhileBuffering = false;
        const finish = (success: boolean) => {
          if (finishedRef.current) return;
          if (buffering) {
            exitWhileBuffering = true;
            return;
          }
          finishedRef.current = true;
          cleanup();
          if (!mountedRef.current) return;
          setStatus(success ? "done" : "error");
          current.onExit?.(success);
        };

        const [outputUnlisten, exitUnlisten] = await Promise.all([
          listen<unknown>(ptyOutputEvent(sid), (event) => {
            const output = parsePtyOutputPayload(event.payload);
            if (buffering) {
              buffered.push(output);
            } else {
              current.onOutput?.(output.data);
            }
          }),
          listen<string>(ptyExitEvent(sid), () => {
            finish(true);
          }),
        ]);
        unlistenersRef.current = [outputUnlisten, exitUnlisten];
        if (finishedRef.current) {
          outputUnlisten();
          exitUnlisten();
          unlistenersRef.current = [];
        }

        const transcript = await readPtyTranscript(sid).catch(() => null);
        const replayed = transcript?.data ?? "";
        if (mountedRef.current && replayed) current.onOutput?.(replayed);
        const bufferedRemainder = bufferedPtyRemainder(replayed, transcript?.sequence, buffered);
        if (mountedRef.current && bufferedRemainder) current.onOutput?.(bufferedRemainder);
        buffering = false;
        if (exitWhileBuffering) finish(true);

        const sessions = await listPtySessions().catch(() => null);
        const liveSession = sessions?.find((s) => s.id === sid);
        if (sessions && (!liveSession || !liveSession.alive)) finish(true);
        if (finishedRef.current) return;

        if (current.timeoutMs && current.timeoutMs > 0) {
          timeoutRef.current = setTimeout(() => {
            // Best-effort kill — PTY may have just exited.
            void killPty(sid).catch(() => {});
            finish(false);
          }, current.timeoutMs);
        }

        if (current.initialInput) {
          // Trailing CR (not LF) — some Windows ConPTY configs won't fire
          // shells' Enter handler on bare LF. Mirrors the writePty pattern
          // used throughout the workspace pane code.
          await writePty(sid, current.initialInput + "\r").catch((err) => {
            console.warn("[useTransientPty] initial writePty failed:", err);
          });
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setStatus("error");
        current.onError?.(err);
        finishedRef.current = true;
        cleanup();
      }
    })();
  }, [cleanup]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
      const sid = sessionIdRef.current;
      if (sid && !finishedRef.current) {
        // Component went away before the PTY exited — kill it.
        void killPty(sid).catch(() => {});
      }
    };
  }, [cleanup]);

  return { status, sessionId, start, kill };
}

/**
 * Non-hook variant for callers that need transient PTY behaviour outside of
 * a React render tree (async loops, store actions, etc.). The `useServerConnection`
 * SSH probe is the canonical caller: it runs many sequential commands inside
 * a single `connect()` action where hooks aren't legal.
 */
export interface RunTransientPtyOptions {
  command: string;
  args?: string[] | null;
  projectPath?: string;
  initialInput?: string;
  /** Extra environment for the spawned process — see `UseTransientPtyOptions.env`. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
}

export interface RunTransientPtyResult {
  /** Concatenated PTY output. */
  output: string;
  /** True when the PTY exited on its own; false on timeout or spawn failure. */
  completed: boolean;
}

export async function runTransientPty(
  opts: RunTransientPtyOptions,
): Promise<RunTransientPtyResult> {
  const sessionId = await createPtySession(
    opts.projectPath ?? "",
    opts.cols ?? 120,
    opts.rows ?? 40,
    opts.command,
    opts.args ?? null,
    opts.env ?? null,
  );

  let output = "";
  let resolveExit: (value: boolean) => void = () => {};
  const exitPromise = new Promise<boolean>((resolve) => {
    resolveExit = resolve;
  });

  let buffering = true;
  const buffered: PtyOutputPayload[] = [];
  const [outputUnlisten, exitUnlisten] = await Promise.all([
    listen<unknown>(ptyOutputEvent(sessionId), (event) => {
      const eventOutput = parsePtyOutputPayload(event.payload);
      if (buffering) {
        buffered.push(eventOutput);
      } else {
        output += eventOutput.data;
      }
    }),
    listen<string>(ptyExitEvent(sessionId), () => {
      resolveExit(true);
    }),
  ]);

  const transcript = await readPtyTranscript(sessionId).catch(() => null);
  const replayed = transcript?.data ?? "";
  output += replayed;
  output += bufferedPtyRemainder(replayed, transcript?.sequence, buffered);
  buffering = false;

  const sessions = await listPtySessions().catch(() => null);
  const liveSession = sessions?.find((s) => s.id === sessionId);
  if (sessions && (!liveSession || !liveSession.alive)) resolveExit(true);

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let completed = false;
  try {
    if (opts.initialInput) {
      await writePty(sessionId, opts.initialInput + "\r").catch((err) => {
        console.warn("[runTransientPty] initial writePty failed:", err);
      });
    }
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      });
      completed = await Promise.race([exitPromise, timeoutPromise]);
    } else {
      completed = await exitPromise;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    outputUnlisten();
    exitUnlisten();
    if (!completed) {
      // Best-effort kill — PTY may already be dead.
      await killPty(sessionId).catch(() => {});
    }
  }

  return { output, completed };
}
