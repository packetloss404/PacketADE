import { useMemo, useState, useRef, useEffect } from "react";
import type { AgentConversation } from "@/types/agent-conversation";

/**
 * Best-effort context-window size in tokens, keyed on model id. Numbers
 * mirror the public 2026 spec sheets. When we can't recognize a model id
 * we fall back to 200_000 — the median of the field — so the ring still
 * means something visually rather than collapsing to "N tokens" only.
 */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  // Anthropic (Claude 4.x)
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-8-1m": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-7-1m": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // MiniMax (M2 family — 200k context per MiniMax docs)
  "MiniMax-M2.5": 200_000,
  "MiniMax-M2.1": 200_000,
  "MiniMax-M2": 200_000,
  // OpenAI (GPT-5.x)
  "gpt-5.5": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.3-codex": 400_000,
  // Google
  "gemini-3.1-pro": 2_000_000,
  "gemini-3-flash": 1_000_000,
};

const DEFAULT_CONTEXT_TOKENS = 200_000;

function resolveContextLimit(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_TOKENS;
  // Exact match first; otherwise startsWith for dated variants like
  // "claude-sonnet-4-6-20250414".
  if (MODEL_CONTEXT_TOKENS[modelId]) return MODEL_CONTEXT_TOKENS[modelId];
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_TOKENS)) {
    if (modelId.startsWith(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_TOKENS;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

interface ContextUsageRingProps {
  conversation: AgentConversation;
}

/**
 * Cursor-style context-usage indicator. Sums tokens across all completed
 * assistant turns in the conversation and renders a 14px SVG ring next to
 * the model picker. Hover surfaces a breakdown by token kind (input /
 * output / cache read / cache write / reasoning) — we don't have
 * per-source attribution from providers yet so this is the best we can
 * do without lying.
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

  const breakdown = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    for (const m of conversation.messages) {
      if (m.role !== "assistant") continue;
      input += m.inputTokens ?? 0;
      output += m.outputTokens ?? 0;
      cacheRead += m.cacheReadTokens ?? 0;
      cacheWrite += m.cacheWriteTokens ?? 0;
      reasoning += m.reasoningTokens ?? 0;
    }
    // Context-window utilization is dominated by INPUT tokens — output
    // doesn't sit in context for the next turn, and the API charges them
    // separately. Cache reads ARE input that survived into the window,
    // already counted on the input side by every provider we care about,
    // so don't double-count.
    const inContext = input;
    return { input, output, cacheRead, cacheWrite, reasoning, inContext };
  }, [conversation.messages]);

  const limit = resolveContextLimit(conversation.model);
  const ratio = Math.min(1, breakdown.inContext / limit);

  // No completed turns yet → nothing useful to display.
  if (breakdown.input === 0 && breakdown.output === 0) return null;

  const pct = Math.round(ratio * 100);
  // Stroke color follows budget pressure — green safe, amber warning,
  // red eviction zone. The thresholds match what Cursor surfaces in
  // their compose ring.
  const stroke =
    ratio >= 0.9
      ? "var(--color-accent-red, #c97070)"
      : ratio >= 0.7
        ? "var(--color-accent-amber, #d4b25c)"
        : "var(--color-accent-green, #6fb89a)";

  const size = 14;
  const r = 5;
  const c = 2 * Math.PI * r;
  const dash = c * ratio;

  return (
    <div
      ref={wrapRef}
      className="relative inline-flex items-center gap-1 text-[10px] text-text-muted font-mono cursor-default"
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
      title={`Context: ${formatTokens(breakdown.inContext)} / ${formatTokens(limit)} (${pct}%)`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--color-bg-border, #2a2a2a)"
          strokeWidth={2}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={stroke}
          strokeWidth={2}
          fill="none"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
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
            {formatTokens(breakdown.inContext)} / {formatTokens(limit)}
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
            <div className="flex justify-between text-accent-green/80">
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
            Context = input that survives into the next turn. Output, cache,
            and reasoning are billed separately and don't sit in the window.
          </div>
        </div>
      )}
    </div>
  );
}
