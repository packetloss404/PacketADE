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
import { SYNDICATE_INTEGRATION_DISABLED_MESSAGE } from "@/lib/syndicateIntegration";
import { isFatalSyndicateError } from "@/lib/syndicateErrors";
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
  if (typeof replay?.nextAfterSequence === "number")
    next = Math.max(next, replay.nextAfterSequence);
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
  const integrationPreferenceEnabled = useSyndicateStore((state) => state.enabled);
  const nativeReady = useSyndicateStore((state) => state.nativeReady);
  const nativeSyncError = useSyndicateStore((state) => state.nativeSyncError);
  const integrationEnabled = integrationPreferenceEnabled && nativeReady;
  const machine = useSyndicateStore((state) =>
    state.machines.find((item) => item.machineId === machineId),
  );
  const hasScope = useCallback(
    (scope: string) =>
      integrationEnabled &&
      machine?.grantStatus === "active" &&
      machine.scopes.includes(scope as never),
    [integrationEnabled, machine],
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
      while (
        mountedRef.current &&
        pollGenerationRef.current === generation &&
        sessionIdRef.current
      ) {
        const integration = useSyndicateStore.getState();
        if (!integration.enabled || !integration.nativeReady) {
          setAlive(false);
          setReconnecting(false);
          return;
        }
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
          useSyndicateStore
            .getState()
            .recordControllerFailure(machine.machineId, machine.deviceId, reason);
          setError(message);
          // Stop on the Host's own verdict. `retryable: false` covers every
          // terminal rejection — DEVICE_UNAUTHORIZED for an expired grant,
          // DEVICE_REVOKED, MACHINE_MISMATCH, INVALID_SIGNATURE, AUTH_REPLAY,
          // REQUEST_EXPIRED, SCOPE_DENIED — so this no longer depends on a
          // list of message fragments that a new code can silently fall
          // through. Local faults carry no verdict and stay reconnectable.
          if (message === SYNDICATE_INTEGRATION_DISABLED_MESSAGE || isFatalSyndicateError(reason)) {
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
    if (!integrationEnabled) {
      setError(SYNDICATE_INTEGRATION_DISABLED_MESSAGE);
      setAlive(false);
      return;
    }
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
        if (
          !hasScope("workspace.create") ||
          !hasScope("session.start") ||
          !hasScope("terminal.view")
        ) {
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
  }, [
    hasScope,
    hostWorkspaceId,
    initialPrompt,
    integrationEnabled,
    machine,
    pane,
    persistCursor,
    pollOutput,
    updatePane,
  ]);

  const stop = useCallback(async () => {
    if (!integrationEnabled) {
      throw new Error(
        `${SYNDICATE_INTEGRATION_DISABLED_MESSAGE} Re-enable it before stopping this preserved remote session.`,
      );
    }
    if (sessionIdRef.current) {
      if (!machine) {
        throw new Error(
          "The paired Syndicate machine is unavailable; the remote session was preserved.",
        );
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
  }, [hasScope, integrationEnabled, machine, updatePane]);

  /**
   * `stop` for the pane header's close action.
   *
   * It still rejects, so the caller keeps the pane rather than dropping it
   * while the Host session runs on. Recording the reason here as well means
   * the pane's own banner explains itself, instead of the failure living only
   * inside a modal the user is about to dismiss.
   */
  const stopFromHeader = useCallback(async () => {
    try {
      await stop();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, [stop]);

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
    try {
      fit.fit();
    } catch {
      /* layout not ready */
    }

    const dataDisposable = term.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!integrationEnabled || !machine || !sessionId || !hasScope("terminal.input")) return;
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
      if (
        !integrationEnabled ||
        !machine ||
        !sessionId ||
        !hasScope("terminal.resize") ||
        cols < 2 ||
        rows < 2
      )
        return;
      void syndicateSessionResize({
        connection: syndicateConnection(machine),
        sessionId,
        cols,
        rows,
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    });
    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetWidth < 1 || container.offsetHeight < 1) return;
      try {
        fit.fit();
      } catch {
        /* hidden layout */
      }
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
  }, [hasScope, integrationEnabled, machine]);

  useEffect(() => {
    if (integrationEnabled) return;
    pollGenerationRef.current += 1;
    startedRef.current = false;
    setAlive(false);
    setReconnecting(false);
    setError(null);
  }, [integrationEnabled]);

  // Reset only when the paired device actually *changes*. Running this
  // unconditionally on mount clobbered the restored `alive` state, so a pane
  // holding a live Host session rendered "detached" whenever autoStart was
  // off — and it cleared `startedRef` without clearing the session identity,
  // so after a re-pair the new device attached the previous device's session
  // and the Host answered SESSION_NOT_OWNED.
  const lastDeviceIdRef = useRef(machine?.deviceId);
  useEffect(() => {
    const previous = lastDeviceIdRef.current;
    const current = machine?.deviceId;
    if (previous === current) return;
    lastDeviceIdRef.current = current;
    // First resolution of the machine record: nothing has run under a device
    // yet, so restored state is still the truth.
    if (previous === undefined) return;

    pollGenerationRef.current += 1;
    startedRef.current = false;
    setAlive(false);
    setReconnecting(false);
    setError(null);
    // The machine going away (unpair, revoke) stops the pane but leaves the
    // record alone. Only a genuinely different device invalidates the
    // identities, which belong to the credential that created them.
    if (current === undefined) return;
    sessionIdRef.current = null;
    hostPaneIdRef.current = null;
    terminalSessionIdRef.current = null;
    cursorRef.current = 0;
    persistedCursorRef.current = 0;
    decoderRef.current = new TextDecoder();
    operationGenerationRef.current += 1;
    updatePane({
      syndicatePaneId: undefined,
      syndicateTerminalSessionId: undefined,
      syndicateSessionId: undefined,
      syndicateCursor: 0,
      syndicateOperationGeneration: operationGenerationRef.current,
    });
  }, [machine?.deviceId, updatePane]);

  useEffect(() => {
    mountedRef.current = true;
    if (integrationEnabled && autoStart && !startedRef.current) {
      startedRef.current = true;
      const timer = window.setTimeout(() => void startOrAttach(), 200);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [autoStart, integrationEnabled, startOrAttach]);

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
        onKill: stopFromHeader,
      })}
      {!integrationEnabled && (
        <div className="border-accent-amber/20 bg-accent-amber/5 border-b px-2 py-1 text-[9px] text-accent-amber">
          {!integrationPreferenceEnabled
            ? "Syndicate integration is disabled in Settings. This remote session is preserved and PacketBench will not reconnect or send input until you re-enable it."
            : nativeSyncError
              ? `Syndicate native synchronization failed: ${nativeSyncError}. This remote session is preserved; retry synchronization in Settings.`
              : "Applying the saved Syndicate setting. This remote session is preserved and transport remains blocked until initialization finishes."}
        </div>
      )}
      {error && (
        <div className="border-accent-red/20 bg-accent-red/5 border-b px-2 py-1 text-[9px] text-accent-red">
          {reconnecting ? "Reconnecting" : "Disconnected"} · {error}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1" />
      <div className="border-t border-bg-border px-2 py-1 text-[9px] text-text-muted">
        Syndicate · {machine?.displayName ?? machineId} ·{" "}
        {integrationEnabled
          ? alive
            ? "running"
            : "detached"
          : integrationPreferenceEnabled
            ? nativeSyncError
              ? "blocked"
              : "initializing"
            : "disabled"}{" "}
        ·{" "}
        {hasScope("terminal.input")
          ? "interactive"
          : integrationEnabled
            ? "read-only; re-pair with terminal.input to control"
            : "transport paused"}{" "}
        · cursor {cursorRef.current}
      </div>
    </div>
  );
}
