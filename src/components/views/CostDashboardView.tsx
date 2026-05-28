import { useEffect, useMemo, useState } from "react";
import {
  DollarSign,
  Hash,
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  Info,
  X,
  AlertTriangle,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import type { AnalyticsData } from "@/stores/analyticsStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { aggregateConversationCost } from "@/lib/conversationCost";
import {
  computeCostGuardrailStatus,
  isUnknownPricedUsage,
  type CostGuardrailSettings,
  type CostGuardrailStatus,
} from "@/lib/costGuardrails";

const SOURCE_LABELS: Record<string, string> = {
  "claude-cli": "Claude CLI",
  codex: "Codex CLI",
  "claude-oauth": "Anthropic (Subscription)",
  "api-claude": "Claude API",
  "openai-codex": "OpenAI (ChatGPT)",
  "api-openai": "OpenAI API",
  "openai-agents": "OpenAI Agents SDK",
  "api-minimax": "MiniMax API",
  "api-openrouter": "OpenRouter",
  "api-ollama": "Ollama (local)",
};
function sourceLabel(s: string): string {
  return SOURCE_LABELS[s] ?? s;
}

const SOURCE_PILL_CLASSES: Record<string, string> = {
  "claude-cli": "text-accent-amber border-accent-amber/30",
  "claude-oauth": "text-accent-amber border-accent-amber/30",
  "api-claude": "text-accent-amber border-accent-amber/30",
  codex: "text-accent-blue border-accent-blue/30",
  "openai-codex": "text-accent-green border-accent-green/30",
  "api-openai": "text-accent-green border-accent-green/30",
  "openai-agents": "text-accent-green border-accent-green/30",
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

function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  if (n >= 100) return `${Math.round(n)}%`;
  return `${n.toFixed(0)}%`;
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  iconClass,
}: {
  label: string;
  value: string;
  icon: typeof DollarSign;
  iconClass: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="flex items-center gap-2 text-text-secondary">
        <Icon size={12} className={iconClass} />
        <span className="text-[11px]">{label}</span>
      </div>
      <span className="font-mono text-sm font-semibold text-accent-green">{value}</span>
    </div>
  );
}

