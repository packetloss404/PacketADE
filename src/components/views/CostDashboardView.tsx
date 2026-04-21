import { useEffect, useMemo, useState } from "react";
import { DollarSign, Hash, ArrowDownRight, ArrowUpRight, Loader2, AlertCircle, RefreshCw, Info, X } from "lucide-react";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import type { AnalyticsData } from "@/stores/analyticsStore";

const SOURCE_LABELS: Record<string, string> = {
  "claude-cli": "Claude CLI",
  "codex": "Codex CLI",
  "claude-oauth": "Anthropic (Subscription)",
  "api-claude": "Claude API",
  "openai-codex": "OpenAI (ChatGPT)",
  "api-openai": "OpenAI API",
  "api-minimax": "MiniMax API",
  "api-openrouter": "OpenRouter",
  "api-ollama": "Ollama (local)",
};
function sourceLabel(s: string): string { return SOURCE_LABELS[s] ?? s; }

const SOURCE_PILL_CLASSES: Record<string, string> = {
  "claude-cli": "text-accent-amber border-accent-amber/30",
  "claude-oauth": "text-accent-amber border-accent-amber/30",
  "api-claude": "text-accent-amber border-accent-amber/30",
  "codex": "text-accent-blue border-accent-blue/30",
  "openai-codex": "text-accent-green border-accent-green/30",
  "api-openai": "text-accent-green border-accent-green/30",
  "api-openrouter": "text-accent-purple border-accent-purple/30",
};
function sourcePillClass(s: string): string {
  return SOURCE_PILL_CLASSES[s] ?? "text-text-secondary border-bg-border";
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function SummaryCard({ label, value, icon: Icon, iconClass }: {
  label: string;
  value: string;
  icon: typeof DollarSign;
  iconClass: string;
}) {
  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon size={12} className={iconClass} />
        <span className="text-[11px]">{label}</span>
      </div>
      <span className="font-mono text-accent-green text-sm font-semibold">{value}</span>
    </div>
  );
}

