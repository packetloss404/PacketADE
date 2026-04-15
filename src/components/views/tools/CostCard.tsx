import { useEffect } from "react";
import { DollarSign, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { useAnalyticsStore } from "@/stores/analyticsStore";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CostCard() {
  const data = useAnalyticsStore((s) => s.data);
  const loading = useAnalyticsStore((s) => s.loading);
  const error = useAnalyticsStore((s) => s.error);
  const load = useAnalyticsStore((s) => s.load);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4 col-span-2">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <DollarSign size={12} className="text-accent-green" />
          Usage Analytics
        </h3>
        <button
          onClick={load}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
          disabled={loading}
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 py-6 text-text-secondary">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-[11px]">Loading...</span>
        </div>
      )}

      {error && !data && (
        <div className="flex items-center gap-2 py-4 text-[11px] text-accent-red">
          <AlertCircle size={12} />
          {error}
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-3">
          {/* Summary stats row */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-bg-primary border border-bg-border rounded-lg p-3 text-center">
              <div className="text-[10px] text-text-muted mb-1">Total Cost</div>
              <div className="font-mono text-accent-green text-xs font-semibold">{formatCost(data.totalCostUsd)}</div>
            </div>
            <div className="bg-bg-primary border border-bg-border rounded-lg p-3 text-center">
              <div className="text-[10px] text-text-muted mb-1">Sessions</div>
              <div className="font-mono text-accent-green text-xs font-semibold">{formatNumber(data.totalSessions)}</div>
            </div>
            <div className="bg-bg-primary border border-bg-border rounded-lg p-3 text-center">
              <div className="text-[10px] text-text-muted mb-1">Input Tokens</div>
              <div className="font-mono text-accent-green text-xs font-semibold">{formatNumber(data.totalInputTokens)}</div>
            </div>
            <div className="bg-bg-primary border border-bg-border rounded-lg p-3 text-center">
              <div className="text-[10px] text-text-muted mb-1">Output Tokens</div>
              <div className="font-mono text-accent-green text-xs font-semibold">{formatNumber(data.totalOutputTokens)}</div>
            </div>
          </div>

          {/* Top models */}
          {data.modelUsage.length > 0 && (
            <div>
              <div className="text-[10px] text-text-muted mb-1.5">Top Models by Cost</div>
              <div className="flex flex-col gap-1">
                {[...data.modelUsage]
                  .sort((a, b) => b.costUsd - a.costUsd)
                  .slice(0, 5)
                  .map((m) => (
                    <div key={m.model} className="flex items-center justify-between text-[11px]">
                      <span className="font-mono text-text-secondary truncate mr-2">{m.model}</span>
                      <span className="font-mono text-accent-green flex-shrink-0">{formatCost(m.costUsd)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Mini bar chart — last 14 days */}
          {data.dailyCosts.length > 0 && (() => {
            const days = data.dailyCosts.slice(-14);
            const maxCost = Math.max(...days.map((d) => d.costUsd), 0.01);
            return (
              <div>
                <div className="text-[10px] text-text-muted mb-1.5">Daily Cost (Last 14 Days)</div>
                <div className="flex items-end gap-[2px] h-12">
                  {days.map((day) => {
                    const heightPct = (day.costUsd / maxCost) * 100;
                    return (
                      <div
                        key={day.date}
                        className="flex-1 bg-accent-green/50 hover:bg-accent-green rounded-t transition-colors"
                        style={{ height: `${Math.max(heightPct, 2)}%` }}
                        title={`${day.date}: ${formatCost(day.costUsd)}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