function GuardrailStatusPanel({ status }: { status: CostGuardrailStatus }) {
  const active = status.activeScope;
  const level = active?.level ?? status.level;
  const tone =
    level === "limit"
      ? {
          label: "Over Budget",
          border: "border-accent-red/40",
          bg: "bg-accent-red/10",
          text: "text-accent-red",
          bar: "bg-accent-red",
        }
      : level === "warning"
        ? {
            label: "Warning",
            border: "border-accent-amber/40",
            bg: "bg-accent-amber/10",
            text: "text-accent-amber",
            bar: "bg-accent-amber",
          }
        : level === "unknown_pricing"
          ? {
              label: "Pricing Unknown",
              border: "border-accent-amber/30",
              bg: "bg-accent-amber/10",
              text: "text-accent-amber",
              bar: "bg-accent-amber",
            }
          : {
              label: "OK",
              border: "border-accent-green/30",
              bg: "bg-accent-green/10",
              text: "text-accent-green",
              bar: "bg-accent-green",
            };
  const width = active ? Math.min(100, active.percentUsed) : 0;
  const spendLabel = active
    ? `${formatCost(active.spendUsd)} / ${formatCost(active.limitUsd)}`
    : "No active cap";

  return (
    <div className={`rounded-lg border p-4 ${tone.border} ${tone.bg}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-text-secondary">
            <ShieldAlert size={12} className={tone.text} />
            <span className="text-[11px]">Daily Guardrail</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className={`text-sm font-semibold ${tone.text}`}>{tone.label}</span>
            <span className="font-mono text-xs text-text-primary">{spendLabel}</span>
          </div>
        </div>
        <span className={`font-mono text-xs ${tone.text}`}>
          {formatPercent(active?.percentUsed ?? 0)}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-primary">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 flex justify-between gap-3 text-[10px] text-text-muted">
        <span className="truncate">{status.summary}</span>
        {status.requiresApproval && <span className="text-accent-red">Approval</span>}
      </div>
    </div>
  );
}

function GuardrailSettingsPanel({
  settings,
  onChange,
  onReset,
}: {
  settings: CostGuardrailSettings;
  onChange: (patch: Partial<CostGuardrailSettings>) => void;
  onReset: () => void;
}) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <SlidersHorizontal size={12} className="text-accent-blue" />
          Guardrail Settings
        </h3>
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={settings.dailyLimitUsd !== null}
            onChange={(e) => onChange({ dailyLimitUsd: e.currentTarget.checked ? 25 : null })}
            className="h-3 w-3 accent-accent-green"
          />
          On
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-[10px] text-text-muted">
          Daily cap
          <input
            type="number"
            min={0}
            step={1}
            value={settings.dailyLimitUsd ?? ""}
            onChange={(e) =>
              onChange({
                dailyLimitUsd: e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
              })
            }
            className="rounded border border-bg-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] text-text-muted">
          Month cap
          <input
            type="number"
            min={0}
            step={5}
            value={settings.monthlyLimitUsd ?? ""}
            onChange={(e) =>
              onChange({
                monthlyLimitUsd:
                  e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
              })
            }
            className="rounded border border-bg-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] text-text-muted">
          Session cap
          <input
            type="number"
            min={0}
            step={1}
            value={settings.sessionLimitUsd ?? ""}
            onChange={(e) =>
              onChange({
                sessionLimitUsd:
                  e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
              })
            }
            className="rounded border border-bg-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] text-text-muted">
          Warn at %
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={settings.warningThresholdPercent}
            onChange={(e) => onChange({ warningThresholdPercent: Number(e.currentTarget.value) })}
            className="rounded border border-bg-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] text-text-muted">
          Limit at %
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={settings.hardStopThresholdPercent}
            onChange={(e) => onChange({ hardStopThresholdPercent: Number(e.currentTarget.value) })}
            className="rounded border border-bg-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="mt-3 flex items-center gap-1.5 text-[10px] text-text-muted transition-colors hover:text-text-primary"
      >
        <RefreshCw size={10} />
        Reset
      </button>
    </div>
  );
}

function ScopedLimitsPanel({
  sources,
  missions,
  settings,
  onChange,
}: {
  sources: string[];
  missions: Array<{ id: string; title: string; totalCost: number; status: string }>;
  settings: CostGuardrailSettings;
  onChange: (patch: Partial<CostGuardrailSettings>) => void;
}) {
  const visibleSources = sources.slice(0, 6);
  const visibleMissions = missions.filter((mission) => mission.status !== "cancelled").slice(0, 6);

  const setProviderLimit = (source: string, raw: string) => {
    const providerLimitsUsd = { ...settings.providerLimitsUsd };
    if (raw === "") delete providerLimitsUsd[source];
    else providerLimitsUsd[source] = Number(raw);
    onChange({ providerLimitsUsd });
  };

  const setMissionLimit = (missionId: string, raw: string) => {
    const missionLimitsUsd = { ...settings.missionLimitsUsd };
    if (raw === "") delete missionLimitsUsd[missionId];
    else missionLimitsUsd[missionId] = Number(raw);
    onChange({ missionLimitsUsd });
  };

  if (visibleSources.length === 0 && visibleMissions.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
        <h3 className="mb-2 text-xs font-semibold text-text-primary">Provider Caps</h3>
        <div className="space-y-1.5">
          {visibleSources.length === 0 ? (
            <p className="text-[10px] text-text-muted">No provider usage yet.</p>
          ) : (
            visibleSources.map((source) => (
              <LimitRow
                key={source}
                label={sourceLabel(source)}
                value={settings.providerLimitsUsd[source] ?? null}
                onChange={(raw) => setProviderLimit(source, raw)}
              />
            ))
          )}
        </div>
      </div>
      <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
        <h3 className="mb-2 text-xs font-semibold text-text-primary">Mission Caps</h3>
        <div className="space-y-1.5">
          {visibleMissions.length === 0 ? (
            <p className="text-[10px] text-text-muted">No missions to cap yet.</p>
          ) : (
            visibleMissions.map((mission) => (
              <LimitRow
                key={mission.id}
                label={mission.title || mission.id}
                sublabel={formatCost(mission.totalCost)}
                value={settings.missionLimitsUsd[mission.id] ?? null}
                onChange={(raw) => setMissionLimit(mission.id, raw)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function LimitRow({
  label,
  sublabel,
  value,
  onChange,
}: {
  label: string;
  sublabel?: string;
  value: number | null;
  onChange: (raw: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[10px] text-text-muted">
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
        {sublabel && <span className="ml-1 text-text-faint">{sublabel}</span>}
      </span>
      <input
        type="number"
        min={0}
        step={1}
        value={value ?? ""}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="$ cap"
        className="w-20 rounded border border-bg-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-primary"
      />
    </label>
  );
}

function UnknownPricingNotice({ models }: { models: string[] }) {
  if (models.length === 0) return null;
  const shown = models.slice(0, 4);
  const hidden = models.length - shown.length;

  return (
    <div className="bg-accent-amber/10 border-accent-amber/30 flex items-start gap-2 rounded-lg border p-3 text-[11px]">
      <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-accent-amber" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-accent-amber">Unknown-priced model</div>
        <div className="mt-1 text-text-secondary">
          {shown.map((m) => (
            <span
              key={m}
              className="border-accent-amber/20 mr-2 inline-flex max-w-full rounded border px-1.5 py-0.5 font-mono text-[10px] text-text-primary"
            >
              {m}
            </span>
          ))}
          {hidden > 0 && <span className="text-text-muted">+{hidden} more</span>}
        </div>
      </div>
    </div>
  );
}

function ModelUsageTable({ data, sourceFilter }: { data: AnalyticsData; sourceFilter: string }) {
  const sorted = [...data.modelUsage]
    .filter((m) => sourceFilter === "all" || m.source === sourceFilter)
    .sort((a, b) => b.costUsd - a.costUsd);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <h3 className="mb-3 text-xs font-semibold text-text-primary">Model Usage</h3>
      {sorted.length === 0 ? (
        <p className="py-4 text-center text-[10px] text-text-muted">No model usage data.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-bg-border text-text-secondary">
                <th className="py-2 pr-4 text-left font-medium">Source</th>
                <th className="py-2 pr-4 text-left font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">Sessions</th>
                <th className="px-3 py-2 text-right font-medium">Input Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Output Tokens</th>
                <th className="py-2 pl-3 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={`${m.source}:${m.model}`}
                  className="border-bg-border/50 border-b transition-colors hover:bg-bg-hover"
                >
                  <td className="py-2 pr-4">
                    <span
                      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${sourcePillClass(m.source)}`}
                    >
                      {sourceLabel(m.source)}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-text-primary">{m.model}</td>
                  <td className="px-3 py-2 text-right font-mono text-text-secondary">
                    {formatNumber(m.sessions)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-secondary">
                    {formatNumber(m.inputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-secondary">
                    {formatNumber(m.outputTokens)}
                  </td>
                  <td className="py-2 pl-3 text-right font-mono text-accent-green">
                    {formatCost(m.costUsd)}
                  </td>
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
      <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
        <h3 className="mb-3 text-xs font-semibold text-text-primary">Daily Cost (Last 30 Days)</h3>
        <p className="py-4 text-center text-[10px] text-text-muted">No daily cost data.</p>
      </div>
    );
  }

  const maxCost = Math.max(...days.map((d) => d.costUsd), 0.01);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <h3 className="mb-3 text-xs font-semibold text-text-primary">Daily Cost (Last 30 Days)</h3>
      <div className="flex h-32 items-end gap-[3px]">
        {days.map((day) => {
          const heightPct = (day.costUsd / maxCost) * 100;
          const dateLabel = day.date.slice(5); // MM-DD
          return (
            <div key={day.date} className="group flex min-w-0 flex-1 flex-col items-center">
              <div className="relative mb-1 flex w-full justify-center" style={{ height: "100px" }}>
                <div
                  className="bg-accent-green/60 w-full max-w-[14px] self-end rounded-t transition-colors hover:bg-accent-green"
                  style={{ height: `${Math.max(heightPct, 1)}%` }}
                  title={`${day.date}: ${formatCost(day.costUsd)}`}
                />
              </div>
              {days.length <= 15 && (
                <span className="rotate-0 whitespace-nowrap text-[8px] text-text-muted">
                  {dateLabel}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {days.length > 15 && (
        <div className="mt-1 flex justify-between">
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
  const guardrailSettings = useAnalyticsStore((s) => s.guardrailSettings);
  const updateGuardrailSettings = useAnalyticsStore((s) => s.updateGuardrailSettings);
  const resetGuardrailSettings = useAnalyticsStore((s) => s.resetGuardrailSettings);
  const conversations = useAgentTaskStore((s) => s.conversations);
  const flights = useFlightStore((s) => s.flights);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [showInfo, setShowInfo] = useState(true);

  const uniqueSources = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const m of data.modelUsage) set.add(m.source);
    return Array.from(set).sort();
  }, [data]);

  const todayPersisted = useMemo(() => {
    if (!data) return 0;
    const today = new Date().toISOString().slice(0, 10);
    return data.dailyCosts.find((d) => d.date === today)?.costUsd ?? 0;
  }, [data]);

  const liveSummary = useMemo(() => {
    let costUsd = 0;
    const unknownModels = new Set<string>();

    for (const conversation of conversations) {
      if (conversation.mode !== "api") continue;
      const { totalTokens, estCost } = aggregateConversationCost(conversation);
      if (estCost && estCost > 0) {
        costUsd += estCost;
      } else if (estCost === null && totalTokens > 0) {
        unknownModels.add(conversation.model ?? "unknown");
      }
    }

    return { costUsd, unknownModels: [...unknownModels].sort() };
  }, [conversations]);

  const guardrailStatus = useMemo(
    () =>
      computeCostGuardrailStatus(
        data ? { ...data, todayCostUsd: todayPersisted + liveSummary.costUsd } : null,
        guardrailSettings,
        {
          currentSessionCostUsd: liveSummary.costUsd,
          missionCostsById: Object.fromEntries(
            flights.map((flight) => [flight.id, flight.totalCost]),
          ),
        },
      ),
    [data, flights, guardrailSettings, liveSummary.costUsd, todayPersisted],
  );

  const unknownPricedModels = useMemo(() => {
    const models = new Set<string>();
    for (const model of liveSummary.unknownModels) {
      models.add(`live:${model}`);
    }

    if (data) {
      for (const usage of data.modelUsage) {
        if (isUnknownPricedUsage(usage)) {
          models.add(`${sourceLabel(usage.source)}:${usage.model}`);
        }
      }
    }

    return [...models].sort();
  }, [data, liveSummary.unknownModels]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-secondary">
        <Loader2 size={14} className="animate-spin" />
        Loading analytics...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-sm rounded-lg border border-bg-border bg-bg-secondary p-6 text-center">
          <AlertCircle size={20} className="mx-auto mb-2 text-accent-red" />
          <p className="mb-3 text-xs text-text-secondary">{error}</p>
          <button
            onClick={load}
            className="hover:bg-accent-green/10 border-accent-green/30 mx-auto flex items-center gap-1.5 rounded border px-3 py-1.5 text-[11px] text-accent-green transition-colors"
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
    <div className="mx-auto flex max-w-4xl flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <DollarSign size={14} className="text-accent-green" />
          Cost Dashboard
        </h2>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </div>

      {/* Info pill */}
      {showInfo && (
        <div className="flex items-start gap-2 rounded-lg border border-bg-border bg-bg-secondary p-3 text-[11px] text-text-secondary">
          <Info size={12} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1">
            Gemini and OpenCode usage tracking isn't available — those CLIs don't expose token data.
          </span>
          <button
            onClick={() => setShowInfo(false)}
            className="text-text-muted hover:text-text-primary"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1fr]">
        <GuardrailStatusPanel status={guardrailStatus} />
        <GuardrailSettingsPanel
          settings={guardrailSettings}
          onChange={updateGuardrailSettings}
          onReset={resetGuardrailSettings}
        />
      </div>

      <ScopedLimitsPanel
        sources={uniqueSources}
        missions={flights}
        settings={guardrailSettings}
        onChange={updateGuardrailSettings}
      />

      <UnknownPricingNotice models={unknownPricedModels} />

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
          className="rounded border border-bg-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
        >
          <option value="all">All sources</option>
          {uniqueSources.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {/* Model usage table */}
      <ModelUsageTable data={data} sourceFilter={sourceFilter} />
    </div>
  );
}
