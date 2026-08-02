import { Archive, Route, Sparkles } from "lucide-react";
import {
  DEFAULT_AGENT_AUTO_ARCHIVE_DAYS,
  useAgentSettingsStore,
  type AgentComposerMode,
} from "@/stores/agentSettingsStore";
import { CardHeader } from "./CardHeader";

const COMPOSER_OPTIONS: Array<{
  mode: AgentComposerMode;
  label: string;
  title: string;
}> = [
  {
    mode: "local",
    label: "Project",
    title: "Start new conversations in the selected project path",
  },
  {
    mode: "worktree",
    label: "Worktree",
    title: "Start new conversations in a fresh project worktree",
  },
];

export function AgentSettingsCard() {
  const composerMode = useAgentSettingsStore((s) => s.composerMode);
  const onboardingDismissed = useAgentSettingsStore((s) => s.onboardingDismissed);
  const autoArchiveDays = useAgentSettingsStore((s) => s.autoArchiveDays);
  const autoFailoverEnabled = useAgentSettingsStore((s) => s.autoFailoverEnabled);

  const setComposerMode = useAgentSettingsStore((s) => s.setComposerMode);
  const dismissOnboarding = useAgentSettingsStore((s) => s.dismissOnboarding);
  const showOnboarding = useAgentSettingsStore((s) => s.showOnboarding);
  const setAutoArchiveDays = useAgentSettingsStore((s) => s.setAutoArchiveDays);
  const setAutoFailoverEnabled = useAgentSettingsStore((s) => s.setAutoFailoverEnabled);

  const archiveEnabled = autoArchiveDays !== null;
  const archiveDaysValue = autoArchiveDays ?? DEFAULT_AGENT_AUTO_ARCHIVE_DAYS;

  function handleArchiveToggle(enabled: boolean) {
    setAutoArchiveDays(enabled ? DEFAULT_AGENT_AUTO_ARCHIVE_DAYS : null);
  }

  function handleArchiveDaysChange(value: string) {
    const days = Number(value);
    if (!Number.isFinite(days)) return;
    setAutoArchiveDays(days);
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <CardHeader icon={Sparkles} iconColor="text-accent-purple" title="Agents" />

      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
            Default launch location
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-bg-border">
            {COMPOSER_OPTIONS.map((option) => {
              const isActive = composerMode === option.mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => setComposerMode(option.mode)}
                  title={option.title}
                  className={`px-2.5 py-1 text-[11px] transition-colors ${
                    isActive
                      ? "bg-accent-purple/15 text-accent-purple"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-text-muted">
            Used as the default for new conversations. Overrideable via the chip in any
            conversation&apos;s input bar (which also updates this default).
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Onboarding</div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-secondary">
              {onboardingDismissed ? "Hidden after dismissal" : "Ready to show"}
            </span>
            <button
              type="button"
              onClick={onboardingDismissed ? showOnboarding : dismissOnboarding}
              className="hover:border-accent-purple/50 rounded border border-bg-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:text-accent-purple"
            >
              {onboardingDismissed ? "Show again" : "Mark complete"}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Cleanup</div>
          <Toggle
            icon={Archive}
            label="Auto-archive done conversations"
            checked={archiveEnabled}
            onChange={handleArchiveToggle}
          />
          <label
            className={`flex items-center justify-between gap-3 ${
              archiveEnabled ? "text-text-secondary" : "text-text-faint"
            }`}
          >
            <span className="text-[11px]">After</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={365}
                step={1}
                disabled={!archiveEnabled}
                value={archiveDaysValue}
                onChange={(e) => handleArchiveDaysChange(e.target.value)}
                className="w-20 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none disabled:text-text-faint disabled:opacity-60"
              />
              <span className="text-[11px]">days</span>
            </div>
          </label>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Runtime</div>
          <Toggle
            icon={Route}
            label="Auto-failover on quota or overload"
            checked={autoFailoverEnabled}
            onChange={setAutoFailoverEnabled}
          />
          <p className="text-[10px] leading-snug text-text-muted">
            Retries API conversations on a same-provider fallback model after a rate-limit, quota,
            or overload error.
          </p>
        </div>
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
