import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, RefreshCw, Sparkles } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelQualityRun,
  qualityEvents,
  runQualityChecks,
  type QualityCheckDoneEvent,
} from "@/lib/tauri";
import { QualityAISummary } from "./QualityAISummary";
import { clearQualityAISummaryCache } from "./qualityAIHelpers";

/**
 * v0.8.8 quality ai — bottom-of-Overview "AI summary" section.
 *
 * Self-contained wrapper that:
 *   1. Runs `runQualityChecks` (q1's runner) against the active project
 *   2. Collects every `quality:check-done:<runId>` event into a map keyed
 *      by check label
 *   3. Hands the failing checks to `QualityAISummary` for streaming
 *      analysis
 *
 * Lives in its own file so the modal stays small. q2 owns the failed-
 * checks UI (per-error rows + parsing) — once that lands, this panel can
 * either keep its own run trigger or pull the latest run from a shared
 * quality store the q2 lift introduces. Until then, this is fully
 * standalone.
 *
 * The component prints a single button until the user clicks "Run checks
 * + summarize" — at which point it streams check chunks and, once every
 * check completes, fires the AI summary. The summary itself is cached
 * (module-level Map inside `QualityAISummary`) keyed on the runHash so
 * re-opening the modal with the same run skips the LLM round-trip.
 */

interface Props {
  projectPath: string;
  projectName: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "running"; runId: string; doneByLabel: Record<string, QualityCheckDoneEvent> }
  | { kind: "complete"; runHash: string; checks: QualityCheckDoneEvent[] }
  | { kind: "error"; message: string };

