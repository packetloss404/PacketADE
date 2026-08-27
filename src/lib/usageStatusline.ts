import { storageKey } from "@/lib/brand";
import { isUnknownPricedUsage } from "@/lib/costGuardrails";
import { computeContextOccupancy } from "@/lib/modelContext";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

/**
 * The composer statusline — `ctx 41.2k tok · in 82k · out 12k`.
 *
 * Ported from packetcode-gui's Composer (`fmtTokens` / `fmtCost` /
 * `usageStatusline`) so the two clients read the same way.
 *
 * ## The `$` segment is opt-in and defaults OFF
 *
 * PacketBench deliberately removed its cost REPORTING surface on 2026-07-31 (see
 * the notes at `conversationCost.ts` and the old `CostDashboardView`). Cost is
 * still measured and still drives the budget guardrails in `costGuardrails.ts`
 * — it is simply not displayed. Re-adding a dollar figure to the composer would
 * silently reverse that decision, so it ships behind BOTH:
 *
 *   1. `caps.reportsCost` — the model has published rates at all, and
 *   2. `isCostDisplayEnabled()` — a persisted user setting that defaults OFF.
 *
 * plus an `isUnknownPricedUsage` gate, so an unpriced model renders NOTHING
 * rather than a confident `$0.00`.
 *
 * This is display only. Nothing here may be read by the guardrails, and the
 * guardrails must keep stopping runaway spend whether or not the segment is on.
 */

/** Persisted opt-in for the composer's `$` segment. Absent → OFF. */
export const SHOW_COST_STORAGE_KEY = storageKey("agents:show-cost");

/** Token/cost totals for ONE session, in the shape the statusline formats. */
export interface SessionUsage {
  /** Resident context of the latest completed turn (input + cache). */
  contextTokens: number;
  /** Prompt-side tokens across the whole session. */
  totalInput: number;
  /** Completion-side tokens (output + reasoning) across the whole session. */
  totalOutput: number;
  /** Measured spend, already stamped per-turn at receipt time. */
  costUsd: number;
}

/**
 * Compact token count: 820 -> "820", 41234 -> "41.2k", 1200000 -> "1.2M".
 * The M threshold sits just below 1M so 999,950+ rounds to "1M", not "1000k".
 */
export function fmtTokens(n: number): string {
  const scaled = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return text + suffix;
  };
  if (n >= 999_950) return scaled(n / 1_000_000, "M");
  if (n >= 1000) return scaled(n / 1000, "k");
  return String(n);
}

/**
 * "$1.84"; sub-cent spend keeps a third digit, and anything below a tenth of
 * a cent shows as "<$0.001" rather than a misleading zero.
 */
export function fmtCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0005) return `$${usd.toFixed(3)}`;
  return "<$0.001";
}

/**
 * `ctx 41.2k tok · in 82k · out 12k · $1.84`, omitting unknown/zero segments;
 * null when there is nothing to show.
 *
 * `showCost` defaults to false — see the module note. Callers pass the result
 * of `shouldShowCost`, never a bare `true`.
 */
export function usageStatusline(
  usage: SessionUsage | null,
  showCost = false,
): string | null {
  if (!usage) return null;
  const segments: string[] = [];
  if (usage.contextTokens > 0) segments.push(`ctx ${fmtTokens(usage.contextTokens)} tok`);
  if (usage.totalInput > 0) segments.push(`in ${fmtTokens(usage.totalInput)}`);
  if (usage.totalOutput > 0) segments.push(`out ${fmtTokens(usage.totalOutput)}`);
  if (showCost && usage.costUsd > 0) segments.push(fmtCost(usage.costUsd));
  return segments.length > 0 ? segments.join(" · ") : null;
}

/** True when a message reported any token counts at all. */
function hasUsage(m: AgentMessage): boolean {
  return (
    (m.inputTokens ?? 0) > 0 ||
    (m.outputTokens ?? 0) > 0 ||
    (m.cacheReadTokens ?? 0) > 0 ||
    (m.cacheWriteTokens ?? 0) > 0
  );
}

/**
 * Roll a conversation up into a `SessionUsage`.
 *
 * `contextTokens` is the resident window of the LATEST reporting turn (the
 * same `computeContextOccupancy` math ContextUsageRing paints) — not a
 * cross-turn sum, which would multi-count the re-sent window. `totalInput` /
 * `totalOutput` ARE cumulative: they answer "what has this session spent".
 *
 * `costUsd` sums the per-turn `costUsd` already stamped by
 * `conversationCost.estimateTurnCostUsd` at receipt time, so this function
 * stays free of store reads and never re-prices history.
 */
export function sessionUsageFor(
  conversation: Pick<AgentConversation, "messages" | "model">,
): SessionUsage | null {
  let totalInput = 0;
  let totalOutput = 0;
  let costUsd = 0;
  let latest: AgentMessage | undefined;

  for (const m of conversation.messages ?? []) {
    if (m.role !== "assistant") continue;
    totalInput +=
      (m.inputTokens ?? 0) + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0);
    totalOutput += (m.outputTokens ?? 0) + (m.reasoningTokens ?? 0);
    costUsd += m.costUsd ?? 0;
    if (hasUsage(m)) latest = m;
  }

  if (totalInput === 0 && totalOutput === 0) return null;

  const contextTokens = latest
    ? computeContextOccupancy({
        inputTokens: latest.inputTokens,
        cacheReadTokens: latest.cacheReadTokens,
        cacheWriteTokens: latest.cacheWriteTokens,
        model: conversation.model,
      }).usedTokens
    : 0;

  return { contextTokens, totalInput, totalOutput, costUsd };
}

/** Read the persisted opt-in. Any read failure (private mode, SSR) → OFF. */
export function isCostDisplayEnabled(): boolean {
  try {
    return window.localStorage.getItem(SHOW_COST_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Flip the persisted opt-in. Display only — guardrails are unaffected. */
export function setCostDisplayEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SHOW_COST_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    /* non-persistent environment — the segment simply stays off */
  }
}

/**
 * Should the `$` segment render for this session?
 *
 * All three gates must pass:
 *  - the model has published rates (`reportsCost`),
 *  - the user opted in (`isCostDisplayEnabled`, default OFF),
 *  - and the usage is not "unknown pricing" — an unpriced model must show
 *    nothing at all rather than a confident `$0.00`.
 */
export function shouldShowCost(
  reportsCost: boolean,
  conversation: Pick<AgentConversation, "agent" | "model">,
  usage: SessionUsage | null,
): boolean {
  if (!reportsCost || !usage) return false;
  if (!isCostDisplayEnabled()) return false;
  return !isUnknownPricedUsage({
    source: conversation.agent,
    model: conversation.model ?? "",
    inputTokens: usage.totalInput,
    outputTokens: usage.totalOutput,
    costUsd: usage.costUsd,
  });
}
