/**
 * The decisions behind {@link PacketCodeEngineGate}, kept out of the component
 * so they can be read, tested, and reasoned about without a renderer.
 *
 * Everything here is about being honest with the user: which gate state a
 * probe actually implies (and, just as importantly, which one it does NOT
 * license claiming), and which install failures have a remedy worth naming
 * instead of a backend sentence worth echoing.
 */
import type { AcpEngineProbe } from "@/lib/tauri";

/** Which gate (if any) a probe result calls for. */
export type EngineGateState = "ready" | "missing" | "unresponsive" | "incompatible";

/**
 * The single place the gate states are decided. `compatible` is only
 * meaningful when `found` is true, so the order matters: a probe claiming both
 * `found: false` and `compatible: true` must still read as missing.
 *
 * **`unresponsive` is not the same as `incompatible`.** The backend sets
 * `compatible: false` whenever it cannot satisfy itself that the version is new
 * enough — including when the binary exists but never reported a version at
 * all, which is what a `doctor --json` timeout and a doctor report with no
 * version field both look like. Calling that "too old" is a guess dressed as a
 * diagnosis, and it sends the user to update a binary that may be perfectly
 * current and merely wedged (or not the engine at all). A missing `version` is
 * therefore its own state, and `incompatible` — the only one that quotes a
 * version number at the user — is reached only when there is a version to
 * quote.
 *
 * `installSupported` is deliberately not a state here. It modifies what the
 * non-ready gates *offer* (a button, or the probe's manual steps), not which
 * gate is shown.
 */
export function engineGateState(probe: AcpEngineProbe): EngineGateState {
  if (!probe.found) return "missing";
  if (probe.compatible) return "ready";
  return probe.version?.trim() ? "incompatible" : "unresponsive";
}

/**
 * Why an install attempt failed, in the terms a user can act on.
 *
 * `engineRunning` is the one that matters: the backend refuses to install over
 * a live engine because a running executable cannot be replaced on Windows and
 * is silently left stale everywhere else. That is a normal, recoverable
 * situation with a concrete remedy, so it must not reach the user as the raw
 * rejection string.
 */
export type InstallFailureKind = "engineRunning" | "installInProgress" | "timedOut" | "unknown";

export interface InstallFailure {
  kind: InstallFailureKind;
  /** The backend's own text. Shown only for `unknown`. */
  raw: string;
}

/** Best-effort text of a rejected Tauri invoke (they reject with strings). */
export function errorText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(reason);
}

/**
 * Map a rejection from `acp_install_engine` onto {@link InstallFailure}.
 *
 * Matched on substrings rather than equality: the backend composes some of
 * these messages, and a gate that silently degraded to "unknown" after a
 * wording tweak would put the raw string back in front of the user — exactly
 * what this exists to prevent. Both halves of the engine-running sentence are
 * accepted so either can be reworded without breaking detection.
 */
export function classifyInstallFailure(reason: unknown): InstallFailure {
  const raw = errorText(reason);
  const text = raw.toLowerCase();
  if (text.includes("executable is in use") || text.includes("stop the packetcode engine")) {
    return { kind: "engineRunning", raw };
  }
  if (text.includes("install is already running")) {
    return { kind: "installInProgress", raw };
  }
  if (text.includes("timed out")) {
    return { kind: "timedOut", raw };
  }
  return { kind: "unknown", raw };
}

/**
 * Last probe answer, remembered for the lifetime of the app session.
 *
 * The route is mounted and unmounted every time the user navigates to it, and
 * a probe is fast but not instant. Without this, every visit would blank the
 * pane — or worse, flash a gate — before the answer arrived. With it, only the
 * first visit waits; later ones paint the known verdict immediately and
 * re-probe in the background, so an engine installed outside PacketBench is
 * still picked up.
 */
let cachedProbe: AcpEngineProbe | null = null;

export function readCachedProbe(): AcpEngineProbe | null {
  return cachedProbe;
}

export function writeCachedProbe(probe: AcpEngineProbe): void {
  cachedProbe = probe;
}

/** Test seam: forget the cached probe between cases. */
export function resetEngineProbeCache(): void {
  cachedProbe = null;
}
