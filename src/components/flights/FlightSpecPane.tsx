import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Loader2, Rocket, Sparkles } from "lucide-react";
import {
  useFlightPlannerStore,
  type PlannerSessionRuntime,
  type PlannerTranscriptEntry,
} from "@/stores/flightPlannerStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

interface FlightSpecPaneProps {
  flightId: string;
}

const EMPTY_BLURB =
  "Describe what you want to build. The planner will help you scope it, " +
  "then break it into milestones and tasks. Hit Launch when you're ready.";

const POST_LAUNCH_BLURB =
  "Once you launch, the planner will decompose the spec into milestones + " +
  "tasks. You can keep chatting during the run.";

const TOOL_CHIP_FRESHNESS_MS = 5000;
const AUTOSCROLL_THRESHOLD_PX = 100;

// Starter-prompt suggestions surfaced in the empty-state. Clicking a pill
// populates the composer with the prompt so users can edit before sending.
// The pills only appear when the transcript is empty, so they vanish as
// soon as the user has typed anything (the pill content BECOMES the typed
// content, which then triggers `isEmpty === false`).
const STARTER_PROMPTS = [
  "Add a dark-mode toggle",
  "Refactor the workspace sidebar for readability",
  "Add e2e tests for the spec-mode flow",
];

/**
 * Full-pane spec-mode chat for a Flight. Renders when the parent
 * (FlightDetailPane) detects `flight.status === "spec"`. Binds to
 * `flightPlannerStore` runtime keyed by `flightId`; the planner session
 * itself is started by the mounting component (E3-MOUNT) before this pane
 * appears.
 */
export function FlightSpecPane({ flightId }: FlightSpecPaneProps) {
  const runtime = useFlightPlannerStore((s) => s.runtimes.get(flightId));
  const injectTurn = useFlightPlannerStore((s) => s.injectTurn);
  const launchFlight = useFlightPlannerStore((s) => s.launchFlight);

  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pause auto-scroll when the user scrolls up by > AUTOSCROLL_THRESHOLD_PX,
  // resume when they scroll back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      setAutoscroll(distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const transcript = useMemo(
    () => runtime?.transcript ?? [],
    [runtime?.transcript],
  );
  const lastEntry = transcript[transcript.length - 1];
  const transcriptSignature = useMemo(() => {
    // Cheap key that changes any time the visible content changes — so the
    // autoscroll effect fires on streaming chunks, not just on new entries.
    if (transcript.length === 0) return "";
    return `${transcript.length}:${lastEntry?.content.length ?? 0}`;
  }, [transcript, lastEntry?.content.length]);

  useLayoutEffect(() => {
    if (!autoscroll) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [transcriptSignature, autoscroll]);

  const userMessageCount = useMemo(
    () => transcript.filter((m) => m.role === "user").length,
    [transcript],
  );

  const canLaunch =
    !!runtime &&
    userMessageCount >= 1 &&
    !runtime.isStreaming &&
    lastEntry?.role === "assistant";

  const handleSend = useCallback(() => {
    if (!runtime) return;
    if (runtime.isStreaming) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    // injectTurn appends the user message to the transcript optimistically.
    void injectTurn(flightId, trimmed, "user");
    // Keep the textarea focused so users can keep typing.
    queueMicrotask(() => textareaRef.current?.focus());
  }, [input, injectTurn, flightId, runtime]);

  const handleLaunch = useCallback(async () => {
    if (!canLaunch || isLaunching) return;
    setIsLaunching(true);
    setLaunchError(null);
    try {
      // Parent (FlightDetailPane) unmounts this pane once the flight
      // status flips from `spec` → `planning`, so we don't need to clear
      // `isLaunching` on the happy path. Only reset on failure.
      await launchFlight(flightId);
    } catch (err) {
      setLaunchError(
        err instanceof Error ? err.message : "Failed to launch flight",
      );
      setIsLaunching(false);
    }
  }, [canLaunch, isLaunching, launchFlight, flightId]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Starting-planner placeholder. E3-MOUNT calls `startPlanner` before
  // mounting, but the runtime entry can take a tick to appear.
  if (!runtime) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-bg-primary text-text-muted gap-2">
        <Loader2 size={18} className="animate-spin text-accent-purple" />
        <span className="text-[11px]">Starting planner…</span>
      </div>
    );
  }

  const isEmpty = transcript.length === 0;
  const inputRows = focused || input.split("\n").length > 2 ? 6 : 3;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg-primary">
      {isEmpty ? (
        <EmptyState
          input={input}
          onChange={setInput}
          onKeyDown={onKeyDown}
          onSend={handleSend}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={inputRows}
          textareaRef={textareaRef}
          isStreaming={runtime.isStreaming}
        />
      ) : (
        <>
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto"
          >
            <div className="flex flex-col gap-3 px-4 py-3">
              <TranscriptList
                entries={transcript}
                lastToolCall={runtime.lastToolCall}
                isStreaming={runtime.isStreaming}
              />
              <div ref={bottomRef} />
            </div>
          </div>

          <ComposerBar
            input={input}
            onChange={setInput}
            onKeyDown={onKeyDown}
            onSend={handleSend}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            rows={inputRows}
            textareaRef={textareaRef}
            isStreaming={runtime.isStreaming}
          />

          <LaunchFooter
            visible={userMessageCount >= 1 && lastEntry?.role === "assistant"}
            canLaunch={canLaunch}
            isLaunching={isLaunching}
            onLaunch={() => void handleLaunch()}
            error={launchError}
          />
        </>
      )}
    </div>
  );
}

