import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { codeQualityAiExplain } from "@/lib/tauri";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

/**
 * v0.8.8 quality ai — streaming "Explain this error" popover.
 *
 * Mounts as an inline panel next to a single failed-check row (q2 owns
 * the surrounding parsed-output UI; this component is dropped in via
 * `QualityAIErrorActions`). Clicking the trigger button starts a one-shot
 * `claude-oauth` sidecar session and streams plain-language explanation
 * Markdown into the panel.
 *
 * Lifecycle mirrors `PRReviewPanel.tsx`:
 *   - pre-allocate session id, subscribe to api-agent:chunk|done|error:<sid>
 *     BEFORE invoking the backend so we can't drop the first chunk
 *   - tear listeners down on done/error/unmount
 *   - re-run is supported: tear down old listeners + start a fresh session
 *
 * The component is self-contained (no store dep) so q2 can render N of
 * these side-by-side in a list of failed checks without coordinating
 * cache keys.
 */

export interface QualityErrorRef {
  /** Stable id used for cache-busting + backend logging. */
  id: string;
  /** Full diagnostic line (`file:line:col message…`). */
  message: string;
  /** Absolute path on disk; the backend reads ±30 lines of context. */
  filePath: string;
  /** 1-indexed; pass 0 when the diagnostic didn't carry a value. */
  line: number;
  /** 1-indexed; pass 0 when the diagnostic didn't carry a value. */
  column: number;
}

interface Props {
  error: QualityErrorRef;
  /** Called when the user dismisses the panel. */
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming"; partial: string }
  | { kind: "done"; result: string }
  | { kind: "error"; message: string };

export function QualityAIExplanation({ error, onClose }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const unlistenChunkRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const accumulatedRef = useRef<string>("");
  const mountedRef = useRef(true);
  // Track the current session id so a stale "done" from a previous
  // re-run can't overwrite the current attempt's state.
  const sessionIdRef = useRef<string | null>(null);

  const tearDown = useCallback(() => {
    unlistenChunkRef.current?.();
    unlistenDoneRef.current?.();
    unlistenErrorRef.current?.();
    unlistenChunkRef.current = null;
    unlistenDoneRef.current = null;
    unlistenErrorRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      tearDown();
    };
  }, [tearDown]);

  const runExplain = useCallback(async () => {
    if (status.kind === "streaming") return;
    tearDown();
    accumulatedRef.current = "";
    setStatus({ kind: "streaming", partial: "" });

    try {
      // v0.8 race-fix: pre-allocate the session id and subscribe BEFORE
      // invoking the backend. Mirrors `PRReviewPanel`'s pattern.
      const sessionId = `quality-ai-explain-${crypto.randomUUID()}`;
      sessionIdRef.current = sessionId;

      const unlistenChunk = await listen<string>(
        `api-agent:chunk:${sessionId}`,
        (event) => {
          if (!mountedRef.current) return;
          if (sessionIdRef.current !== sessionId) return;
          accumulatedRef.current += event.payload;
          setStatus({ kind: "streaming", partial: accumulatedRef.current });
        },
      );
      unlistenChunkRef.current = unlistenChunk;

      const unlistenDone = await listen(
        `api-agent:done:${sessionId}`,
        () => {
          if (!mountedRef.current) return;
          if (sessionIdRef.current !== sessionId) return;
          const final = accumulatedRef.current.trim();
          tearDown();
          setStatus({ kind: "done", result: final });
        },
      );
      unlistenDoneRef.current = unlistenDone;

      const unlistenError = await listen<{ message: string }>(
        `api-agent:error:${sessionId}`,
        (event) => {
          if (!mountedRef.current) return;
          if (sessionIdRef.current !== sessionId) return;
          tearDown();
          setStatus({
            kind: "error",
            message: event.payload?.message || "Explanation failed",
          });
        },
      );
      unlistenErrorRef.current = unlistenError;

      // Listeners are wired — kick off the backend session.
      await codeQualityAiExplain(
        error.id,
        error.message,
        error.filePath,
        error.line,
        error.column,
        sessionId,
      );
    } catch (e) {
      tearDown();
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [status.kind, error, tearDown]);

  // Auto-run on mount. The trio of action buttons explicitly opens this
  // panel (the user has already clicked "Explain"); auto-running means
  // they don't have to click twice. Re-run is still available via the
  // RefreshCw button in the result state.
  useEffect(() => {
    if (status.kind === "idle") {
      void runExplain();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isStreaming = status.kind === "streaming";

  return (
    <div className="flex flex-col gap-2 p-3 bg-bg-primary border border-accent-purple/30 rounded-lg">
      <div className="flex items-center gap-2">
        <Sparkles size={12} className="text-accent-purple" />
        <span className="text-[11px] font-semibold text-text-primary">
          AI explanation
        </span>
        {isStreaming && (
          <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
            <Loader2 size={10} className="animate-spin" />
            Streaming…
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close explanation"
          className="ml-auto text-text-muted hover:text-text-primary"
        >
          <X size={12} />
        </button>
      </div>

      {isStreaming && (
        <div className="max-h-64 overflow-y-auto bg-bg-secondary border border-bg-border rounded px-2 py-1.5 text-[10px] text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">
          {status.partial || (
            <span className="text-text-muted italic">Waiting for first chunk…</span>
          )}
        </div>
      )}

      {status.kind === "done" && (
        <div className="bg-bg-secondary border border-bg-border rounded p-3 text-xs text-text-primary">
          <MarkdownRenderer content={status.result} />
        </div>
      )}

      {status.kind === "error" && (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded px-3 py-2 text-[11px] text-accent-red">
          {status.message}
        </div>
      )}

      {(status.kind === "done" || status.kind === "error") && (
        <button
          type="button"
          onClick={runExplain}
          className="self-start inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-purple transition-colors"
        >
          <RefreshCw size={10} />
          Re-run
        </button>
      )}
    </div>
  );
}
