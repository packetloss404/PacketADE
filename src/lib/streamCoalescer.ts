/**
 * Frame-coalesced buffering for high-frequency streaming deltas.
 *
 * The `api-agent:chunk` / `api-agent:thinking` listeners used to write to the
 * store once per token, rebuilding the conversations array (and re-running
 * every subscribed selector) dozens of times a second. This helper buffers
 * deltas as plain string concatenation (cheap) and applies them at most once
 * per animation frame with a single `apply` call — i.e. a single store write.
 *
 * Ordering guarantees:
 * - Deltas are applied strictly in arrival order (append-only buffer).
 * - `flushNow()` applies synchronously. Callers invoke it before handling
 *   events that assume the buffered text has landed (done / error /
 *   thinking-stop), so a settling turn can never lose or reorder tail chunks.
 * - A frame callback that fires after `flushNow()` finds an empty buffer and
 *   is a no-op — a flush never applies the same delta twice.
 */

export interface StreamDeltas {
  /** Concatenated assistant-content deltas since the last flush. */
  content: string;
  /** Concatenated extended-thinking deltas since the last flush. */
  thinking: string;
}

/** Schedules `cb` for the next frame; returns a cancel function. */
export type ScheduleFrame = (cb: () => void) => () => void;

// rAF when available (always, in the WKWebView), timer fallback for tests.
const defaultScheduleFrame: ScheduleFrame = (cb) => {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(cb, 16);
  return () => clearTimeout(handle);
};

export interface StreamCoalescer {
  /** Buffer an assistant-content delta; schedules a flush if none pending. */
  pushContent: (delta: string) => void;
  /** Buffer an extended-thinking delta; schedules a flush if none pending. */
  pushThinking: (delta: string) => void;
  /** Synchronously apply everything buffered and cancel the pending frame. */
  flushNow: () => void;
  /** Cancel any pending flush and drop buffered deltas (listener teardown). */
  dispose: () => void;
}

export function createStreamCoalescer(
  apply: (deltas: StreamDeltas) => void,
  scheduleFrame: ScheduleFrame = defaultScheduleFrame,
): StreamCoalescer {
  let content = "";
  let thinking = "";
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;

  const flush = () => {
    cancelScheduled = null;
    if (content === "" && thinking === "") return;
    const deltas: StreamDeltas = { content, thinking };
    content = "";
    thinking = "";
    apply(deltas);
  };

  const schedule = () => {
    if (cancelScheduled) return;
    cancelScheduled = scheduleFrame(flush);
  };

  return {
    pushContent: (delta) => {
      if (disposed || delta === "") return;
      content += delta;
      schedule();
    },
    pushThinking: (delta) => {
      if (disposed || delta === "") return;
      thinking += delta;
      schedule();
    },
    flushNow: () => {
      if (disposed) return;
      cancelScheduled?.();
      flush();
    },
    dispose: () => {
      disposed = true;
      cancelScheduled?.();
      cancelScheduled = null;
      content = "";
      thinking = "";
    },
  };
}
