import type { AgentConversation } from "@/types/agent-conversation";

/**
 * USD cost per million tokens, by model identifier.
 * Used for a cheap inline estimate in the sidebar pill.
 * For accurate per-turn costs use the `calculateTurnCost` Tauri command.
 */
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-5.5": { input: 5, output: 15 },
  "chatgpt-5.5": { input: 5, output: 15 },
  "openai/gpt-5.5": { input: 5, output: 15 },
  "openai/chatgpt-5.5": { input: 5, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
  o3: { input: 15, output: 60 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "MiniMax-M2.7": { input: 0.3, output: 1.2 },
  "MiniMax-M2.7-highspeed": { input: 0.3, output: 1.2 },
};

/**
 * Look up rates for a model id. Tries exact match first, then strips a
 * trailing date suffix (e.g. "claude-sonnet-4-6-20250414" -> "claude-sonnet-4-6").
 */
function lookupRates(model: string | undefined): { input: number; output: number } | null {
  if (!model) return null;
  const exact = COST_PER_MTOK[model];
  if (exact) return exact;
  // Strip trailing -YYYYMMDD if present
  const stripped = model.replace(/-\d{8}$/, "");
  if (stripped !== model && COST_PER_MTOK[stripped]) return COST_PER_MTOK[stripped];
  return null;
}

/**
 * Cached input is billed at a discount on every provider that surfaces it —
 * Anthropic ~10% of input, OpenAI ~50%. 0.25 is the conservative midpoint
 * that keeps PacketADE's inline pill from over-stating cost on cache-heavy
 * Codex turns. The Tauri-side `calculate_turn_cost` command does the
 * provider-specific math when accuracy matters.
 */
const CACHED_INPUT_RATE_RATIO = 0.25;

/**
 * Sum input + output (+ reasoning) tokens across all messages in a
 * conversation and estimate the total USD cost from the model's lookup-table
 * rates. Reasoning tokens are billed at the OUTPUT rate by every provider
 * that exposes them (OpenAI o-series, Codex). Cached input is billed at
 * `CACHED_INPUT_RATE_RATIO` × input rate.
 *
 * Returns `{ totalTokens, estCost }`. `estCost` is `null` when the model
 * is unknown (so callers can hide the pill).
 */
export function aggregateConversationCost(
  conv: AgentConversation,
): { totalTokens: number; estCost: number | null } {
  let totalIn = 0;
  let totalCachedIn = 0;
  let totalOut = 0;
  let totalReasoning = 0;
  for (const m of conv.messages ?? []) {
    if (m.inputTokens) totalIn += m.inputTokens;
    if (m.cacheReadTokens) totalCachedIn += m.cacheReadTokens;
    if (m.outputTokens) totalOut += m.outputTokens;
    if (m.reasoningTokens) totalReasoning += m.reasoningTokens;
  }
  // Don't double-count cached: input rate applies only to NEW input tokens
  // (input − cached), then cached pays its discounted rate on top.
  const newInputTokens = Math.max(0, totalIn - totalCachedIn);
  const totalTokens = totalIn + totalOut + totalReasoning;
  const rates = lookupRates(conv.model);
  if (!rates) return { totalTokens, estCost: null };
  const estCost =
    (newInputTokens * rates.input) / 1_000_000 +
    (totalCachedIn * rates.input * CACHED_INPUT_RATE_RATIO) / 1_000_000 +
    (totalOut * rates.output) / 1_000_000 +
    (totalReasoning * rates.output) / 1_000_000;
  return { totalTokens, estCost };
}

/**
 * Format a USD cost for a compact sidebar pill.
 * - `null`/`0` (or no tokens) -> `null` (caller hides the pill)
 * - `< $0.01` -> `"$<0.01"`
 * - otherwise -> `"$0.04"` (2 decimals)
 */
export function formatCostPill(estCost: number | null, totalTokens: number): string | null {
  if (estCost === null) return null;
  if (totalTokens <= 0) return null;
  if (estCost <= 0) return null;
  if (estCost < 0.01) return "$<0.01";
  return `$${estCost.toFixed(2)}`;
}
