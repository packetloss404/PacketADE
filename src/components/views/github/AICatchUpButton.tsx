// v0.8-F: AI catch-me-up digest, mounted in the Activity tab toolbar.
//
// Click → opens an expandable section above the activity feed that streams
// a four-section markdown digest of recent repo activity. The user can
// flip between Last 24h / 7d / 30d windows.
//
// Wire protocol: the Tauri command emits on the standard
// `api-agent:chunk:<sessionId>` / `api-agent:done:<sessionId>` /
// `api-agent:error:<sessionId>` channel, so we subscribe with the same
// helpers the Agents pane uses.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Newspaper, RefreshCw, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  apiAgentChunkEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
} from "@/lib/events";
import { githubAiCatchUp } from "@/lib/tauri";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

type Window = "24h" | "7d" | "30d";

interface AICatchUpButtonProps {
  owner: string;
  repo: string;
}

function windowToSinceIso(win: Window): string {
  const now = Date.now();
  const hours = win === "24h" ? 24 : win === "7d" ? 24 * 7 : 24 * 30;
  const since = new Date(now - hours * 60 * 60 * 1000);
  // Trim millis so the string is the simple `YYYY-MM-DDTHH:MM:SSZ` shape
  // the Rust side knows how to parse.
  return since.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newSessionId(): string {
  // Plain enough — no collisions in practice given the per-render lifecycle.
  return `gh-catchup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AICatchUpButton({ owner, repo }: AICatchUpButtonProps) {
  const [open, setOpen] = useState(false);
  const [win, setWin] = useState<Window>("7d");
  const [streaming, setStreaming] = useState(false);
  const [digest, setDigest] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Track the active sessionId so a re-run cancels the prior listener wiring.
  const activeSessionRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  const cleanupListeners = useCallback(() => {
    for (const u of unlistenersRef.current) {
      try {
        u();
      } catch {
        // best-effort
      }
    }
    unlistenersRef.current = [];
  }, []);

  useEffect(() => cleanupListeners, [cleanupListeners]);

  const runDigest = useCallback(
    async (which: Window) => {
      if (!owner || !repo) return;
      cleanupListeners();
      const sessionId = newSessionId();
      activeSessionRef.current = sessionId;
      setStreaming(true);
      setDigest("");
      setError(null);

      // Attach listeners BEFORE invoking so we don't miss the first chunk.
      // `api-agent:chunk:<sid>` payload is a raw string per the canonical
      // contract (sidecar / api_agent / github_ai_catch_up all emit `&str`).
      const offChunk = await listen<string>(
        apiAgentChunkEvent(sessionId),
        (event) => {
          if (activeSessionRef.current !== sessionId) return;
          setDigest((prev) => prev + (event.payload ?? ""));
        },
      );
      const offDone = await listen(apiAgentDoneEvent(sessionId), () => {
        if (activeSessionRef.current !== sessionId) return;
        setStreaming(false);
      });
      const offError = await listen<{ message: string } | string>(
        apiAgentErrorEvent(sessionId),
        (event) => {
          if (activeSessionRef.current !== sessionId) return;
          const message =
            typeof event.payload === "string"
              ? event.payload
              : event.payload?.message ?? "Digest failed";
          setError(message);
          setStreaming(false);
        },
      );
      unlistenersRef.current = [offChunk, offDone, offError];

      try {
        await githubAiCatchUp(sessionId, owner, repo, windowToSinceIso(which));
      } catch (e) {
        setError(String(e));
        setStreaming(false);
      }
    },
    [owner, repo, cleanupListeners],
  );

  function handleToggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void runDigest(win);
  }

  function handleWindowChange(next: Window) {
    setWin(next);
    void runDigest(next);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleToggle}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium rounded transition-colors border ${
          open
            ? "bg-accent-blue/25 text-accent-blue border-accent-blue/40"
            : "bg-accent-blue/15 text-accent-blue border-accent-blue/30 hover:bg-accent-blue/25"
        }`}
        title="Stream an AI digest of recent repo activity"
      >
        <Newspaper size={11} />
        Catch me up
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 mx-3 z-20 bg-bg-secondary border border-accent-blue/30 rounded-lg shadow-lg flex flex-col max-h-[60vh] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-accent-blue/10 border-b border-accent-blue/20 flex-shrink-0">
            <Newspaper size={12} className="text-accent-blue" />
            <span className="text-[11px] font-semibold text-accent-blue">
              AI digest
            </span>
            <span className="text-[9.5px] text-text-muted">
              {owner}/{repo}
            </span>
            <div className="flex-1" />
            <div className="inline-flex items-center gap-0.5 bg-bg-primary border border-bg-border rounded p-0.5">
              {(["24h", "7d", "30d"] as Window[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => handleWindowChange(w)}
                  disabled={streaming}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                    win === w
                      ? "bg-accent-blue/25 text-accent-blue"
                      : "text-text-muted hover:text-text-primary"
                  } disabled:opacity-50`}
                >
                  {w === "24h" ? "Last 24h" : w === "7d" ? "Last 7d" : "Last 30d"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => runDigest(win)}
              disabled={streaming}
              className="p-1 text-text-muted hover:text-text-primary disabled:opacity-50"
              title="Re-run digest"
            >
              <RefreshCw
                size={11}
                className={streaming ? "animate-spin" : ""}
              />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 text-text-muted hover:text-text-primary"
              title="Close"
            >
              <X size={11} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3.5 py-3 text-[11px] text-text-secondary leading-relaxed">
            {error ? (
              <p className="text-accent-red text-[10.5px]">{error}</p>
            ) : streaming && !digest ? (
              <div className="flex items-center gap-2 text-text-muted py-2">
                <Loader2 size={12} className="animate-spin" />
                Fetching activity and asking the model…
              </div>
            ) : digest ? (
              <MarkdownRenderer
                content={digest}
                className="text-[11px] text-text-secondary leading-relaxed"
              />
            ) : (
              <p className="text-text-muted">No digest yet.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
