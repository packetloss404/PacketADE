import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { githubAiPrDescription } from "@/lib/tauri";

/**
 * v0.8-E: "Generate description" button for the PR creation modal.
 *
 * Kicks off a one-shot `claude-oauth` sidecar session that drafts a
 * structured PR description from the `base..head` diff (+ commit list,
 * + optional linked-issue bodies) and streams chunks back to the user
 * in real time. When the assistant emits `done`, the final markdown
 * (the concatenation of every chunk) is handed back to the parent via
 * `onGenerated` so the PR-modal can populate its description field.
 *
 * Streaming UX:
 *   - Idle:     just the Sparkles button.
 *   - Running:  "Streaming…" pill + the partial markdown in a small
 *               preview pane below the button.
 *   - Error:    inline red message.
 *
 * The user can re-run by clicking the button again; we tear down the
 * previous listeners and start a fresh session id.
 */

interface Props {
  owner: string;
  repo: string;
  base: string;
  head: string;
  linkedIssues?: number[];
  draftTitle?: string;
  onGenerated: (markdown: string) => void;
  /** Optional: parent override (e.g. PRModal sets `Create PR` disabled). */
  disabled?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming"; sessionId: string; partial: string }
  | { kind: "error"; message: string };

export function PRDescriptionButton({
  owner,
  repo,
  base,
  head,
  linkedIssues,
  draftTitle,
  onGenerated,
  disabled,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Listener handles. Kept in refs so the cleanup effect (and the explicit
  // tearDown helper) can detach without re-running the listen-effect.
  const unlistenChunkRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  // Accumulator for the streamed text — using a ref (not state) means each
  // incoming chunk is O(1) instead of triggering a full re-render-with-old-state
  // race window.
  const accumulatedRef = useRef<string>("");
  // Track whether the component is still mounted so async event callbacks
  // don't poke a torn-down state.
  const mountedRef = useRef(true);

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

  const handleClick = useCallback(async () => {
    if (status.kind === "streaming") return;
    // Reset any previous run.
    tearDown();
    accumulatedRef.current = "";

    // v0.8 race-fix: pre-allocate the session id on the frontend and attach
    // listeners BEFORE invoking the backend. The old order (invoke → await
    // → listen) had a window where the sidecar could emit the first chunks
    // before our subscription resolved, silently dropping them.
    const sessionId = `gh-pr-desc-${crypto.randomUUID()}`;
    setStatus({ kind: "streaming", sessionId, partial: "" });

    try {
      // Chunks arrive as raw text payloads on `api-agent:chunk:<sessionId>`.
      // Matches the shape the in-process LlmProvider and the sidecar both
      // emit (see `core::github_ai_prompts` docstring).
      const unlistenChunk = await listen<string>(
        `api-agent:chunk:${sessionId}`,
        (event) => {
          if (!mountedRef.current) return;
          accumulatedRef.current += event.payload;
          setStatus({
            kind: "streaming",
            sessionId,
            partial: accumulatedRef.current,
          });
        },
      );
      unlistenChunkRef.current = unlistenChunk;

      const unlistenDone = await listen(
        `api-agent:done:${sessionId}`,
        () => {
          if (!mountedRef.current) return;
          const final = accumulatedRef.current.trim();
          tearDown();
          setStatus({ kind: "idle" });
          // Hand the full markdown to the parent. They decide whether to
          // replace the description field outright or merge / append.
          onGenerated(final);
        },
      );
      unlistenDoneRef.current = unlistenDone;

      const unlistenError = await listen<{ message: string }>(
        `api-agent:error:${sessionId}`,
        (event) => {
          if (!mountedRef.current) return;
          tearDown();
          setStatus({
            kind: "error",
            message: event.payload?.message || "Generation failed",
          });
        },
      );
      unlistenErrorRef.current = unlistenError;

      // Listeners are now wired — safe to kick off the backend session.
      await githubAiPrDescription(
        owner,
        repo,
        base,
        head,
        draftTitle,
        linkedIssues,
        sessionId,
      );
    } catch (e) {
      tearDown();
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [
    status.kind,
    tearDown,
    owner,
    repo,
    base,
    head,
    draftTitle,
    linkedIssues,
    onGenerated,
  ]);

  const isStreaming = status.kind === "streaming";
  const canRun =
    !disabled &&
    !isStreaming &&
    owner.trim() !== "" &&
    repo.trim() !== "" &&
    base.trim() !== "" &&
    head.trim() !== "";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleClick}
          disabled={!canRun}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent-purple/15 text-accent-purple border border-accent-purple/30 rounded font-medium hover:bg-accent-purple/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Sparkles size={11} />
          )}
          {isStreaming ? "Streaming…" : "Generate description"}
        </button>
        {status.kind === "error" && (
          <span className="text-[10px] text-accent-red">{status.message}</span>
        )}
      </div>
      {isStreaming && status.partial && (
        <div className="max-h-32 overflow-y-auto bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[10px] text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">
          {status.partial}
        </div>
      )}
    </div>
  );
}
