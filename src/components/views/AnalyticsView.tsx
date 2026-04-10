import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  DollarSign,
  Hash,
  Cpu,
  ArrowUpRight,
  ArrowDownLeft,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useAnalyticsStore, type ModelUsage, type DailyCost } from "@/stores/analyticsStore";
import { useCostStore } from "@/stores/costStore";

type Tab = "overview" | "history";

export function AnalyticsView() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="flex flex-col h-full bg-bg-primary p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 size={16} className="text-accent-blue" />
        <h2 className="text-sm font-semibold text-text-primary">Cost &amp; Usage</h2>
        <div className="ml-4 flex items-center gap-1">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => setTab("history")}>
            Session History
          </TabButton>
        </div>
      </div>

      {tab === "overview" ? <OverviewTab /> : <HistoryTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
        active
          ? "text-accent-green bg-bg-elevated"
          : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
      }`}
    >
      {children}
    </button>
  );
}

function OverviewTab() {
  const data = useAnalyticsStore((s) => s.data);
  const loading = useAnalyticsStore((s) => s.loading);
  const error = useAnalyticsStore((s) => s.error);
  const load = useAnalyticsStore((s) => s.load);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex-1">
      <div className="flex items-center justify-end mb-3">
        <button
          onClick={load}
          disabled={loading}
          className="p-1.5 text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="text-[10px] text-accent-amber bg-accent-amber/10 rounded px-2 py-1 mb-3">
          {error}
        </div>
      )}

      {loading && !data && (
        <p className="text-xs text-text-muted">Loading analytics...</p>
      )}

      {data && (
        <div className="space-y-4 max-w-3xl">
          <div className="grid grid-cols-4 gap-3">
            <SummaryCard
              icon={<DollarSign size={12} />}
              label="Total Cost"
              value={`$${data.totalCostUsd.toFixed(2)}`}
              color="text-accent-green"
            />
            <SummaryCard
              icon={<Hash size={12} />}
              label="Sessions"
              value={String(data.totalSessions)}
              color="text-accent-blue"
            />
            <SummaryCard
              icon={<ArrowUpRight size={12} />}
              label="Input Tokens"
              value={formatTokens(data.totalInputTokens)}
              color="text-accent-purple"
            />
            <SummaryCard
              icon={<ArrowDownLeft size={12} />}
              label="Output Tokens"
              value={formatTokens(data.totalOutputTokens)}
              color="text-accent-amber"
            />
          </div>

          {data.dailyCosts.length > 0 && (
            <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
              <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
                <BarChart3 size={12} className="text-accent-green" />
                Daily Cost (Last 30 Days)
              </h3>
              <DailyCostChart data={data.dailyCosts} />
            </div>
          )}

          {data.modelUsage.length > 0 && (
            <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
              <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Cpu size={12} className="text-accent-blue" />
                Model Breakdown
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-text-muted border-b border-bg-border">
                      <th className="text-left py-1.5 pr-4 font-medium">Model</th>
                      <th className="text-right py-1.5 px-3 font-medium">Sessions</th>
                      <th className="text-right py-1.5 px-3 font-medium">Input</th>
                      <th className="text-right py-1.5 px-3 font-medium">Output</th>
                      <th className="text-right py-1.5 pl-3 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.modelUsage.map((m) => (
                      <ModelRow key={m.model} model={m} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.modelUsage.length === 0 && data.dailyCosts.length === 0 && (
            <p className="text-xs text-text-muted">
              No usage data found. Analytics are sourced from ~/.claude/cost-tally.json.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryTab() {
  const entries = useCostStore((s) => s.entries);
  const clearEntries = useCostStore((s) => s.clearEntries);
  const summary = useMemo(() => useCostStore.getState().getSummary(), [entries]);

  const days = useMemo(() => {
    const result: { day: string; cost: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      result.push({ day: label, cost: summary.costByDay[key] || 0 });
    }
    return result;
  }, [summary.costByDay]);

  const maxDayCost = Math.max(...days.map((d) => d.cost), 0.01);

  return (
    <div className="flex-1">
      <div className="flex items-center justify-end mb-3">
        <button
          onClick={clearEntries}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-muted hover:text-accent-red transition-colors"
        >
          <Trash2 size={11} />
          Clear
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6 max-w-xl">
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
          <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Total Cost</p>
          <p className="text-lg font-semibold text-accent-amber">
            ${summary.totalCost.toFixed(2)}
          </p>
        </div>
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
          <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Sessions</p>
          <p className="text-lg font-semibold text-text-primary">{summary.sessionCount}</p>
        </div>
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
          <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Avg / Session</p>
          <p className="text-lg font-semibold text-text-primary">
            ${summary.sessionCount > 0 ? (summary.totalCost / summary.sessionCount).toFixed(2) : "0.00"}
          </p>
        </div>
      </div>

      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4 mb-6 max-w-xl">
        <h3 className="text-xs font-semibold text-text-primary mb-4 flex items-center gap-2">
          <BarChart3 size={12} className="text-accent-green" />
          Last 7 Days
        </h3>
        <div className="flex items-end gap-2 h-32">
          {days.map((d, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[9px] text-text-muted">
                {d.cost > 0 ? `$${d.cost.toFixed(2)}` : ""}
              </span>
              <div
                className="w-full bg-accent-green/30 rounded-t transition-all"
                style={{
                  height: `${Math.max(2, (d.cost / maxDayCost) * 100)}%`,
                  minHeight: d.cost > 0 ? 4 : 2,
                }}
              />
              <span className="text-[8px] text-text-muted truncate max-w-full">
                {d.day.split(",")[0]}
              </span>
            </div>
          ))}
        </div>
      </div>

      {Object.keys(summary.costByModel).length > 0 && (
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4 max-w-xl">
          <h3 className="text-xs font-semibold text-text-primary mb-3">Cost by Model</h3>
          <div className="flex flex-col gap-2">
            {Object.entries(summary.costByModel)
              .sort(([, a], [, b]) => b - a)
              .map(([model, cost]) => (
                <div key={model} className="flex items-center gap-2">
                  <span className="text-[11px] text-text-secondary flex-1 truncate">{model}</span>
                  <span className="text-[11px] text-accent-amber font-medium">
                    ${cost.toFixed(2)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {entries.length === 0 && (
        <div className="text-center text-text-muted text-sm mt-8">
          No cost data yet. Start a session to begin tracking.
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-3">
      <div className={`flex items-center gap-1.5 mb-1 ${color}`}>
        {icon}
        <span className="text-[10px] text-text-muted">{label}</span>
      </div>
      <p className="text-sm font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function ModelRow({ model }: { model: ModelUsage }) {
  return (
    <tr className="border-b border-bg-border/50 text-text-secondary hover:bg-bg-hover/30">
      <td className="py-1.5 pr-4 text-text-primary font-medium truncate max-w-[200px]">
        {model.model}
      </td>
      <td className="text-right py-1.5 px-3">{model.sessions}</td>
      <td className="text-right py-1.5 px-3">{formatTokens(model.inputTokens)}</td>
      <td className="text-right py-1.5 px-3">{formatTokens(model.outputTokens)}</td>
      <td className="text-right py-1.5 pl-3 text-accent-green">
        ${model.costUsd.toFixed(2)}
      </td>
    </tr>
  );
}

function DailyCostChart({ data }: { data: DailyCost[] }) {
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.01);
  const chartHeight = 120;
  const barWidth = Math.max(4, Math.min(16, (600 - data.length * 2) / data.length));

  return (
    <div className="flex items-end gap-[2px] h-[120px] overflow-x-auto">
      {data.map((d, i) => {
        const height = Math.max(2, (d.costUsd / maxCost) * chartHeight);
        return (
          <div key={i} className="flex flex-col items-center flex-shrink-0 group">
            <div className="relative">
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                <div className="bg-bg-elevated text-text-primary text-[9px] px-1.5 py-0.5 rounded shadow-lg whitespace-nowrap border border-bg-border">
                  {d.date}: ${d.costUsd.toFixed(2)}
                </div>
              </div>
              <div
                className="bg-accent-green/60 hover:bg-accent-green/80 rounded-t-sm transition-colors"
                style={{ width: barWidth, height }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