export function QualityAIRunSummaryPanel({ projectPath, projectName }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const unlistenCheckDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  const runIdRef = useRef<string | null>(null);
  const collectedRef = useRef<Record<string, QualityCheckDoneEvent>>({});

  const tearDown = useCallback(() => {
    unlistenCheckDoneRef.current?.();
    unlistenDoneRef.current?.();
    unlistenErrorRef.current?.();
    unlistenCheckDoneRef.current = null;
    unlistenDoneRef.current = null;
    unlistenErrorRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      tearDown();
      // Best-effort cancel of any in-flight run when the modal closes.
      if (runIdRef.current) {
        void cancelQualityRun(runIdRef.current).catch(() => {});
      }
    };
  }, [tearDown]);

  const runChecksAndSummarize = useCallback(async () => {
    if (phase.kind === "running") return;
    tearDown();
    collectedRef.current = {};

    try {
      const runId = `quality-ai-run-${crypto.randomUUID()}`;
      runIdRef.current = runId;
      setPhase({ kind: "running", runId, doneByLabel: {} });

      // Subscribe BEFORE invoking — the first chunk can land before
      // `runQualityChecks` resolves.
      const unlistenCheckDone = await listen<QualityCheckDoneEvent>(
        qualityEvents.checkDone(runId),
        (event) => {
          if (!mountedRef.current) return;
          if (runIdRef.current !== runId) return;
          const ev = event.payload;
          collectedRef.current[ev.label] = ev;
          setPhase({
            kind: "running",
            runId,
            doneByLabel: { ...collectedRef.current },
          });
        },
      );
      unlistenCheckDoneRef.current = unlistenCheckDone;

      const unlistenDone = await listen(
        qualityEvents.done(runId),
        () => {
          if (!mountedRef.current) return;
          if (runIdRef.current !== runId) return;
          const checks = Object.values(collectedRef.current);
          const runHash = buildRunHash(runId, checks);
          tearDown();
          runIdRef.current = null;
          // Wipe any prior cached summary for the same hash — defensive,
          // a fresh run id should already mint a fresh hash. Per-key
          // delete (peer review fix): avoids wiping another modal
          // instance's cached summary running in parallel.
          clearQualityAISummaryCache(runHash);
          setPhase({ kind: "complete", runHash, checks });
        },
      );
      unlistenDoneRef.current = unlistenDone;

      const unlistenError = await listen<{ message: string }>(
        qualityEvents.error(runId),
        (event) => {
          if (!mountedRef.current) return;
          if (runIdRef.current !== runId) return;
          tearDown();
          runIdRef.current = null;
          setPhase({
            kind: "error",
            message: event.payload?.message || "Quality run failed",
          });
        },
      );
      unlistenErrorRef.current = unlistenError;

      await runQualityChecks(projectPath, runId, null);
    } catch (e) {
      tearDown();
      runIdRef.current = null;
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [phase.kind, projectPath, tearDown]);

  if (phase.kind === "idle") {
    return (
      <div className="flex flex-col gap-2 p-3 bg-bg-primary border border-bg-border rounded-lg">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-purple" />
          <span className="text-[11px] font-semibold text-text-primary">
            AI run summary
          </span>
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed">
          Run the project's lint / typecheck / test / build pipeline and get a
          structured AI summary of every failure — what's failing, root-cause
          hypotheses, and the order to fix them.
        </p>
        <button
          type="button"
          onClick={runChecksAndSummarize}
          className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent-purple/15 text-accent-purple border border-accent-purple/30 rounded font-medium hover:bg-accent-purple/25 transition-colors"
        >
          <Play size={11} />
          Run checks + summarize
        </button>
      </div>
    );
  }

  if (phase.kind === "running") {
    const progress = Object.values(phase.doneByLabel);
    return (
      <div className="flex flex-col gap-2 p-3 bg-bg-primary border border-bg-border rounded-lg">
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="animate-spin text-accent-purple" />
          <span className="text-[11px] font-semibold text-text-primary">
            Running quality checks…
          </span>
        </div>
        <div className="flex flex-col gap-0.5 text-[10px] text-text-muted">
          {progress.length === 0 && (
            <span className="italic">Spawning checks…</span>
          )}
          {progress.map((p) => (
            <span key={p.checkId} className="font-mono">
              {p.status === "passed" ? "[ok]  " : "[fail]"} {p.label}
              {p.exitCode !== null && p.exitCode !== 0 && (
                <span className="text-accent-red"> (exit {p.exitCode})</span>
              )}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="flex flex-col gap-2 p-3 bg-bg-primary border border-bg-border rounded-lg">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-red" />
          <span className="text-[11px] font-semibold text-accent-red">
            Quality run failed
          </span>
        </div>
        <div className="bg-accent-red/10 border border-accent-red/30 rounded px-3 py-2 text-[11px] text-accent-red">
          {phase.message}
        </div>
        <button
          type="button"
          onClick={runChecksAndSummarize}
          className="self-start inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-purple transition-colors"
        >
          <RefreshCw size={10} />
          Retry
        </button>
      </div>
    );
  }

  // phase.kind === "complete"
  const failingChecks = phase.checks.filter(
    (c) => c.status !== "passed" && c.status !== "skipped" && !c.optional,
  );

  if (failingChecks.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3 bg-accent-green/5 border border-accent-green/20 rounded-lg">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-accent-green" />
          <span className="text-[11px] font-semibold text-accent-green">
            All checks passed
          </span>
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed">
          Every required check returned successfully. Nothing to summarize.
        </p>
        <button
          type="button"
          onClick={runChecksAndSummarize}
          className="self-start inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-purple transition-colors"
        >
          <RefreshCw size={10} />
          Re-run
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <QualityAISummary
        runHash={phase.runHash}
        projectName={projectName}
        checks={failingChecks.map((c) => ({
          name: c.label,
          exitCode: c.exitCode ?? 1,
          output: c.output,
        }))}
      />
      <button
        type="button"
        onClick={runChecksAndSummarize}
        className="self-start inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-purple transition-colors px-3"
      >
        <RefreshCw size={10} />
        Re-run checks
      </button>
    </div>
  );
}

/**
 * Build a stable cache key from the run id + each check's name + exit
 * code + output byte length. Same run = same hash; a re-run mints a
 * fresh run id and therefore a fresh hash, invalidating the cache.
 */
function buildRunHash(runId: string, checks: QualityCheckDoneEvent[]): string {
  const parts = [runId];
  for (const c of checks.slice().sort((a, b) => a.label.localeCompare(b.label))) {
    parts.push(`${c.label}:${c.exitCode ?? "x"}:${c.output.length}`);
  }
  return parts.join("|");
}
