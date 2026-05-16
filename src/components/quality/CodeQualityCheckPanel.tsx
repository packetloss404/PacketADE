import { useCallback, useEffect, useRef } from "react";
import { Loader2, PlayCircle, RefreshCw, Square } from "lucide-react";
import { AnsiText } from "./AnsiText";
import { CheckStatusBadge, type CheckStatus } from "./CheckStatusBadge";

// Re-export the badge component for callers that just want the inline
// status pill. `subscribeQualityStream` and `QualityStreamHandlers` live in
// `./qualityStream` — import them from there directly.
export type { CheckStatus } from "./CheckStatusBadge";
export { CheckStatusBadge } from "./CheckStatusBadge";

/**
 * Per-check diagnostics panel — one tab per registered check (Lint /
 * Typecheck / Test / Cargo Check, etc.). The panel is **transport-agnostic**:
 *
 *   - If the backend supports `quality:chunk:<runId>` and `quality:done:<runId>`
 *     Tauri events (agent q1 is shipping these), we subscribe before invoking
 *     and stream output line-by-line.
 *   - Otherwise the caller passes a `runOnce` promise that resolves with the
 *     final stdout buffer; we render that as a single block.
 *
 * Status badges: idle → queued → running → passed/failed/cancelled/errored.
 * The panel exposes Cancel + Re-run buttons that delegate to the supplied
 * callbacks (the runner backend ultimately owns process lifecycle).
 *
 * Output rendering uses `AnsiText` so SGR escapes from eslint/tsc/cargo are
 * preserved with proper foreground colors. Long lines wrap. The viewer
 * auto-scrolls to the bottom while streaming unless the user has scrolled
 * up (sticky-scroll heuristic).
 */

export interface CheckDescriptor {
  /** Stable id, e.g. "lint". */
  id: string;
  /** Human label for tabs and headers. */
  label: string;
  /** Short description shown above the output. */
  description?: string;
  /** Command preview, e.g. "pnpm lint". Purely informational. */
  commandPreview?: string;
}

interface CheckPanelProps {
  check: CheckDescriptor;
  status: CheckStatus;
  /** Concatenated output buffer (incl. ANSI escapes). May be empty. */
  output: string;
  /** Wallclock duration in ms, or null if unknown. */
  durationMs: number | null;
  /** Optional error message shown above the output (e.g. spawn failure). */
  errorMessage?: string | null;
  /** Filter text shared with the parent. */
  filter: string;
  onFilterChange: (next: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onPathClick?: (path: string, line: number, col: number | null) => void;
}

export function CodeQualityCheckPanel({
  check,
  status,
  output,
  durationMs,
  errorMessage,
  filter,
  onFilterChange,
  onRun,
  onCancel,
  onPathClick,
}: CheckPanelProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  // Sticky auto-scroll: if user is near the bottom, follow new output. If
  // they've scrolled up, leave them alone.
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickyRef.current = distance < 40;
  }, []);

  useEffect(() => {
    if (!stickyRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  const isRunning = status === "running" || status === "queued";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CheckStatusBadge status={status} />
            <h3 className="text-xs font-semibold text-text-primary truncate">{check.label}</h3>
            {durationMs !== null && (
              <span className="text-[10px] text-text-muted flex-shrink-0">
                {(durationMs / 1000).toFixed(2)}s
              </span>
            )}
          </div>
          {check.description && (
            <p className="text-[10px] text-text-muted mt-0.5 leading-snug">{check.description}</p>
          )}
          {check.commandPreview && (
            <code className="text-[10px] text-text-secondary font-mono">$ {check.commandPreview}</code>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isRunning ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-accent-red/30 text-accent-red hover:bg-accent-red/10 transition-colors"
              title="Cancel this check (Esc while running)"
            >
              <Square size={10} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-accent-green/30 text-accent-green hover:bg-accent-green/10 transition-colors"
              title={status === "idle" ? "Run this check" : "Re-run this check (Ctrl/Cmd+R)"}
            >
              {status === "idle" ? <PlayCircle size={10} /> : <RefreshCw size={10} />}
              {status === "idle" ? "Run" : "Re-run"}
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div className="rounded border border-accent-red/30 bg-accent-red/10 px-2 py-1.5 text-[10px] text-accent-red">
          {errorMessage}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter output…"
          className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[10px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
          data-quality-filter
        />
        {filter && (
          <button
            type="button"
            onClick={() => onFilterChange("")}
            className="text-[10px] text-text-muted hover:text-text-primary"
          >
            Clear
          </button>
        )}
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="bg-bg-primary border border-bg-border rounded max-h-[55vh] min-h-[160px] overflow-auto px-2 py-1.5"
      >
        {output.length === 0 ? (
          <div className="text-[11px] text-text-muted italic flex items-center gap-1.5 py-2">
            {isRunning ? (
              <>
                <Loader2 size={11} className="animate-spin" />
                Waiting for output…
              </>
            ) : status === "idle" ? (
              <>No output yet. Click Run to start.</>
            ) : status === "skipped" ? (
              <>This check was skipped.</>
            ) : (
              <>No output captured.</>
            )}
          </div>
        ) : (
          <AnsiText text={output} filter={filter} highlightFilter onPathClick={onPathClick} />
        )}
      </div>
    </div>
  );
}

