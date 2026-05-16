import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CheckStatus } from "./CheckStatusBadge";

/**
 * Tauri event bridge for the streaming diagnostics runner.
 *
 * Backed by `src-tauri/src/commands/quality_runner.rs`. The runner emits
 * three event families:
 *
 *   - `quality:chunk:<runId>`  — one stdout/stderr line at a time, payload
 *     is `QualityChunkEvent { runId, checkId, stream, line }` (camelCase
 *     because Rust serialises `#[serde(rename_all = "camelCase")]`).
 *   - `quality:done:<runId>`   — a single `QualityRunSummary` when the run
 *     finishes (or is cancelled). Each per-check result inside
 *     `summary.checks` carries the final status and timing.
 *   - `quality:error:<runId>`  — fatal/uncaught only. Per-check failures
 *     surface via the per-check `error` field, not this channel.
 *
 * Backend → frontend status mapping: the Rust enum is kebab-cased and
 * narrower than the UI state (no `idle`/`queued`/`running` — those are
 * local-only). `normaliseBackendStatus` collapses the wire values onto our
 * `CheckStatus` union so a chunk consumer doesn't have to deal with two
 * vocabularies.
 */
export interface QualityChunkPayload {
  runId: string;
  checkId: string;
  stream: "stdout" | "stderr";
  line: string;
}

/** Per-check result, mirroring the backend `QualityCheckDoneEvent`. */
export interface QualityCheckResult {
  runId: string;
  checkId: string;
  label: string;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  status: CheckStatus;
  error: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  optional: boolean;
}

/** Aggregate emitted on `quality:done:<runId>`. */
export interface QualityRunSummary {
  runId: string;
  projectPath: string;
  checks: QualityCheckResult[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  cancelled: boolean;
  allPassed: boolean;
}

export interface QualityStreamHandlers {
  onChunk: (payload: QualityChunkPayload) => void;
  onDone: (summary: QualityRunSummary) => void;
  onError: (message: string) => void;
}

// Wire-shape of the per-check done event before status normalisation.
interface RawCheckDoneEvent {
  runId: string;
  checkId: string;
  label: string;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  status: string;
  error: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  optional: boolean;
}

interface RawSummary {
  runId: string;
  projectPath: string;
  checks: RawCheckDoneEvent[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  cancelled: boolean;
  allPassed: boolean;
}

/**
 * Collapse the backend's narrower CheckStatus enum onto the UI union. The
 * UI adds `idle`/`queued`/`running` for its own state machine; the backend
 * only emits terminal statuses.
 */
export function normaliseBackendStatus(raw: string): CheckStatus {
  switch (raw) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "timed-out":
    case "missing-tool":
    case "spawn-error":
      return "errored";
    default:
      // Unknown — be loud but don't crash the stream.
      console.warn("[qualityStream] unknown backend status:", raw);
      return "errored";
  }
}

/**
 * Subscribe to a single run's chunk/done/error events. Returns an unlisten
 * function that the caller must invoke on teardown (mount/effect cleanup,
 * modal close mid-run, etc.). All three sub-listeners are torn down together
 * so callers can never forget one.
 */
export async function subscribeQualityStream(
  runId: string,
  handlers: QualityStreamHandlers,
): Promise<UnlistenFn> {
  const unlistenChunk = await listen<QualityChunkPayload>(`quality:chunk:${runId}`, (e) => {
    handlers.onChunk(e.payload);
  });
  const unlistenDone = await listen<RawSummary>(`quality:done:${runId}`, (e) => {
    const raw = e.payload;
    handlers.onDone({
      runId: raw.runId,
      projectPath: raw.projectPath,
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
      durationMs: raw.durationMs,
      cancelled: raw.cancelled,
      allPassed: raw.allPassed,
      checks: raw.checks.map((c) => ({
        runId: c.runId,
        checkId: c.checkId,
        label: c.label,
        output: c.output,
        truncated: c.truncated,
        exitCode: c.exitCode,
        status: normaliseBackendStatus(c.status),
        error: c.error,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        durationMs: c.durationMs,
        optional: c.optional,
      })),
    });
  });
  const unlistenError = await listen<{ message: string }>(`quality:error:${runId}`, (e) => {
    handlers.onError(e.payload?.message || "Quality check failed");
  });
  return () => {
    unlistenChunk();
    unlistenDone();
    unlistenError();
  };
}
