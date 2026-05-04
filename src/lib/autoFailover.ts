/**
 * Auto-failover policy. When a model returns a rate-limit / overload error,
 * the conversation can transparently retry against a cheaper / faster model
 * on the same provider before surfacing the failure to the user. Multi-
 * provider parity is one of PacketADE's distinguishing wins (no single-vendor
 * tool can do this); see plan T3.E for context.
 */

/**
 * Heuristic — does this error message look like a rate-limit / quota /
 * overload condition that another model could plausibly serve? Conservative:
 * only matches strings provider SDKs actually emit, so transient network
 * errors and real API misuse don't accidentally trigger failover.
 */
export function looksLikeRateLimit(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("rate-limit") ||
    m.includes("429") ||
    m.includes("quota") ||
    m.includes("overloaded") ||
    m.includes("overload_error") ||
    m.includes("credit balance") ||
    m.includes("insufficient_quota") ||
    m.includes("usage limit") ||
    m.includes("tokens per minute")
  );
}

/**
 * Given the current model, return the next model to try as a same-provider
 * failover. Walks "thorough → balanced → fast" in the model id space using
 * a hardcoded ladder per provider. Returns null when no fallback exists
 * (the caller surfaces the original error in that case).
 */
export function pickFailoverModel(currentModel: string): string | null {
  const m = currentModel.toLowerCase();

  // Anthropic ladder. Each tier degrades in capability but increases in
  // availability + cheapness, which is exactly the trade-off we want when
  // rate-limited on a premium model.
  if (m.includes("claude-opus")) return "claude-sonnet-4-6";
  if (m.includes("claude-sonnet")) return "claude-haiku-4-5";

  // OpenAI ladder.
  if (m === "o3" || m.includes("o3-")) return "gpt-5.5";
  if (m.includes("gpt-5") && !m.includes("mini")) return "o4-mini";
  if (m.includes("gpt-4o") && !m.includes("mini")) return "gpt-4o-mini";

  // MiniMax: only one tier really, fall back to highspeed if not already.
  if (m.includes("minimax-m2.7") && !m.includes("highspeed")) {
    return "MiniMax-M2.7-highspeed";
  }

  return null;
}
