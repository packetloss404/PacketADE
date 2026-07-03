/**
 * Single source of truth for model context-window sizing and live
 * context-occupancy math, shared by the Agents-tab status surfaces
 * (ContextUsageRing, SessionMetaLine). Previously each component carried
 * its own divergent heuristic, which disagreed by up to 5x for the default
 * Opus-4.8 model. Keep all context-window knowledge here.
 *
 * Numbers mirror the public 2026 spec sheets. Unknown ids fall through to
 * 200_000 (the median of the field) so a gauge still renders something
 * directional rather than collapsing.
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
  // MiniMax — M3 supports up to 1M context; M2 family is 200k (per MiniMax docs)
  "MiniMax-M3": 1_000_000,
  "MiniMax-M2.5": 200_000,
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

/**
 * Single source of truth for context-occupancy warning thresholds, shared by
 * every gauge that renders `computeContextOccupancy`'s fraction (previously
 * ContextUsageRing and SessionHealthBar disagreed — 70/90 vs 60/85).
 */
export const CONTEXT_WARN_FRACTION = 0.7;
export const CONTEXT_CRITICAL_FRACTION = 0.9;

/**
 * Resolve the total context-window size (in tokens) for a model id.
 * Default 200_000. Opus-4.8 (and any explicit `[1m]` long-context variant)
 * is 1_000_000. Other families are sized sensibly via the curated map and
 * a set of substring heuristics for unrecognized/dated ids.
 */
export function getModelContextWindow(
  model: string | undefined | null,
): number {
  if (!model) return DEFAULT_CONTEXT_TOKENS;
  const id = model.toLowerCase();

  // Long-context Opus / any explicit [1m] variant → 1M, regardless of the
  // exact dated suffix the provider appends.
  if (id.includes("opus-4-8") || id.includes("opus-4-7") || id.includes("[1m]"))
    return 1_000_000;

  // Exact map hit (keys are case-sensitive for MiniMax-*).
  if (MODEL_CONTEXT_TOKENS[model]) return MODEL_CONTEXT_TOKENS[model];
  // startsWith for dated variants like "claude-sonnet-4-6-20250414".
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_TOKENS)) {
    if (model.startsWith(prefix)) return limit;
  }

  // Family heuristics for unrecognized ids.
  if (id.includes("sonnet") || id.includes("haiku") || id.includes("claude"))
    return 200_000;
  if (id.includes("gpt-5") || id.includes("o3") || id.includes("o4"))
    return 400_000;
  if (id.includes("gpt-4o")) return 128_000;
  if (id.includes("minimax")) return 256_000;
  if (id.includes("gemini")) return 1_000_000;
  if (
    id.includes("ollama") ||
    id.includes("llama") ||
    id.includes("qwen") ||
    id.includes("mistral")
  )
    return 128_000;

  return DEFAULT_CONTEXT_TOKENS;
}

/**
 * Compute live context occupancy from a SINGLE turn's token usage (the
 * latest assistant turn), NOT a cross-turn sum. Each turn re-sends the
 * whole window, so summing multi-counts the same context and pins the
 * gauge to 100%.
 *
 * Cache reads/writes ARE part of the resident window: Anthropic's
 * `input_tokens` EXCLUDES cached tokens (they're reported separately as
 * cache read/write), so occupancy = input + cacheRead + cacheWrite.
 */
export function computeContextOccupancy(input: {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string | undefined;
}): { usedTokens: number; totalTokens: number; fraction: number } {
  const usedTokens =
    (input.inputTokens ?? 0) +
    (input.cacheReadTokens ?? 0) +
    (input.cacheWriteTokens ?? 0);
  const totalTokens = getModelContextWindow(input.model);
  const fraction =
    totalTokens > 0
      ? Math.min(1, Math.max(0, usedTokens / totalTokens))
      : 0;
  return { usedTokens, totalTokens, fraction };
}
