/**
 * Auto-failover policy. When a model returns a rate-limit / overload error,
 * the conversation can transparently retry against a cheaper / faster model
 * on the same provider before surfacing the failure to the user. Multi-
 * provider parity is one of PacketBench's distinguishing wins (no single-vendor
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
 * Is this an ACCOUNT-level exhaustion rather than a per-model throttle?
 *
 * The distinction decides whether failover can possibly help. A 429 / overload
 * is usually per-model capacity, so a different tier on the same vendor is a
 * genuine escape hatch. A drained credit balance or a spent quota is a property
 * of the *account*, shared by every model that account can reach — retrying on
 * a cheaper tier just walks into the identical wall one request later, having
 * spent another request and shown the user a misleading "retrying on X" notice.
 *
 * This is why MiniMax's ladder was actively harmful: it failed M2.5 over to
 * another MiniMax tier drawing on the same quota pool. It is equally wrong for
 * Anthropic and OpenAI, so the guard is vendor-independent.
 */
export function isAccountLevelExhaustion(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("quota") ||
    m.includes("credit balance") ||
    m.includes("insufficient_quota") ||
    m.includes("usage limit") ||
    m.includes("billing")
  );
}

/**
 * Given the current model, return the next model to try as a same-provider
 * failover. Walks "thorough → balanced → fast" within the matching provider
 * catalog. Returns null when no catalog-backed fallback exists (the caller
 * surfaces the original error in that case).
 *
 * **Same-provider by construction, not by preference.** `retryLastTurn` swaps
 * only `SessionConfig.model` on the live backend session — the provider, its
 * endpoint and its API key are fixed for the session's lifetime. Handing back
 * another vendor's model id would therefore post e.g. `claude-sonnet-5` to
 * MiniMax's endpoint and fail harder than the error we were recovering from.
 * Cross-vendor failover needs a provider swap on a live session (new key, new
 * endpoint, re-derived tool schema); until that exists, the honest fix for a
 * shared-quota wall is to decline the retry — see `isAccountLevelExhaustion`.
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

  // MiniMax family: fall back to any other MiniMax tier in the catalog
  // (e.g. M3 -> M2.5 -> M2) when the current one is rate-limited. Every tier
  // draws on one account quota pool, so this only ever helps for a per-model
  // throttle — the caller must have ruled out account-level exhaustion first
  // (`isAccountLevelExhaustion`).
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
