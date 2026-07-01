import { useMemo, useState, useRef, useEffect } from "react";
import { computeContextOccupancy } from "@/lib/modelContext";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

interface ContextUsageRingProps {
  conversation: AgentConversation;
}

/**
 * Cursor-style context-usage indicator. Reads the LATEST completed
 * assistant turn's token usage and renders a 14px SVG ring next to the
 * model picker. Hover/focus surfaces a breakdown by token kind (input /
 * output / cache read / cache write / reasoning) for that turn.
 *
 * Occupancy is the resident window of the latest turn (input + cache),
 * NOT a cross-turn sum — each turn re-sends the whole window, so summing
 * would multi-count the same context and pin the ring to 100%.
 *
 * Suppressed until at least one assistant turn has completed so we don't
 * paint an empty ring on fresh conversations.
 */
export function ContextUsageRing({ conversation }: ContextUsageRingProps) {
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Hover-out timer that closes the popover after a tiny delay so users
  // can shuttle their cursor from the ring into the popover without it
  // collapsing first.
  const hoverTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
  }, []);

  const { breakdown, inContext, limit, ratio } = useMemo(() => {
    // Find the most recent assistant turn that reported usage. Its token
    // counts ARE the current context occupancy.
    let latest: AgentMessage | undefined;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const m = conversation.messages[i];
      if (m.role !== "assistant") continue;
      if (
        (m.inputTokens ?? 0) > 0 ||
        (m.outputTokens ?? 0) > 0 ||
        (m.cacheReadTokens ?? 0) > 0 ||
        (m.cacheWriteTokens ?? 0) > 0
      ) {
        latest = m;
        break;
      }
    }
    const breakdown = {
      input: latest?.inputTokens ?? 0,
      output: latest?.outputTokens ?? 0,
      cacheRead: latest?.cacheReadTokens ?? 0,
      cacheWrite: latest?.cacheWriteTokens ?? 0,
      reasoning: latest?.reasoningTokens ?? 0,
    };
    // inContext = input + cache (cache read/write sit in the resident
    // window; Anthropic reports them separately from input_tokens). Output
    // and reasoning are billed separately and don't occupy the window.
    const occ = computeContextOccupancy({
      inputTokens: breakdown.input,
      cacheReadTokens: breakdown.cacheRead,
      cacheWriteTokens: breakdown.cacheWrite,
      model: conversation.model,
    });
    return {
      breakdown,
      inContext: occ.usedTokens,
      limit: occ.totalTokens,
      ratio: occ.fraction,
    };
  }, [conversation.messages, conversation.model]);

  // No completed turns yet → nothing useful to display.
  if (inContext === 0 && breakdown.output === 0) return null;

  const pct = Math.round(ratio * 100);
  // Stroke color follows budget pressure — green safe, amber warning,
  // red eviction zone. The thresholds match what Cursor surfaces in
  // their compose ring. Driven by Tailwind stroke-* token utilities so it
  // tracks the theme instead of hardcoded hex fallbacks.
  const strokeClass =
    ratio >= 0.9
      ? "stroke-accent-red"
      : ratio >= 0.7
        ? "stroke-accent-amber"
        : "stroke-accent-green";

  const size = 14;
  const r = 5;
  const c = 2 * Math.PI * r;
  const dash = c * ratio;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      role="img"
      aria-label={`Context usage ${pct} percent, ${formatTokens(inContext)} of ${formatTokens(limit)}`}
      className="relative inline-flex items-center gap-1 text-[10px] text-text-muted font-mono cursor-default rounded outline-none focus-visible:ring-1 focus-visible:ring-accent-line"
      onMouseEnter={() => {
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        setHover(true);
      }}
      onMouseLeave={() => {
        hoverTimerRef.current = window.setTimeout(() => setHover(false), 120);
      }}
      onFocus={() => {
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        setHover(true);
      }}
      onBlur={() => setHover(false)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="stroke-bg-border"
          strokeWidth={2}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className={`${strokeClass} transition-[stroke-dasharray] motion-reduce:transition-none`}
          strokeWidth={2}
          fill="none"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={0}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span>{pct}%</span>

      {hover && (
        <div
          className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded border border-bg-border bg-bg-secondary px-2 py-1.5 shadow-md text-[10px] text-text-secondary"
          role="tooltip"
        >
          <div className="text-text-primary font-medium mb-1">
            {formatTokens(inContext)} / {formatTokens(limit)}
            <span className="ml-1 text-text-muted">({pct}%)</span>
          </div>
          <div className="flex justify-between">
            <span>Input</span>
            <span className="font-mono">{formatTokens(breakdown.input)}</span>
          </div>
          <div className="flex justify-between">
            <span>Output</span>
            <span className="font-mono">{formatTokens(breakdown.output)}</span>
          </div>
          {breakdown.cacheRead > 0 && (
            <div className="flex justify-between text-accent-green">
              <span>Cache read</span>
              <span className="font-mono">
                {formatTokens(breakdown.cacheRead)}
              </span>
            </div>
          )}
          {breakdown.cacheWrite > 0 && (
            <div className="flex justify-between text-text-muted">
              <span>Cache write</span>
              <span className="font-mono">
                {formatTokens(breakdown.cacheWrite)}
              </span>
            </div>
          )}
          {breakdown.reasoning > 0 && (
            <div className="flex justify-between text-text-muted">
              <span>Reasoning</span>
              <span className="font-mono">
                {formatTokens(breakdown.reasoning)}
              </span>
            </div>
          )}
          <div className="border-t border-bg-border mt-1 pt-1 text-[9px] text-text-muted leading-snug">
            Context = input + cache resent on the latest turn. Output and
            reasoning are billed separately and don't sit in the window.
          </div>
        </div>
      )}
    </div>
  );
}