// ---------- Subcomponents ----------

interface TranscriptListProps {
  entries: PlannerTranscriptEntry[];
  lastToolCall: PlannerSessionRuntime["lastToolCall"];
  isStreaming: boolean;
}

function TranscriptList({
  entries,
  lastToolCall,
  isStreaming,
}: TranscriptListProps) {
  // Find the index of the last assistant message — that's where a fresh
  // tool-chip belongs, above the streaming response.
  const lastAssistantIdx = (() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "assistant") return i;
    }
    return -1;
  })();

  // The transcript also receives `system` "tool: <name>" entries from the
  // store — we DON'T want to render those as full lines next to a chip, so
  // we filter them out and let the chip be the canonical surface.
  const visibleIndices = entries
    .map((_, i) => i)
    .filter((i) => {
      const e = entries[i];
      if (e.role !== "system") return true;
      return !e.content.startsWith("tool: ");
    });

  const toolChipFresh =
    !!lastToolCall &&
    isStreaming &&
    Date.now() - lastToolCall.ts < TOOL_CHIP_FRESHNESS_MS;

  return (
    <>
      {visibleIndices.map((i) => {
        const entry = entries[i];
        const showChipBeforeThis =
          toolChipFresh && i === lastAssistantIdx && entry.role === "assistant";
        return (
          <div key={`${i}-${entry.ts}`} className="flex flex-col gap-1">
            {showChipBeforeThis && lastToolCall && (
              <ToolCallChip toolName={lastToolCall.tool} />
            )}
            <TranscriptEntry entry={entry} />
          </div>
        );
      })}
    </>
  );
}

function TranscriptEntry({ entry }: { entry: PlannerTranscriptEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] flex flex-col items-end gap-0.5">
          <div className="px-3 py-2 bg-bg-elevated text-text-primary text-xs rounded whitespace-pre-wrap break-words">
            {entry.content}
          </div>
          <span className="font-mono text-[10px] text-text-muted">
            {formatTs(entry.ts)}
          </span>
        </div>
      </div>
    );
  }

  if (entry.role === "assistant") {
    return (
      <div className="flex flex-col gap-1 max-w-full">
        <div className="text-xs text-text-primary">
          <MarkdownRenderer content={entry.content} />
        </div>
      </div>
    );
  }

  // system
  return (
    <div className="flex justify-center">
      <span className="italic text-[10px] text-text-muted">
        {entry.content}
      </span>
    </div>
  );
}

