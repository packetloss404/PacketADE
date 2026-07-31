import type { AgentConversation } from "@/types/agent-conversation";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import { calculateCostUsd, ratesForModel, type PricedAt } from "@/lib/modelPricing";

/**
 * Conversation cost estimation.
 *
 * NOTE (2026-07-31): the user-facing cost REPORTING surface was removed. What
 * remains here is measurement, not display — `estimateTurnCostUsd` stamps
 * `costUsd` on assistant messages at receipt time and `aggregateConversationCost`
 * still supplies token totals. The dollar figures feed the budget guardrails
 * (`lib/costGuardrails.ts`), which stop runaway agents. Do not add formatting
 * helpers here; there is no dashboard to format for any more.
 *
 * Rates come from `shared/model-pricing.json` via `lib/modelPricing.ts` — the
 * same file the Rust engine compiles in. This module used to carry its own
 * `COST_PER_MTOK` table that disagreed with Rust's on three shipped models;
 * that table is gone and must not come back. Add rates to the shared JSON.
 *
 * Every cache class is priced at its own published rate (read / 5-minute write
 * / 1-hour write) rather than one blended ratio, because cache creation is the
 * most expensive token class and is about to become non-zero (CE6).
 */

/** Raw per-turn token counts as the listeners record them. */
export interface TurnTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * Public accessor for input/output rates — used by api-models.ts to populate
 * ModelSelector's price display so no second table has to be hand-mirrored.
 */
export function getModelRates(model: string | undefined): { input: number; output: number } | null {
  const rates = ratesForModel(model);
  if (!rates) return null;
  return { input: rates.input, output: rates.output };
}

/**
 * Price one turn's raw token counts.
 *
 * The shared cost primitive is additive over DISJOINT buckets, so vendors that
 * report prompt tokens as a superset of their cached reads (OpenAI
 * `cached_tokens`) are normalised here, driven by the table's
 * `inputIncludesCacheRead` flag. Anthropic's buckets are already disjoint and
 * are no longer wrongly subtracted. Reasoning tokens bill at the output rate.
 *
 * `at` is the moment the turn was billed — pass the message timestamp so a
 * later published rate change never reprices an old turn.
 */
function costForTurn(model: string | undefined, tokens: TurnTokens, at?: PricedAt): number | null {
  const rates = ratesForModel(model, at);
  if (!rates) return null;
  const rawInput = tokens.inputTokens ?? 0;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  return calculateCostUsd(
    model,
    {
      input: rates.inputIncludesCacheRead ? Math.max(0, rawInput - cacheRead) : rawInput,
      output: (tokens.outputTokens ?? 0) + (tokens.reasoningTokens ?? 0),
      cacheRead,
      cacheWrite5m: tokens.cacheWriteTokens ?? 0,
    },
    at,
  );
}

/**
 * Estimate the USD cost of a single turn. Returns `null` when the model is
 * unknown so callers can hide the cost rather than show a false $0.00.
 *
 * Used to stamp `costUsd` on assistant messages at receipt time
 * (apiAgentListeners) — no per-message IPC.
 */
export function estimateTurnCostUsd(
  model: string | undefined,
  tokens: TurnTokens,
  at?: PricedAt,
): number | null {
  return costForTurn(model, tokens, at);
}

/**
 * Sum tokens across a conversation and estimate total USD cost.
 *
 * Each message is priced at the rates in effect on ITS OWN timestamp, so a
 * conversation spanning a published rate change (e.g. Claude Sonnet 5 leaving
 * introductory pricing on 2026-09-01) is not retroactively repriced.
 *
 * Returns `{ totalTokens, estCost }`; `estCost` is `null` when the model is
 * unknown (so callers can hide the pill).
 */
export function aggregateConversationCost(
  conv: AgentConversation,
): { totalTokens: number; estCost: number | null } {
  let totalTokens = 0;
  let estCost = 0;
  const priced = ratesForModel(conv.model) !== null;

  for (const m of conv.messages ?? []) {
    totalTokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.reasoningTokens ?? 0);
    if (!priced) continue;
    estCost += costForTurn(conv.model, m, m.timestamp) ?? 0;
  }

  // A3: roll Codex MultiAgentV2 sub-agent buckets into the totals so
  // multi-agent flights account for their children's spend. Without this
  // the conversation looks artificially cheap (root totals only) while
  // the user actually paid for N sub-agent threads. Buckets live in
  // agentStreamingStore (ephemeral; reset between sessions) and carry no
  // timestamp, so they price at current rates.
  const buckets = useAgentStreamingStore.getState().getSubAgentTokens(conv.id);
  if (buckets) {
    for (const bucket of Object.values(buckets)) {
      totalTokens += bucket.inputTokens + bucket.outputTokens + bucket.reasoningTokens;
      if (!priced) continue;
      estCost += costForTurn(conv.model, bucket) ?? 0;
    }
  }

  return { totalTokens, estCost: priced ? estCost : null };
}
