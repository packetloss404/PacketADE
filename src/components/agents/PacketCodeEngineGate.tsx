/**
 * Engine gate for the PacketCode ACP route.
 *
 * PacketBench's third transport needs a separately-installed `packetcode`
 * engine. Without this gate a missing engine surfaced only as a failed session
 * start, several clicks deep, with a backend error string for an explanation.
 *
 * The states, all derived from one {@link AcpEngineProbe}:
 *
 * | probe                                 | state             |
 * |---------------------------------------|-------------------|
 * | `found && compatible`                 | ready — no chrome |
 * | `!found`                              | missing           |
 * | `found && !compatible`, no version    | did not respond   |
 * | `found && !compatible`, has version   | too old           |
 * | any of the above, `!installSupported` | manual steps only |
 *
 * "did not respond" is split out of "too old" on purpose — see
 * {@link engineGateState}. Only the version-bearing case can honestly tell the
 * user their engine is out of date.
 *
 * `installSupported` is not another state: it is a modifier on the actionable
 * ones that replaces the install button with the probe's own `detail` text. A
 * dead button is worse than no button.
 *
 * **Installing is always an explicit click.** `acp_install_engine` downloads
 * and runs packetcode's published install script; that is remote code
 * execution, and the backend refuses to take a URL parameter precisely so the
 * only thing that can trigger it is a user pressing a button that says so.
 * Nothing here installs on mount, on retry, or on a re-probe.
 *
 * **Installing is not the only remedy, and often not the right one.** The
 * common reason PacketBench cannot find the engine is not that the engine is
 * absent — it is that packetcode's own installers do not put it on `PATH`, and
 * a build from source lands somewhere nothing searches. Downloading a second
 * copy is the wrong answer for that user, so every non-ready state also offers
 * {@link AcpEnginePathField} to point at the binary they already have.
 *
 * The happy path pays nothing: when the engine is ready this renders
 * `children` directly, with no wrapper element.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AlertTriangle, ArrowLeft, Download, Loader2, PackageX, RefreshCw, Terminal } from "lucide-react";
import {
  ACP_INSTALL_OUTPUT_EVENT,
  acpInstallEngine,
  acpProbe,
  type AcpEngineProbe,
  type AcpInstallOutput,
} from "@/lib/tauri";
import {
  classifyInstallFailure,
  engineGateState,
  errorText,
  readCachedProbe,
  writeCachedProbe,
  type InstallFailure,
} from "@/components/agents/engineGateState";
import { AcpEnginePathField } from "@/components/agents/AcpEnginePathField";

/** How many installer lines to keep. The script is chatty on a slow link. */
const MAX_LOG_LINES = 400;

interface GateShellProps {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}

