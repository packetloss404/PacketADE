import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  syndicatePaneCreate,
  syndicateSessionAttach,
  syndicateSessionInput,
  syndicateSessionResize,
  syndicateSessionStart,
  syndicateSessionStop,
} from "@/lib/tauri";
import { useSyndicateStore } from "@/stores/syndicateStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  parseSessionResult,
  syndicateConnection,
  type SyndicateReplayResult,
} from "@/types/syndicate";
import type { WorkspaceAgentSlot, WorkspacePane } from "@/types/workspace";
import type { TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import "@xterm/xterm/css/xterm.css";

interface SyndicateTerminalPaneProps {
  pane: WorkspacePane;
  workspaceId: string;
  machineId: string;
  hostWorkspaceId: string;
  initialPrompt?: string;
  autoStart?: boolean;
  renderHeader: (state: TerminalHeaderRenderState) => ReactNode;
}

interface HostPaneResult {
  pane: { id: string };
  terminalSession: { id: string };
}

function remoteProfile(agentId: WorkspaceAgentSlot): "codex" | "claude" | "packetcode" {
  if (agentId === "codex" || agentId === "packetcode") return agentId;
  if (agentId === "claude-code") return "claude";
  throw new Error(`${agentId} is not an allowlisted Syndicate CLI profile`);
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`Invalid Syndicate ${label}`);
  return value as Record<string, unknown>;
}

function parseHostPane(value: unknown): HostPaneResult {
  const object = asObject(value, "pane.create response");
  const pane = asObject(object.pane, "pane identity");
  const terminalSession = asObject(object.terminalSession, "terminal session identity");
  if (typeof pane.id !== "string" || typeof terminalSession.id !== "string") {
    throw new Error("Syndicate pane.create response is missing host identities");
  }
  return { pane: { id: pane.id }, terminalSession: { id: terminalSession.id } };
}

function writeReplay(
  term: Terminal,
  decoder: TextDecoder,
  replay: SyndicateReplayResult | undefined,
  cursor: number,
): number {
  let next = cursor;
  if (replay?.truncated) {
    term.write("\r\n\x1b[33m[Syndicate output history has a replay gap]\x1b[0m\r\n");
  }
  for (const chunk of replay?.chunks ?? []) {
    if (typeof chunk.sequence !== "number" || typeof chunk.dataBase64 !== "string") continue;
    if (chunk.sequence <= next) continue;
    term.write(decoder.decode(decodeBase64(chunk.dataBase64), { stream: true }));
    next = chunk.sequence;
  }
  if (typeof replay?.nextAfterSequence === "number") next = Math.max(next, replay.nextAfterSequence);
  return next;
}

