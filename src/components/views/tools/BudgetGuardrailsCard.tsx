import { ShieldAlert, RefreshCw } from "lucide-react";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import type { CostGuardrailSettings } from "@/lib/costGuardrails";

/**
 * Budget guardrails — the CONTROL surface for cost.
 *
 * The Cost Dashboard (a reporting surface) was removed on 2026-07-31, but the
 * guardrails it happened to host are a safety mechanism: they hard-stop
 * runaway agents before a launch and fire threshold notifications while work
 * runs (`assertCostGuardrailsAllowLaunch`, `analyticsStore.load`). The caps
 * therefore live here, in Settings → Flights & Autonomy, next to the bounded
 * autonomy policy they complement.
 *
 * Deliberately shows NO spend figures — no charts, tables, or running totals.
 * This card only edits the thresholds; the numbers they are compared against
 * stay in the backend (`read_usage_analytics`) and flight cost rollup.
 */

const HELP =
  "Caps are evaluated before an agent or flight launches, and again on the " +
  "background poll while work runs. Leave a field blank to disable that cap.";

function CapField({
  label,
  hint,
  value,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  step: number;
  onChange: (next: number | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[9px] uppercase tracking-wide text-text-muted">
      {label}
      <input
        type="number"
        min={0}
        step={step}
        value={value ?? ""}
        placeholder="off"
        onChange={(e) => onChange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
        className="w-full rounded border border-bg-border bg-bg-primary px-1.5 py-1 font-mono text-[10px] text-text-primary outline-none"
      />
      <span className="normal-case tracking-normal text-[9px] text-text-faint">{hint}</span>
    </label>
  );
}

function PercentField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[9px] uppercase tracking-wide text-text-muted">
      {label}
      <input
        type="number"
        min={1}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded border border-bg-border bg-bg-primary px-1.5 py-1 font-mono text-[10px] text-text-primary outline-none"
      />
      <span className="normal-case tracking-normal text-[9px] text-text-faint">{hint}</span>
    </label>
  );
}

export function BudgetGuardrailsCard() {
  const settings = useAnalyticsStore((s) => s.guardrailSettings);
  const update = useAnalyticsStore((s) => s.updateGuardrailSettings);
  const reset = useAnalyticsStore((s) => s.resetGuardrailSettings);

  const patch = (p: Partial<CostGuardrailSettings>) => update(p);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <ShieldAlert size={12} className="text-accent-amber" />
        <h3 className="text-xs font-semibold text-text-primary">Budget guardrails</h3>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-text-muted">{HELP}</p>

      <div className="grid grid-cols-3 gap-2">
        <CapField
          label="Daily cap $"
          hint="All providers, today"
          value={settings.dailyLimitUsd}
          step={1}
          onChange={(dailyLimitUsd) => patch({ dailyLimitUsd })}
        />
        <CapField
          label="Monthly cap $"
          hint="All providers, this month"
          value={settings.monthlyLimitUsd}
          step={5}
          onChange={(monthlyLimitUsd) => patch({ monthlyLimitUsd })}
        />
        <CapField
          label="Session cap $"
          hint="One conversation"
          value={settings.sessionLimitUsd}
          step={1}
          onChange={(sessionLimitUsd) => patch({ sessionLimitUsd })}
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <PercentField
          label="Warn at %"
          hint="Notify at this share of a cap"
          value={settings.warningThresholdPercent}
          onChange={(warningThresholdPercent) => patch({ warningThresholdPercent })}
        />
        <PercentField
          label="Hard stop at %"
          hint="Block launches at this share"
          value={settings.hardStopThresholdPercent}
          onChange={(hardStopThresholdPercent) => patch({ hardStopThresholdPercent })}
        />
      </div>

      <button
        type="button"
        onClick={reset}
        className="mt-3 flex items-center gap-1.5 text-[10px] text-text-muted transition-colors hover:text-text-primary"
      >
        <RefreshCw size={10} />
        Reset to defaults
      </button>
    </div>
  );
}
