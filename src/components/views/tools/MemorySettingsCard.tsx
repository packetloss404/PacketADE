import {
  Brain,
  Clock,
  Database,
  GitBranch,
  ListChecks,
  Pin,
  RotateCcw,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  DEFAULT_MEMORY_MAX_EVENTS,
  DEFAULT_MEMORY_MAX_PATTERNS,
  DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD,
  DEFAULT_MEMORY_RETENTION_DAYS,
  type MemoryProjectPathMatching,
  useMemorySettingsStore,
} from "@/stores/memorySettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";

export function MemorySettingsCard() {
  const events = useMemoryStore((s) => s.events);
  const patterns = useMemoryStore((s) => s.patterns);
  const applyRetentionPolicy = useMemoryStore((s) => s.applyRetentionPolicy);

  const captureSessions = useMemorySettingsStore((s) => s.captureSessions);
  const captureTasks = useMemorySettingsStore((s) => s.captureTasks);
  const captureFlights = useMemorySettingsStore((s) => s.captureFlights);
  const summarizeSessions = useMemorySettingsStore((s) => s.summarizeSessions);
  const extractPatterns = useMemorySettingsStore((s) => s.extractPatterns);
  const retentionDays = useMemorySettingsStore((s) => s.retentionDays);
  const maxEvents = useMemorySettingsStore((s) => s.maxEvents);
  const maxPatterns = useMemorySettingsStore((s) => s.maxPatterns);
  const patternRefreshThreshold = useMemorySettingsStore((s) => s.patternRefreshThreshold);
  const contextMaxPatterns = useMemorySettingsStore((s) => s.contextMaxPatterns);
  const contextMaxSessions = useMemorySettingsStore((s) => s.contextMaxSessions);
  const contextMaxLessons = useMemorySettingsStore((s) => s.contextMaxLessons);
  const projectPathMatching = useMemorySettingsStore((s) => s.projectPathMatching);
  const pinnedExemptFromCap = useMemorySettingsStore((s) => s.pinnedExemptFromCap);

  const setCaptureSessions = useMemorySettingsStore((s) => s.setCaptureSessions);
  const setCaptureTasks = useMemorySettingsStore((s) => s.setCaptureTasks);
  const setCaptureFlights = useMemorySettingsStore((s) => s.setCaptureFlights);
  const setSummarizeSessions = useMemorySettingsStore((s) => s.setSummarizeSessions);
  const setExtractPatterns = useMemorySettingsStore((s) => s.setExtractPatterns);
  const setRetentionDays = useMemorySettingsStore((s) => s.setRetentionDays);
  const setMaxEvents = useMemorySettingsStore((s) => s.setMaxEvents);
  const setMaxPatterns = useMemorySettingsStore((s) => s.setMaxPatterns);
  const setPatternRefreshThreshold = useMemorySettingsStore((s) => s.setPatternRefreshThreshold);
  const setContextMaxPatterns = useMemorySettingsStore((s) => s.setContextMaxPatterns);
  const setContextMaxSessions = useMemorySettingsStore((s) => s.setContextMaxSessions);
  const setContextMaxLessons = useMemorySettingsStore((s) => s.setContextMaxLessons);
  const setProjectPathMatching = useMemorySettingsStore((s) => s.setProjectPathMatching);
  const setPinnedExemptFromCap = useMemorySettingsStore((s) => s.setPinnedExemptFromCap);
  const resetMemorySettings = useMemorySettingsStore((s) => s.resetMemorySettings);

  const retentionEnabled = retentionDays !== null;
  const retentionValue = retentionDays ?? DEFAULT_MEMORY_RETENTION_DAYS;
  const briefSourceCap = contextMaxPatterns + contextMaxSessions + contextMaxLessons;

  function updateAndPrune(action: () => void) {
    action();
    queueMicrotask(applyRetentionPolicy);
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Brain size={12} className="text-accent-green" />
          Memory
        </h3>
        <button
          type="button"
          onClick={resetMemorySettings}
          className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Reset memory settings"
        >
          <RotateCcw size={11} />
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Events" value={events.length} />
          <Stat label="Patterns" value={patterns.length} />
          <Stat label="Brief cap" value={briefSourceCap} />
        </div>

        <Section title="Capture">
          <Toggle
            icon={Terminal}
            label="Capture terminal sessions"
            checked={captureSessions}
            onChange={setCaptureSessions}
          />
          <Toggle
            icon={ListChecks}
            label="Capture flight tasks"
            checked={captureTasks}
            onChange={setCaptureTasks}
          />
          <Toggle
            icon={GitBranch}
            label="Capture completed flights"
            checked={captureFlights}
            onChange={setCaptureFlights}
          />
        </Section>

        <Section title="Learning">
          <Toggle
            icon={Brain}
            label="Summarize sessions on completion"
            checked={summarizeSessions}
            onChange={setSummarizeSessions}
          />
          <Toggle
            icon={Sparkles}
            label="Auto-extract learned patterns"
            checked={extractPatterns}
            onChange={setExtractPatterns}
          />
          <NumberRow
            label="Refresh after summaries"
            value={patternRefreshThreshold}
            min={1}
            max={20}
            disabled={!extractPatterns}
            onChange={setPatternRefreshThreshold}
          />
        </Section>

        <Section title="Retention">
          <Toggle
            icon={Clock}
            label="Expire events by age"
            checked={retentionEnabled}
            onChange={(enabled) =>
              updateAndPrune(() => setRetentionDays(enabled ? DEFAULT_MEMORY_RETENTION_DAYS : null))
            }
          />
          <NumberRow
            label="Keep days"
            value={retentionValue}
            min={1}
            max={3650}
            disabled={!retentionEnabled}
            onChange={(value) => updateAndPrune(() => setRetentionDays(value))}
          />
          <NumberRow
            label="Max stored events"
            value={maxEvents}
            min={20}
            max={2000}
            onChange={(value) => updateAndPrune(() => setMaxEvents(value))}
          />
          <NumberRow
            label="Max learned patterns"
            value={maxPatterns}
            min={1}
            max={100}
            onChange={(value) => updateAndPrune(() => setMaxPatterns(value))}
          />
        </Section>

        <Section title="Memory brief budget">
          <div className="rounded border border-bg-border bg-bg-primary px-2.5 py-2 text-[10px] leading-relaxed text-text-muted">
            Agent sessions receive a compact brief assembled from capped sources, never an unbounded
            raw memory dump.
          </div>
          <NumberRow
            label="Patterns"
            value={contextMaxPatterns}
            min={0}
            max={50}
            onChange={setContextMaxPatterns}
          />
          <NumberRow
            label="Recent sessions"
            value={contextMaxSessions}
            min={0}
            max={50}
            onChange={setContextMaxSessions}
          />
          <NumberRow
            label="Flight lessons"
            value={contextMaxLessons}
            min={0}
            max={50}
            onChange={setContextMaxLessons}
          />
        </Section>

        <Section title="Project scope">
          <ProjectPathMatchingRadio value={projectPathMatching} onChange={setProjectPathMatching} />
          <Toggle
            icon={Pin}
            label="Pinned patterns survive cap eviction"
            checked={pinnedExemptFromCap}
            onChange={setPinnedExemptFromCap}
          />
        </Section>

        <div className="flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-muted">
          <Database size={11} className="flex-shrink-0 text-accent-blue" />
          <span>
            Defaults are {DEFAULT_MEMORY_MAX_EVENTS} events, {DEFAULT_MEMORY_MAX_PATTERNS} patterns,
            and pattern refresh every {DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD} summaries. Brief
            injection uses the source caps above.
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-bg-border bg-bg-primary px-3 py-2">
      <div className="text-[10px] text-text-muted">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-text-primary">{value}</div>
    </div>
  );
}