export function SyndicateTerminalPane({
  pane,
  workspaceId,
  machineId,
  hostWorkspaceId,
  initialPrompt,
  autoStart = true,
  renderHeader,
}: SyndicateTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef(pane.syndicateSessionId ?? null);
  const hostPaneIdRef = useRef(pane.syndicatePaneId ?? null);
  const terminalSessionIdRef = useRef(pane.syndicateTerminalSessionId ?? null);
  const operationGenerationRef = useRef(pane.syndicateOperationGeneration ?? 0);
  const cursorRef = useRef(pane.syndicateCursor ?? 0);
  const persistedCursorRef = useRef(pane.syndicateCursor ?? 0);
  const cursorTimerRef = useRef<number | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const mountedRef = useRef(true);
  const startedRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const [alive, setAlive] = useState(Boolean(pane.syndicateSessionId));
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const machine = useSyndicateStore((state) => state.machines.find((item) => item.machineId === machineId));
  const hasScope = useCallback(
    (scope: string) => machine?.grantStatus === "active" && machine.scopes.includes(scope as never),
    [machine],
  );

  const updatePane = useCallback(
    (updates: Partial<WorkspacePane>) =>
      useWorkspaceStore.getState().updatePane(workspaceId, pane.id, updates),
    [pane.id, workspaceId],
  );

  const flushCursor = useCallback(() => {
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
    if (cursorRef.current === persistedCursorRef.current) return;
    persistedCursorRef.current = cursorRef.current;
    updatePane({ syndicateCursor: cursorRef.current });
  }, [updatePane]);

  const persistCursor = useCallback(
    (cursor: number) => {
      if (cursor <= cursorRef.current) return;
      cursorRef.current = cursor;
      if (cursorTimerRef.current === null) {
        cursorTimerRef.current = window.setTimeout(flushCursor, 250);
      }
    },
    [flushCursor],
  );

  const pollOutput = useCallback(
    async (generation: number, hostPaneId: string, terminalSessionId: string) => {
      if (!machine) return;
      let delay = 350;
      while (mountedRef.current && pollGenerationRef.current === generation && sessionIdRef.current) {
        try {
          const response = await syndicateSessionAttach({
            connection: syndicateConnection(machine),
            paneId: hostPaneId,
            terminalSessionId,
            sessionId: sessionIdRef.current,
            afterSequence: cursorRef.current,
          });
          if (!mountedRef.current || pollGenerationRef.current !== generation) return;
          const attached = parseSessionResult(response.result);
          const before = cursorRef.current;
          const after = writeReplay(termRef.current!, decoderRef.current, attached.replay, before);
          persistCursor(after);
          if (attached.session.state && attached.session.state !== "running") {
            setAlive(false);
            setReconnecting(false);
            break;
          }
          setError(null);
          setReconnecting(false);
          delay = after > before || attached.replay?.hasMore ? 25 : 350;
        } catch (reason) {
          if (!mountedRef.current || pollGenerationRef.current !== generation) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          if (/DEVICE_REVOKED|SCOPE_DENIED|SESSION_NOT_FOUND|SESSION_NOT_OWNED/.test(message)) {
            setAlive(false);
            setReconnecting(false);
            break;
          }
          setReconnecting(true);
          delay = Math.min(delay * 2, 5_000);
        }
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    },
    [machine, persistCursor],
  );

  const startOrAttach = useCallback(async () => {
    if (!machine) {
      setError("This Syndicate machine is no longer paired.");
      return;
    }
    const term = termRef.current;
    if (!term) return;
    setError(null);
    try {
      let hostPaneId = hostPaneIdRef.current;
      let terminalSessionId = terminalSessionIdRef.current;
      let sessionId = sessionIdRef.current;
      const connection = syndicateConnection(machine);

      if (!hostPaneId || !terminalSessionId) {
        if (!hasScope("workspace.create") || !hasScope("session.start") || !hasScope("terminal.view")) {
          throw new Error("This device grant cannot create and start Syndicate terminal panes.");
        }
        const created = parseHostPane(
          (
            await syndicatePaneCreate({
              connection,
              workspaceId: hostWorkspaceId,
              title: `${pane.agentId} pane`,
              profileId: remoteProfile(pane.agentId),
              clientOperationId: `${pane.id}.${operationGenerationRef.current}`,
            })
          ).result,
        );
        hostPaneId = created.pane.id;
        terminalSessionId = created.terminalSession.id;
        hostPaneIdRef.current = hostPaneId;
        terminalSessionIdRef.current = terminalSessionId;
        updatePane({
          syndicatePaneId: hostPaneId,
          syndicateTerminalSessionId: terminalSessionId,
        });
      }

      if (sessionId) {
        if (!hasScope("terminal.view")) {
          throw new Error("This device grant cannot view terminal output.");
        }
        const attached = parseSessionResult(
          (
            await syndicateSessionAttach({
              connection,
              paneId: hostPaneId,
              terminalSessionId,
              sessionId,
              afterSequence: cursorRef.current,
            })
          ).result,
        );
        sessionId = attached.session.sessionId;
        persistCursor(writeReplay(term, decoderRef.current, attached.replay, cursorRef.current));
      } else {
        const started = parseSessionResult(
          (
            await syndicateSessionStart({
              connection,
              paneId: hostPaneId,
              terminalSessionId,
              profileId: remoteProfile(pane.agentId),
              cols: Math.max(2, term.cols),
              rows: Math.max(2, term.rows),
            })
          ).result,
        );
        sessionId = started.session.sessionId;
        cursorRef.current = 0;
        persistedCursorRef.current = 0;
        decoderRef.current = new TextDecoder();
        updatePane({ syndicateSessionId: sessionId, syndicateCursor: 0 });
        if (initialPrompt?.trim() && hasScope("terminal.input")) {
          await syndicateSessionInput({
            connection,
            sessionId,
            frameId: crypto.randomUUID(),
            inputBase64: encodeBase64(`${initialPrompt.trim()}\r`),
          });
        }
      }
      if (!mountedRef.current) return;
      sessionIdRef.current = sessionId;
      setAlive(true);
      setReconnecting(false);
      const generation = ++pollGenerationRef.current;
      void pollOutput(generation, hostPaneId, terminalSessionId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      term.write(`\r\n\x1b[31m[Syndicate] ${message}\x1b[0m\r\n`);
      setAlive(false);
    }
  }, [hasScope, hostWorkspaceId, initialPrompt, machine, pane, persistCursor, pollOutput, updatePane]);

  const stop = useCallback(async () => {
    if (sessionIdRef.current) {
      if (!machine) {
        throw new Error("The paired Syndicate machine is unavailable; the remote session was preserved.");
      }
      if (!hasScope("terminal.stop")) {
        throw new Error("This device grant cannot stop the remote terminal session.");
      }
      await syndicateSessionStop({
        connection: syndicateConnection(machine),
        sessionId: sessionIdRef.current,
      });
    }
    pollGenerationRef.current += 1;
    sessionIdRef.current = null;
    hostPaneIdRef.current = null;
    terminalSessionIdRef.current = null;
    operationGenerationRef.current += 1;
    setAlive(false);
    cursorRef.current = 0;
    persistedCursorRef.current = 0;
    decoderRef.current = new TextDecoder();
    updatePane({
      syndicatePaneId: undefined,
      syndicateTerminalSessionId: undefined,
      syndicateSessionId: undefined,
      syndicateCursor: 0,
      syndicateOperationGeneration: operationGenerationRef.current,
    });
  }, [hasScope, machine, updatePane]);

  const restart = useCallback(async () => {
    if (sessionIdRef.current) await stop();
    await startOrAttach();
  }, [startOrAttach, stop]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.15,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9", cursor: "#00ff41" },
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* layout not ready */ }

    const dataDisposable = term.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!machine || !sessionId || !hasScope("terminal.input")) return;
      // Never retry input automatically: a lost response can mean delivery is
      // uncertain, and replaying keystrokes would duplicate code-execution authority.
      void syndicateSessionInput({
        connection: syndicateConnection(machine),
        sessionId,
        frameId: crypto.randomUUID(),
        inputBase64: encodeBase64(data),
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current;
      if (!machine || !sessionId || !hasScope("terminal.resize") || cols < 2 || rows < 2) return;
      void syndicateSessionResize({
        connection: syndicateConnection(machine),
        sessionId,
        cols,
        rows,
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    });
    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetWidth < 1 || container.offsetHeight < 1) return;
      try { fit.fit(); } catch { /* hidden layout */ }
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [hasScope, machine]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      const timer = window.setTimeout(() => void startOrAttach(), 200);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [autoStart, startOrAttach]);

  useEffect(
    () => () => {
      // Detach only. The Host owns the session and keeps it running.
      flushCursor();
      mountedRef.current = false;
      pollGenerationRef.current += 1;
    },
    [flushCursor],
  );

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      {renderHeader({
        alive,
        error,
        showApproval: false,
        cliCommand: `syndicate:${pane.agentId}`,
        onRestart: () => void restart(),
        onKill: () => void stop(),
      })}
      {error && (
        <div className="border-b border-accent-red/20 bg-accent-red/5 px-2 py-1 text-[9px] text-accent-red">
          {reconnecting ? "Reconnecting" : "Disconnected"} · {error}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1" />
      <div className="border-t border-bg-border px-2 py-1 text-[9px] text-text-muted">
        Syndicate · {machine?.displayName ?? machineId} · {alive ? "running" : "detached"} · {hasScope("terminal.input") ? "interactive" : "read-only; re-pair with terminal.input to control"} · cursor {cursorRef.current}
      </div>
    </div>
  );
}