/** Chrome shared by every non-ready state. */
function GateShell({ icon, title, children }: GateShellProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-bg-primary">
      <div className="mx-auto w-full max-w-[600px] px-6 py-10">
        <div className="rounded-lg border border-bg-border bg-bg-secondary p-5">
          <div className="flex items-center gap-2.5">
            <div className="grid h-7 w-7 place-items-center rounded border border-accent-line bg-accent-soft">
              {icon}
            </div>
            <h2 className="text-[13px] font-semibold text-text-primary">{title}</h2>
          </div>
          <div className="mt-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** The probe's own diagnostic / manual-install text, verbatim and selectable. */
function ProbeDetail({ detail }: { detail: string }) {
  return (
    <p className="selectable mt-3 whitespace-pre-wrap rounded border border-bg-border bg-bg-tertiary p-2 font-mono text-meta text-text-muted">
      {detail}
    </p>
  );
}

const BUTTON_BASE =
  "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-ui font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON = `${BUTTON_BASE} border border-accent-line bg-accent-soft text-accent-green hover:border-accent-green active:bg-bg-hover`;
const SECONDARY_BUTTON = `${BUTTON_BASE} border border-bg-border bg-bg-tertiary text-text-secondary hover:bg-bg-elevated active:bg-bg-hover`;

export interface PacketCodeEngineGateProps {
  /** Rendered as-is, with no wrapper, once the engine is ready. */
  children: ReactNode;
  /**
   * Escape hatch, required whenever this gate is rendered INSIDE a surface the
   * user cannot otherwise leave.
   *
   * As a whole-route wrapper the gate had no need for one — the Left Rail was
   * still there. Now that PacketCode is a provider selected inside the single
   * Agents pane rather than a route of its own, the gate can replace the very
   * composer that holds the provider picker. Without this the user would be
   * pinned to a provider they cannot use and unable to pick another.
   */
  onUseAnotherProvider?: () => void;
}

export function PacketCodeEngineGate({
  children,
  onUseAnotherProvider,
}: PacketCodeEngineGateProps) {
  const [probe, setProbe] = useState<AcpEngineProbe | null>(readCachedProbe);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<InstallFailure | null>(null);
  const [log, setLog] = useState<AcpInstallOutput[]>([]);

  const aliveRef = useRef(true);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // One unmount cleanup for both the alive flag and the install listener, so
  // an install that is still streaming when the user navigates away detaches
  // rather than setting state on a dead component.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const next = await acpProbe();
      writeCachedProbe(next);
      if (!aliveRef.current) return next;
      setProbe(next);
      // A fresh verdict retires the previous attempt's failure banner.
      if (engineGateState(next) === "ready") setFailure(null);
      return next;
    } catch (reason) {
      if (aliveRef.current) setProbeError(errorText(reason));
      return null;
    } finally {
      if (aliveRef.current) setProbing(false);
    }
  }, []);

  // Probe on mount — never install on mount.
  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log]);

  const install = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setFailure(null);
    setLog([]);
    // Subscribe BEFORE invoking: the installer's first lines can land before
    // the invoke promise settles, and `listen` is itself async.
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<AcpInstallOutput>(ACP_INSTALL_OUTPUT_EVENT, (event) => {
        if (!aliveRef.current) return;
        setLog((prev) => {
          const next = [...prev, event.payload];
          return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
        });
      });
      if (!aliveRef.current) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;

      // Resolves with a probe the backend has already gated on
      // `found && compatible`, so this is the transition straight to ready.
      const installed = await acpInstallEngine();
      writeCachedProbe(installed);
      if (!aliveRef.current) return;
      setProbe(installed);
      setProbeError(null);
      if (engineGateState(installed) !== "ready") {
        // Defensive: the backend promises a gated probe. If that ever stops
        // being true, say so rather than looping the user through a gate with
        // no explanation.
        setFailure({
          kind: "unknown",
          raw: "The installer finished, but the engine still is not usable. See the log above.",
        });
      }
    } catch (reason) {
      if (aliveRef.current) setFailure(classifyInstallFailure(reason));
    } finally {
      // Detach on completion as well as on unmount — a finished install has no
      // more output, and leaving the subscription up would leak one listener
      // per attempt.
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      } else {
        unlisten?.();
      }
      if (aliveRef.current) setInstalling(false);
    }
  }, [installing]);

  // --- Ready: no chrome, no wrapper -----------------------------------------
  if (probe && engineGateState(probe) === "ready" && !installing) {
    return <>{children}</>;
  }

  // --- First probe still in flight ------------------------------------------
  // Deliberately minimal: showing "engine missing" before the probe has
  // answered would be a lie, and a full-size skeleton would flash on a route
  // the user visits constantly.
  if (!probe && !probeError) {
    return (
      <div
        role="status"
        className="flex h-full w-full items-center justify-center gap-2 bg-bg-primary text-ui text-text-faint"
      >
        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
        Checking for the packetcode engine…
      </div>
    );
  }

  // --- The probe itself failed ----------------------------------------------
  if (!probe && probeError) {
    return (
      <GateShell
        icon={<AlertTriangle size={14} className="text-accent-red" />}
        title="Could not check for the packetcode engine"
      >
        <p className="text-ui text-text-secondary">
          PacketBench could not run its engine check. Nothing was installed or changed.
        </p>
        <ProbeDetail detail={probeError} />
        <div className="mt-3">
          <ReprobeButton onClick={runProbe} probing={probing} />
        </div>
      </GateShell>
    );
  }

  // From here `probe` is non-null and is one of the non-ready gate states.
  const current = probe as AcpEngineProbe;
  const state = engineGateState(current);
  const canInstall = current.installSupported;

  const title =
    state === "missing"
      ? "packetcode is not installed"
      : state === "unresponsive"
        ? "packetcode did not answer"
        : "packetcode is too old";
  const icon =
    state === "missing" ? (
      <PackageX size={14} className="text-accent-green" />
    ) : (
      <AlertTriangle size={14} className="text-accent-amber" />
    );
  const actionLabel =
    state === "missing"
      ? "Install packetcode"
      : state === "unresponsive"
        ? "Reinstall packetcode"
        : "Update packetcode";

  return (
    <GateShell icon={icon} title={title}>
      <p className="text-ui leading-relaxed text-text-secondary">
        PacketCode is a separate coding engine that PacketBench drives over the Agent Client
        Protocol. It ships as its own binary, is not bundled with PacketBench, and holds its own
        provider credentials — there is no API key to add for it. Every other agent provider keeps
        working without it.
      </p>

      {state === "unresponsive" ? (
        <p className="mt-3 text-ui leading-relaxed text-text-secondary">
          A file was found and run{current.path ? " at the path below" : ""}, but it did not report
          a version. That usually means it is not the packetcode engine, or that it hung instead of
          answering — not that it is out of date.
        </p>
      ) : null}

      {state === "unresponsive" && current.path ? (
        <p className="selectable mt-3 break-all rounded border border-bg-border bg-bg-tertiary p-2 font-mono text-meta text-text-muted">
          {current.path}
        </p>
      ) : null}

      {state === "incompatible" ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-bg-border bg-bg-tertiary p-2 text-meta">
          <dt className="text-text-muted">Installed</dt>
          <dd className="selectable font-mono text-text-primary">
            {current.version ?? "unknown"}
          </dd>
          <dt className="text-text-muted">Required</dt>
          <dd className="selectable font-mono text-accent-amber">{current.minimumVersion}</dd>
          {current.path ? (
            <>
              <dt className="text-text-muted">Path</dt>
              <dd className="selectable break-all font-mono text-text-muted">{current.path}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {canInstall ? (
        <>
          <p className="mt-3 text-ui leading-relaxed text-text-muted">
            {state === "missing"
              ? "Installing downloads and runs packetcode's official install script."
              : state === "unresponsive"
                ? "Reinstalling downloads and runs packetcode's official install script, which replaces the binary in place."
                : "Updating downloads and runs packetcode's official install script, which upgrades in place."}{" "}
            This can take several minutes on a slow connection, and is cancelled automatically
            after 10 minutes.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => void install()}
              disabled={installing || probing}
            >
              {installing ? (
                <>
                  <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                  Installing…
                </>
              ) : (
                <>
                  <Download size={12} />
                  {failure ? "Retry install" : actionLabel}
                </>
              )}
            </button>
            <ReprobeButton onClick={runProbe} probing={probing} disabled={installing} />
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-start gap-2 rounded border border-bg-border bg-bg-tertiary p-2">
            <Terminal size={12} className="mt-0.5 shrink-0 text-text-muted" />
            <p className="text-ui leading-relaxed text-text-secondary">
              PacketBench cannot install the engine on this platform. Install it by hand, then
              re-check.
            </p>
          </div>
          <div className="mt-3">
            <ReprobeButton onClick={runProbe} probing={probing} />
          </div>
        </>
      )}

      {installing || log.length > 0 ? (
        <div
          ref={logRef}
          role="log"
          aria-label="Installer output"
          className="selectable mt-3 max-h-56 overflow-y-auto rounded border border-bg-border bg-bg-primary p-2 font-mono text-meta"
        >
          {log.length === 0 ? (
            <div className="text-text-faint">Waiting for the installer…</div>
          ) : (
            log.map((line, index) => (
              <div
                key={`${index}-${line.line}`}
                data-stream={line.stream}
                className={
                  line.stream === "stderr"
                    ? "whitespace-pre-wrap break-all text-accent-amber"
                    : "whitespace-pre-wrap break-all text-text-muted"
                }
              >
                {line.line}
              </div>
            ))
          )}
        </div>
      ) : null}

      {failure ? <InstallFailureNotice failure={failure} /> : null}

      {/* The other half of the remedy, and for a great many users the right
          half: they already have the binary, it is simply not on PATH.
          Adopting the returned probe means a successful pin drops straight
          through to the route without a second round trip. */}
      <div className="mt-4 border-t border-bg-border pt-3">
        <p className="mb-2 text-ui leading-relaxed text-text-muted">
          Already have it? packetcode&apos;s own installers do not add it to{" "}
          <span className="font-mono text-text-secondary">PATH</span>, and a build from source is
          not on it either. Point PacketBench at the binary instead of downloading another copy.
        </p>
        <AcpEnginePathField
          onProbe={(next) => {
            writeCachedProbe(next);
            if (!aliveRef.current) return;
            setProbe(next);
            setProbeError(null);
            if (engineGateState(next) === "ready") setFailure(null);
          }}
        />
      </div>

      {/* The probe's own diagnostic — on an unsupported platform this is the
          manual install instructions, which is the whole content of that
          state. */}
      {current.detail ? <ProbeDetail detail={current.detail} /> : null}

      {onUseAnotherProvider ? (
        <div className="mt-4 border-t border-bg-border pt-3">
          <button type="button" className={SECONDARY_BUTTON} onClick={onUseAnotherProvider}>
            <ArrowLeft size={12} />
            Use a different provider
          </button>
        </div>
      ) : null}
    </GateShell>
  );
}

function ReprobeButton({
  onClick,
  probing,
  disabled,
}: {
  onClick: () => void | Promise<unknown>;
  probing: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={SECONDARY_BUTTON}
      onClick={() => void onClick()}
      disabled={probing || disabled}
    >
      <RefreshCw
        size={12}
        className={probing ? "animate-spin motion-reduce:animate-none" : undefined}
      />
      {probing ? "Checking…" : "Check again"}
    </button>
  );
}

/**
 * The failure banner.
 *
 * Every classified kind gets its own sentence and the backend string is
 * withheld — a user who is told "its executable is in use" learns nothing they
 * can act on. Only `unknown` shows the raw text, because there is nothing
 * better to show and hiding it would be worse.
 */
function InstallFailureNotice({ failure }: { failure: InstallFailure }) {
  if (failure.kind === "engineRunning") {
    return (
      <div className="mt-3 rounded border border-bg-border bg-bg-elevated p-2.5">
        <p className="text-ui font-medium text-accent-amber">The engine is currently running</p>
        <p className="mt-1 text-ui leading-relaxed text-text-secondary">
          A running packetcode cannot have its own executable replaced. Close or stop any
          PacketCode conversations that are still active, wait for the engine to shut down, then
          try again.
        </p>
      </div>
    );
  }

  if (failure.kind === "installInProgress") {
    return (
      <div className="mt-3 rounded border border-bg-border bg-bg-elevated p-2.5">
        <p className="text-ui font-medium text-accent-amber">An install is already running</p>
        <p className="mt-1 text-ui leading-relaxed text-text-secondary">
          Only one engine install can run at a time. Wait for the one in progress to finish, then
          check again.
        </p>
      </div>
    );
  }

  if (failure.kind === "timedOut") {
    return (
      <div className="mt-3 rounded border border-bg-border bg-bg-elevated p-2.5">
        <p className="text-ui font-medium text-accent-amber">The installer timed out</p>
        <p className="mt-1 text-ui leading-relaxed text-text-secondary">
          It ran for 10 minutes without finishing and was stopped. Check your connection and try
          again, or install packetcode by hand.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded border border-bg-border bg-bg-elevated p-2.5">
      <p className="text-ui font-medium text-accent-red">The install did not complete</p>
      <p className="selectable mt-1 whitespace-pre-wrap break-words font-mono text-meta text-text-secondary">
        {failure.raw}
      </p>
    </div>
  );
}
