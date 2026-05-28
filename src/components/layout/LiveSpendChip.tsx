import { useEffect, useMemo } from "react";
import { AlertTriangle, DollarSign } from "lucide-react";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import { useAppStore } from "@/stores/appStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { aggregateConversationCost } from "@/lib/conversationCost";
import { computeCostGuardrailStatus, isUnknownPricedUsage } from "@/lib/costGuardrails";

/** Refresh interval for the persisted-spend half (today's total from
 * `~/.claude/cost-tally.json` etc.). Live-session spend updates in real
 * time via the agentTaskStore subscription, so this only needs to be
 * frequent enough to catch usage logged by *external* CLI runs. */
const REFRESH_MS = 30_000;

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "$<0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
}

/**
 * Toolbar chip showing live + today's spend across all conversations.
 * Click opens the CostDashboard.
 *
 * Two figures combined:
 *   - "today" — persisted across runs, pulled from analyticsStore (which
 *     reads `~/.claude/cost-tally.json` and the OpenAI-equivalent files).
 *     Refreshed every 30s so external CLI usage rolls in too.
 *   - "live" — sum of in-memory cost across every open API conversation,
 *     updates immediately on every streaming `turn_summary` event.
 *
 * The chip's primary number is `today + live` so the user sees a single
 * "what have I burned today" figure that includes the conversation
 * currently mid-stream. Renders nothing when both halves are zero.
 */
export function LiveSpendChip() {
  const data = useAnalyticsStore((s) => s.data);
  const load = useAnalyticsStore((s) => s.load);
  const guardrailSettings = useAnalyticsStore((s) => s.guardrailSettings);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const conversations = useAgentTaskStore((s) => s.conversations);

  // Periodic refresh of persisted-today figure. First load fires immediately.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const todayPersisted = useMemo(() => {
    if (!data) return 0;
    // dailyCosts dates are stored as YYYY-MM-DD in UTC (see
    // `today_date_string()` in src-tauri/src/commands/analytics.rs which
    // uses chrono::Utc). Use UTC on the frontend too via toISOString so
    // both sides agree on which bucket "today" is.
    const today = new Date().toISOString().slice(0, 10);
    return data.dailyCosts.find((d) => d.date === today)?.costUsd ?? 0;
  }, [data]);

  const liveSummary = useMemo(() => {
    let costUsd = 0;
    let hasUnknownPricing = false;

    for (const c of conversations) {
      if (c.mode !== "api") continue;
      const { totalTokens, estCost } = aggregateConversationCost(c);
      if (estCost && estCost > 0) {
        costUsd += estCost;
      } else if (estCost === null && totalTokens > 0) {
        hasUnknownPricing = true;
      }
    }

    return { costUsd, hasUnknownPricing };
  }, [conversations]);

  const hasPersistedUnknownPricing = useMemo(
    () => data?.modelUsage.some((m) => isUnknownPricedUsage(m)) ?? false,
    [data],
  );

  const total = todayPersisted + liveSummary.costUsd;
  if (total <= 0) return null;

  const guardrailStatus = computeCostGuardrailStatus(
    data ? { ...data, todayCostUsd: total } : null,
    guardrailSettings,
    { currentSessionCostUsd: liveSummary.costUsd },
  );
  const warning =
    guardrailStatus.activeScope?.level === "warning" || guardrailStatus.level === "warning";
  const over = guardrailStatus.activeScope?.level === "limit" || guardrailStatus.level === "limit";
  const hasUnknownPricing = liveSummary.hasUnknownPricing || hasPersistedUnknownPricing;
  const activeScope = guardrailStatus.activeScope;
  const guardrailLine = activeScope
    ? `${activeScope.scope} ${activeScope.percentUsed.toFixed(0)}% of $${activeScope.limitUsd.toFixed(2)}`
    : "no active limit";

  const tooltip =
    `$${total.toFixed(2)} total today\n` +
    `  · $${todayPersisted.toFixed(2)} persisted (cost-tally + previous runs)\n` +
    `  · $${liveSummary.costUsd.toFixed(2)} live across open conversations\n` +
    `  · guardrail ${guardrailLine}\n` +
    (hasUnknownPricing ? "  · unknown-priced model present\n" : "") +
    `Click to open the Cost Dashboard.`;

  const className = over
    ? "flex items-center gap-1 px-2 py-0.5 rounded border border-accent-red/30 text-xs bg-accent-red/10 text-accent-red hover:bg-accent-red/15 transition-colors"
    : warning
      ? "flex items-center gap-1 px-2 py-0.5 rounded border border-accent-amber/30 text-xs bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/15 transition-colors"
      : "flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-bg-elevated text-text-secondary hover:text-accent-green transition-colors";

  return (
    <button
      type="button"
      onClick={() => setActiveView("cost_dashboard")}
      title={tooltip}
      className={className}
    >
      {hasUnknownPricing ? <AlertTriangle size={11} /> : <DollarSign size={11} />}
      <span className="tabular-nums">{formatUsd(total)}</span>
    </button>
  );
}
