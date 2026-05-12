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
  "gpt-5-codex": { input: 5, output: 15 },
  "gpt-5": { input: 5, output: 15 },
  "chatgpt-5.5": { input: 5, output: 15 },
  "chatgpt-5.4": { input: 5, output: 15 },
  "openai/gpt-5.5": { input: 5, output: 15 },
  "openai/chatgpt-5.5": { input: 5, output: 15 },
  "openai/chatgpt-5.4": { input: 5, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
  o3: { input: 15, output: 60 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "MiniMax-M2.7": { input: 0.3, output: 1.2 },
  "MiniMax-M2.7-highspeed": { input: 0.3, output: 1.2 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "meta-llama/llama-4-maverick": { input: 0.2, output: 0.6 },
  "llama3.3:70b": { input: 0, output: 0 },
  "qwen3:32b": { input: 0, output: 0 },
  "deepseek-coder-v2": { input: 0, output: 0 },
  "codellama:34b": { input: 0, output: 0 },
};

/**
 * Look up rates for a model id. Tries exact match first, then strips a
 * trailing date suffix (e.g. "claude-sonnet-4-6-20250414" -> "claude-sonnet-4-6").
 */
function lookupRates(model: string | undefined): { input: number; output: number } | null {
  if (!model) return null;
  for (const key of rateLookupKeys(model)) {
    const rates = COST_PER_MTOK[key];
    if (rates) return rates;
  }
  return null;
}

function rateLookupKeys(model: string): string[] {
  const keys = [model];
  const strippedDate = model.replace(/-\d{8}$/, "");
  if (strippedDate !== model) keys.push(strippedDate);

  const slashIndex = strippedDate.indexOf("/");
  if (slashIndex >= 0) {
    const withoutProvider = strippedDate.slice(slashIndex + 1);
    keys.push(withoutProvider);
    const withoutProviderAndDate = withoutProvider.replace(/-\d{8}$/, "");
    if (withoutProviderAndDate !== withoutProvider) keys.push(withoutProviderAndDate);
  }

  return [...new Set(keys)];
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
  // A3: roll Codex MultiAgentV2 sub-agent buckets into the totals so
  // multi-agent flights account for their children's spend. Without this
  // the conversation looks artificially cheap (root totals only) while
  // the user actually paid for N sub-agent threads.
  for (const bucket of Object.values(conv.subAgentTokens ?? {})) {
    totalIn += bucket.inputTokens;
    totalCachedIn += bucket.cacheReadTokens;
    totalOut += bucket.outputTokens;
    totalReasoning += bucket.reasoningTokens;
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