function Toggle({
  icon: Icon,
  label,
  checked,
  onChange,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="group flex cursor-pointer items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-[11px] text-text-secondary transition-colors group-hover:text-text-primary">
        <Icon size={11} className="text-text-muted" />
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 rounded-full transition-colors ${
          checked ? "bg-accent-green" : "bg-bg-elevated"
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

interface MatchingOption {
  value: MemoryProjectPathMatching;
  label: string;
  description: string;
}

const MATCHING_OPTIONS: MatchingOption[] = [
  {
    value: "exact",
    label: "Exact",
    description: "Only memory recorded on this exact project path applies.",
  },
  {
    value: "parent",
    label: "Parent directory",
    description: "Inherit memory from a parent project (works for sub-workspaces).",
  },
  {
    value: "global",
    label: "Global",
    description: "Project-scoped memory becomes available everywhere.",
  },
];

function ProjectPathMatchingRadio({
  value,
  onChange,
}: {
  value: MemoryProjectPathMatching;
  onChange: (mode: MemoryProjectPathMatching) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-[11px] text-text-secondary">Match memory by project path</legend>
      {MATCHING_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 transition-colors ${
              selected
                ? "border-accent-green/40 bg-accent-green/5"
                : "hover:border-text-muted/30 border-bg-border"
            }`}
          >
            <input
              type="radio"
              name="memory-project-path-matching"
              value={opt.value}
              checked={selected}
              onChange={() => onChange(opt.value)}
              className="mt-0.5 accent-accent-green"
            />
            <div className="min-w-0">
              <div
                className={`text-[11px] ${selected ? "text-accent-green" : "text-text-secondary"}`}
              >
                {opt.label}
              </div>
              <div className="text-[10px] leading-snug text-text-muted">{opt.description}</div>
            </div>
          </label>
        );
      })}
    </fieldset>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 ${
        disabled ? "text-text-faint" : "text-text-secondary"
      }`}
    >
      <span className="text-[11px]">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none disabled:text-text-faint disabled:opacity-60"
      />
    </label>
  );
}
