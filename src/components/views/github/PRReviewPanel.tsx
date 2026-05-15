import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { githubAiPrReview } from "@/lib/tauri";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { prCacheKey, useGitHubStore } from "@/stores/githubStore";
import type { GitHubPr } from "@/types/github";

/**
 * v0.8-E: AI pre-flight code review panel for an existing PR.
 *
 * Mounts under the PR diff in `GitHubView.tsx::PRDetail`. Clicking "Run AI
 * pre-flight review" starts a one-shot `claude-oauth` sidecar session and
 * streams structured markdown (Blocking / Asks / Nits) into the panel.
 *
 * Caching:
 *   - The final markdown is cached in `githubStore.prAiReviews` keyed by
 *     `"{owner}/{repo}#{number}"` (see `prCacheKey`).
 *   - Re-opening the PR shows the cached result immediately; no auto-rerun.
 *   - A "Re-run" link is rendered below the result so the user can refresh
 *     after pushing new commits to the PR.
 *
 * Stream UX mirrors `PRDescriptionButton`: idle → streaming with partial
 * preview → idle with the full markdown in the body, or error inline.
 */

interface Props {
  pr: GitHubPr;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming"; partial: string }
  | { kind: "error"; message: string };

export function PRReviewPanel({ pr }: Props) {
  const { config, prAiReviews, setPrAiReview, clearPrAiReview } = useGitHubStore();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Listener handles + accumulator. Same lifecycle pattern as
  // `PRDescriptionButton`. We don't recycle the helper because the two
  // components have different post-stream behavior (one notifies parent;
  // this one persists into the store).
  const unlistenChunkRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const accumulatedRef = useRef<string>("");
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

  const cacheKey = config.selectedRepo
    ? prCacheKey(config.selectedRepo.owner, config.selectedRepo.repo, pr.number)
    : null;
  const cached = cacheKey ? prAiReviews[cacheKey] : undefined;

  const runReview = useCallback(async () => {
    if (status.kind === "streaming") return;
    if (!config.selectedRepo) return;
    tearDown();
    accumulatedRef.current = "";
    // Clear any prior cached review so the UI doesn't flash the old result
    // alongside the new partial stream. We re-populate the cache on `done`.
    clearPrAiReview(pr);
    setStatus({ kind: "streaming", partial: "" });

    try {
      const { owner, repo } = config.selectedRepo;
      // v0.8 race-fix: pre-allocate the session id and subscribe BEFORE
      // invoking the backend. Mirrors `PRDescriptionButton`'s pattern —
      // see comment there for the dropped-first-chunk rationale.
      const sessionId = `gh-pr-review-${crypto.randomUUID()}`;

      const unlistenChunk = await listen<string>(
        `api-agent:chunk:${sessionId}`,
        (event) => {
          if (!mountedRef.current) return;
          accumulatedRef.current += event.payload;
          setStatus({ kind: "streaming", partial: accumulatedRef.current });
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
          // Persist into the store so re-opening the PR detail shows the
          // result without a re-run.
          setPrAiReview(pr, final);
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
            message: event.payload?.message || "Review failed",
          });
        },
      );
      unlistenErrorRef.current = unlistenError;

      // Listeners are wired — now kick off the backend session.
      await githubAiPrReview(owner, repo, pr.number, sessionId);
    } catch (e) {
      tearDown();
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [
    status.kind,
    config.selectedRepo,
    pr,
    tearDown,
    clearPrAiReview,
    setPrAiReview,
  ]);

  const isStreaming = status.kind === "streaming";
  const hasResult = !isStreaming && !!cached;

  // Empty state — render the kickoff button only.
  if (!isStreaming && !cached && status.kind !== "error") {
    return (
      <div className="flex flex-col gap-2 p-3 border-t border-bg-border">
        <div className="flex items-center gap-2">
          <ShieldCheck size={12} className="text-accent-purple" />
          <span className="text-[11px] font-semibold text-text-primary">
            AI pre-flight review
          </span>
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed">
          Get a structured Blocking / Asks / Nits review of this PR's diff
          before you ask a human reviewer.
        </p>
        <button
          type="button"
          onClick={runReview}
          disabled={!config.selectedRepo}
          className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent-purple/15 text-accent-purple border border-accent-purple/30 rounded font-medium hover:bg-accent-purple/25 transition-colors disabled:opacity-50"
        >
          <ShieldCheck size={11} />
          Run AI pre-flight review
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 border-t border-bg-border">
      <div className="flex items-center gap-2">
        <ShieldCheck size={12} className="text-accent-purple" />
        <span className="text-[11px] font-semibold text-text-primary">
          AI pre-flight review
        </span>
        {isStreaming && (
          <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
            <Loader2 size={10} className="animate-spin" />
            Streaming…
          </span>
        )}
      </div>

      {isStreaming && (
        <div className="max-h-64 overflow-y-auto bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-[10px] text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">
          {status.partial || (
            <span className="text-text-muted italic">Waiting for first chunk…</span>
          )}
        </div>
      )}

      {hasResult && (
        <div className="bg-bg-primary border border-bg-border rounded p-3 text-xs text-text-primary">
          <MarkdownRenderer content={cached} />
        </div>
      )}

      {status.kind === "error" && (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded px-3 py-2 text-[11px] text-accent-red">
          {status.message}
        </div>
      )}

      {(hasResult || status.kind === "error") && (
        <button
          type="button"
          onClick={runReview}
          disabled={!config.selectedRepo}
          className="self-start inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-purple transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} />
          Re-run
        </button>
      )}
    </div>
  );
}
