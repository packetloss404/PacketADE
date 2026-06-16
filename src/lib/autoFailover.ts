/**
 * Auto-failover policy. When a model returns a rate-limit / overload error,
 * the conversation can transparently retry against a cheaper / faster model
 * on the same provider before surfacing the failure to the user. Multi-
 * provider parity is one of PacketADE's distinguishing wins (no single-vendor
 * tool can do this); see plan T3.E for context.
 */

import { API_PROVIDERS } from "@/lib/api-models";

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
 * failover. Walks "thorough → balanced → fast" within the matching provider
 * catalog. Returns null when no catalog-backed fallback exists (the caller
 * surfaces the original error in that case).
 */
export function pickFailoverModel(currentModel: string): string | null {
  const providerModels = findProviderCatalog(currentModel);
  if (!providerModels) return null;

  const m = currentModel.toLowerCase();
  const pick = (predicate: (model: string) => boolean): string | null =>
    providerModels.find((model) => predicate(model.toLowerCase())) ?? null;

  // Anthropic ladder. Each tier degrades in capability but increases in
  // availability + cheapness, which is exactly the trade-off we want when
  // rate-limited on a premium model.
  if (m.includes("claude-opus")) return pick((model) => model.includes("claude-sonnet"));
  if (m.includes("claude-sonnet")) return pick((model) => model.includes("claude-haiku"));

  // OpenAI ladder.
  if (m === "o3" || m.includes("o3-")) return pick((model) => model.includes("gpt-5.5"));
  if (
    (m.includes("gpt-5") || m.includes("chatgpt-5")) &&
    !m.includes("mini")
  ) {
    return pick((model) => model.includes("o4-mini"));
  }
  if (m.includes("gpt-4o") && !m.includes("mini")) {
    return pick((model) => model.includes("o4-mini"));
  }

  // MiniMax M2 family: fall back to any other MiniMax tier in the catalog
  // (e.g. M2.5 -> M2.1 -> M2) when the current one is rate-limited.
  if (m.includes("minimax")) {
    return pick((model) => model.includes("minimax") && model !== m);
  }

  return null;
}

function findProviderCatalog(currentModel: string): string[] | null {
  const current = currentModel.toLowerCase();
  const normalizedCurrent = stripDateSuffix(current);
  for (const provider of API_PROVIDERS) {
    const values = provider.models.map((model) => model.value);
    const hasModel = values.some((value) => {
      const normalizedValue = stripDateSuffix(value.toLowerCase());
      return value.toLowerCase() === current || normalizedValue === normalizedCurrent;
    });
    if (hasModel) return values;
  }
  return null;
}

function stripDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, "");
}
