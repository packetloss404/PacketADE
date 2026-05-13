import {
  Brain,
  Clock,
  Database,
  GitBranch,
  ListChecks,
  RotateCcw,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  DEFAULT_MEMORY_MAX_EVENTS,
  DEFAULT_MEMORY_MAX_PATTERNS,
  DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD,
  DEFAULT_MEMORY_RETENTION_DAYS,
  useMemorySettingsStore,
} from "@/stores/memorySettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";

export function MemorySettingsCard() {
  const events = useMemoryStore((s) => s.events);
  const patterns = useMemoryStore((s) => s.patterns);
  const applyRetentionPolicy = useMemoryStore((s) => s.applyRetentionPolicy);

  const captureSessions = useMemorySettingsStore((s) => s.captureSessions);
  const captureTasks = useMemorySettingsStore((s) => s.captureTasks);
  const captureMissions = useMemorySettingsStore((s) => s.captureMissions);
  const summarizeSessions = useMemorySettingsStore((s) => s.summarizeSessions);
  const extractPatterns = useMemorySettingsStore((s) => s.extractPatterns);
  const retentionDays = useMemorySettingsStore((s) => s.retentionDays);
  const maxEvents = useMemorySettingsStore((s) => s.maxEvents);
  const maxPatterns = useMemorySettingsStore((s) => s.maxPatterns);
  const patternRefreshThreshold = useMemorySettingsStore(
    (s) => s.patternRefreshThreshold,
  );
  const contextMaxPatterns = useMemorySettingsStore((s) => s.contextMaxPatterns);
  const contextMaxSessions = useMemorySettingsStore((s) => s.contextMaxSessions);
  const contextMaxLessons = useMemorySettingsStore((s) => s.contextMaxLessons);

  const setCaptureSessions = useMemorySettingsStore((s) => s.setCaptureSessions);
  const setCaptureTasks = useMemorySettingsStore((s) => s.setCaptureTasks);
  const setCaptureMissions = useMemorySettingsStore((s) => s.setCaptureMissions);
  const setSummarizeSessions = useMemorySettingsStore((s) => s.setSummarizeSessions);
  const setExtractPatterns = useMemorySettingsStore((s) => s.setExtractPatterns);
  const setRetentionDays = useMemorySettingsStore((s) => s.setRetentionDays);
  const setMaxEvents = useMemorySettingsStore((s) => s.setMaxEvents);
  const setMaxPatterns = useMemorySettingsStore((s) => s.setMaxPatterns);
  const setPatternRefreshThreshold = useMemorySettingsStore(
    (s) => s.setPatternRefreshThreshold,
  );
  const setContextMaxPatterns = useMemorySettingsStore(
    (s) => s.setContextMaxPatterns,
  );
  const setContextMaxSessions = useMemorySettingsStore(
    (s) => s.setContextMaxSessions,
  );
  const setContextMaxLessons = useMemorySettingsStore(
    (s) => s.setContextMaxLessons,
  );
  const resetMemorySettings = useMemorySettingsStore((s) => s.resetMemorySettings);

  const retentionEnabled = retentionDays !== null;
  const retentionValue = retentionDays ?? DEFAULT_MEMORY_RETENTION_DAYS;

  function updateAndPrune(action: () => void) {
    action();
    queueMicrotask(applyRetentionPolicy);
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <Brain size={12} className="text-accent-green" />
          Memory
        </h3>
        <button
          type="button"
          onClick={resetMemorySettings}
          className="p-1 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          title="Reset memory settings"
        >
          <RotateCcw size={11} />
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Events" value={events.length} />
          <Stat label="Patterns" value={patterns.length} />
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
            label="Capture mission tasks"
            checked={captureTasks}
            onChange={setCaptureTasks}
          />
          <Toggle
            icon={GitBranch}
            label="Capture completed missions"
            checked={captureMissions}
            onChange={setCaptureMissions}
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
              updateAndPrune(() =>
                setRetentionDays(enabled ? DEFAULT_MEMORY_RETENTION_DAYS : null),
              )
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

        <Section title="Context budget">
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
            label="Mission lessons"
            value={contextMaxLessons}
            min={0}
            max={50}
            onChange={setContextMaxLessons}
          />
        </Section>

        <div className="flex items-center gap-2 text-[10px] text-text-muted bg-bg-primary border border-bg-border rounded px-3 py-2">
          <Database size={11} className="text-accent-blue flex-shrink-0" />
          <span>
            Defaults are {DEFAULT_MEMORY_MAX_EVENTS} events,{" "}
            {DEFAULT_MEMORY_MAX_PATTERNS} patterns, and pattern refresh every{" "}
            {DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD} summaries.
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-text-muted uppercase tracking-wider">
        {title}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg-primary border border-bg-border rounded px-3 py-2">
      <div className="text-[10px] text-text-muted">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-text-primary">
        {value}
      </div>
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
    <label className="flex items-center justify-between gap-3 cursor-pointer group">
      <span className="flex items-center gap-2 text-[11px] text-text-secondary group-hover:text-text-primary transition-colors">
        <Icon size={11} className="text-text-muted" />
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-7 h-4 rounded-full transition-colors ${
          checked ? "bg-accent-green" : "bg-bg-elevated"
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
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
        className="w-20 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary disabled:text-text-faint disabled:opacity-60 focus:outline-none focus:border-accent-green"
      />
    </label>
  );
}
