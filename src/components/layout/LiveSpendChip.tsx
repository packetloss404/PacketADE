import { useEffect, useMemo } from "react";
import { DollarSign } from "lucide-react";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import { useAppStore } from "@/stores/appStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { aggregateConversationCost } from "@/lib/conversationCost";

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
    // dailyCosts dates are stored as YYYY-MM-DD in local time of the
    // backend writer. Use today's local date for the lookup; if the
    // user is in a wildly different TZ the chip may be off-by-one for
    // the first hour of the day — acceptable for an inline pill.
    const today = new Date().toISOString().slice(0, 10);
    return data.dailyCosts.find((d) => d.date === today)?.costUsd ?? 0;
  }, [data]);

  const liveSession = useMemo(() => {
    let total = 0;
    for (const c of conversations) {
      if (c.mode !== "api") continue;
      const { estCost } = aggregateConversationCost(c);
      if (estCost && estCost > 0) total += estCost;
    }
    return total;
  }, [conversations]);

  const total = todayPersisted + liveSession;
  if (total <= 0) return null;

  const tooltip =
    `$${total.toFixed(2)} total today\n` +
    `  · $${todayPersisted.toFixed(2)} persisted (cost-tally + previous runs)\n` +
    `  · $${liveSession.toFixed(2)} live across open conversations\n` +
    `Click to open the Cost Dashboard.`;

  return (
    <button
      type="button"
      onClick={() => setActiveView("cost_dashboard")}
      title={tooltip}
      className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-bg-elevated text-text-secondary hover:text-accent-green transition-colors"
    >
      <DollarSign size={11} className="text-accent-green" />
      <span className="tabular-nums">{formatUsd(total)}</span>
    </button>
  );
}