function ToolCallChip({ toolName }: { toolName: string }) {
  return (
    <div className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded bg-bg-secondary border border-bg-border">
      <Sparkles size={11} className="text-accent-purple" />
      <span className="text-[10px] text-accent-purple">
        Planner used {prettifyToolName(toolName)}
      </span>
    </div>
  );
}

function prettifyToolName(raw: string): string {
  // Strip MCP prefixes like `mcp__planner__create_milestone` → `create_milestone`.
  const tail = raw.split("__").pop() ?? raw;
  return tail;
}

interface ComposerProps {
  input: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onFocus: () => void;
  onBlur: () => void;
  rows: number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
}

function ComposerBar(props: ComposerProps) {
  return (
    <div className="shrink-0 border-t border-bg-border bg-bg-secondary px-4 py-3">
      <Composer {...props} />
    </div>
  );
}

function Composer({
  input,
  onChange,
  onKeyDown,
  onSend,
  onFocus,
  onBlur,
  rows,
  textareaRef,
  isStreaming,
}: ComposerProps) {
  const canSend = !isStreaming && input.trim().length > 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          rows={rows}
          disabled={isStreaming}
          placeholder="Describe what you want to build, or ask the planner to refine…"
          className="flex-1 resize-none bg-bg-primary border border-bg-border rounded px-2.5 py-2 text-xs text-text-primary placeholder:text-text-faint outline-none focus:border-accent-line disabled:opacity-50 disabled:cursor-not-allowed font-sans"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          title="Send (Cmd/Ctrl+Enter)"
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded border border-bg-border bg-bg-primary text-text-secondary hover:text-accent-green hover:border-accent-line transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ArrowUp size={12} />
          )}
        </button>
      </div>
      <span className="text-[10px] text-text-muted">
        Cmd/Ctrl+Enter to send
      </span>
    </div>
  );
}

interface LaunchFooterProps {
  visible: boolean;
  canLaunch: boolean;
  isLaunching: boolean;
  onLaunch: () => void;
  error: string | null;
}

function LaunchFooter({
  visible,
  canLaunch,
  isLaunching,
  onLaunch,
  error,
}: LaunchFooterProps) {
  if (!visible) return null;
  return (
    <div className="shrink-0 border-t border-bg-border bg-bg-secondary px-4 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onLaunch}
          disabled={!canLaunch || isLaunching}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-accent-green bg-accent-green/15 border border-accent-line rounded hover:bg-accent-green/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLaunching ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Rocket size={12} />
          )}
          {isLaunching ? "Launching…" : "Launch flight ↗"}
        </button>
        {error && (
          <span className="text-[10px] text-accent-red">{error}</span>
        )}
      </div>
      <span className="text-[10px] text-text-muted leading-relaxed">
        {POST_LAUNCH_BLURB}
      </span>
    </div>
  );
}

type EmptyStateProps = ComposerProps;

function EmptyState(props: EmptyStateProps) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-4">
      <div className="w-full max-w-[520px] flex flex-col items-center gap-3">
        <Sparkles size={24} className="text-accent-purple" />
        <h3 className="text-sm font-semibold text-text-primary">
          Welcome to spec mode
        </h3>
        <p className="text-[11px] text-text-secondary text-center leading-relaxed">
          {EMPTY_BLURB}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
          <span className="text-[10px] text-text-muted uppercase tracking-[0.08em]">
            Try
          </span>
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => props.onChange(p)}
              className="px-2.5 py-1 text-[11px] text-text-secondary border border-bg-border bg-bg-secondary rounded hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              {p}
            </button>
          ))}
        </div>
        <div className="w-full mt-2 bg-bg-secondary border border-bg-border rounded p-3">
          <Composer {...props} />
        </div>
      </div>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}