function ModelUsageTable({ data, sourceFilter }: { data: AnalyticsData; sourceFilter: string }) {
  const sorted = [...data.modelUsage]
    .filter((m) => sourceFilter === "all" || m.source === sourceFilter)
    .sort((a, b) => b.costUsd - a.costUsd);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3">Model Usage</h3>
      {sorted.length === 0 ? (
        <p className="text-[10px] text-text-muted text-center py-4">No model usage data.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-text-secondary border-b border-bg-border">
                <th className="text-left py-2 pr-4 font-medium">Source</th>
                <th className="text-left py-2 pr-4 font-medium">Model</th>
                <th className="text-right py-2 px-3 font-medium">Sessions</th>
                <th className="text-right py-2 px-3 font-medium">Input Tokens</th>
                <th className="text-right py-2 px-3 font-medium">Output Tokens</th>
                <th className="text-right py-2 pl-3 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr key={`${m.source}:${m.model}`} className="border-b border-bg-border/50 hover:bg-bg-hover transition-colors">
                  <td className="py-2 pr-4">
                    <span className={`inline-block text-[10px] px-1.5 py-0.5 border rounded ${sourcePillClass(m.source)}`}>
                      {sourceLabel(m.source)}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-text-primary">{m.model}</td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">{formatNumber(m.sessions)}</td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">{formatNumber(m.inputTokens)}</td>
                  <td className="py-2 px-3 text-right font-mono text-text-secondary">{formatNumber(m.outputTokens)}</td>
                  <td className="py-2 pl-3 text-right font-mono text-accent-green">{formatCost(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DailyCostChart({ data }: { data: AnalyticsData }) {
  // Show last 30 days
  const days = data.dailyCosts.slice(-30);
  if (days.length === 0) {
    return (
      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
        <h3 className="text-xs font-semibold text-text-primary mb-3">Daily Cost (Last 30 Days)</h3>
        <p className="text-[10px] text-text-muted text-center py-4">No daily cost data.</p>
      </div>
    );
  }

  const maxCost = Math.max(...days.map((d) => d.costUsd), 0.01);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3">Daily Cost (Last 30 Days)</h3>
      <div className="flex items-end gap-[3px] h-32">
        {days.map((day) => {
          const heightPct = (day.costUsd / maxCost) * 100;
          const dateLabel = day.date.slice(5); // MM-DD
          return (
            <div
              key={day.date}
              className="flex flex-col items-center flex-1 min-w-0 group"
            >
              <div className="relative w-full flex justify-center mb-1" style={{ height: "100px" }}>
                <div
                  className="w-full max-w-[14px] bg-accent-green/60 hover:bg-accent-green rounded-t transition-colors self-end"
                  style={{ height: `${Math.max(heightPct, 1)}%` }}
                  title={`${day.date}: ${formatCost(day.costUsd)}`}
                />
              </div>
              {days.length <= 15 && (
                <span className="text-[8px] text-text-muted rotate-0 whitespace-nowrap">
                  {dateLabel}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {days.length > 15 && (
        <div className="flex justify-between mt-1">
          <span className="text-[8px] text-text-muted">{days[0].date}</span>
          <span className="text-[8px] text-text-muted">{days[days.length - 1].date}</span>
        </div>
      )}
    </div>
  );
}

export function CostDashboardView() {
  const data = useAnalyticsStore((s) => s.data);
  const loading = useAnalyticsStore((s) => s.loading);
  const error = useAnalyticsStore((s) => s.error);
  const load = useAnalyticsStore((s) => s.load);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [showInfo, setShowInfo] = useState(true);

  const uniqueSources = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const m of data.modelUsage) set.add(m.source);
    return Array.from(set).sort();
  }, [data]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-text-secondary gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading analytics...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-6 max-w-sm text-center">
          <AlertCircle size={20} className="text-accent-red mx-auto mb-2" />
          <p className="text-xs text-text-secondary mb-3">{error}</p>
          <button
            onClick={load}
            className="flex items-center gap-1.5 mx-auto px-3 py-1.5 text-[11px] text-accent-green hover:bg-accent-green/10 border border-accent-green/30 rounded transition-colors"
          >
            <RefreshCw size={11} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-4 gap-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <DollarSign size={14} className="text-accent-green" />
          Cost Dashboard
        </h2>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </div>

      {/* Info pill */}
      {showInfo && (
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-3 flex items-start gap-2 text-[11px] text-text-secondary">
          <Info size={12} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1">Gemini and OpenCode usage tracking isn't available — those CLIs don't expose token data.</span>
          <button onClick={() => setShowInfo(false)} className="text-text-muted hover:text-text-primary">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <SummaryCard
          label="Total Cost"
          value={formatCost(data.totalCostUsd)}
          icon={DollarSign}
          iconClass="text-accent-green"
        />
        <SummaryCard
          label="Total Sessions"
          value={formatNumber(data.totalSessions)}
          icon={Hash}
          iconClass="text-accent-amber"
        />
        <SummaryCard
          label="Input Tokens"
          value={formatNumber(data.totalInputTokens)}
          icon={ArrowDownRight}
          iconClass="text-accent-blue"
        />
        <SummaryCard
          label="Output Tokens"
          value={formatNumber(data.totalOutputTokens)}
          icon={ArrowUpRight}
          iconClass="text-accent-purple"
        />
      </div>

      {/* Daily cost chart */}
      <DailyCostChart data={data} />

      {/* Source filter */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-text-secondary">Filter by source:</label>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="bg-bg-secondary border border-bg-border rounded text-xs px-2 py-1 text-text-primary"
        >
          <option value="all">All sources</option>
          {uniqueSources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
      </div>

      {/* Model usage table */}
      <ModelUsageTable data={data} sourceFilter={sourceFilter} />
    </div>
  );
}
