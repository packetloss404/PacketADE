import { create } from "zustand";
import { storageKey } from "@/lib/brand";

export type AgentComposerMode = "local" | "worktree";

/** Global transcript render density (P1-17). Replaces the old
 * per-conversation `AgentConversation.transcriptVerbosity` select — one
 * enum for the whole app, keyboard-cycled and surfaced in the chat header's
 * overflow menu. */
export type TranscriptViewMode = "summary" | "normal" | "verbose";

/**
 * Tile program (P4-S3): the worktree cleanup-on-archive policy (ruled Bravo).
 * - `never` — archiving never removes a worktree; every unlanded tree is Kept
 *   with the "worktree pending" chip.
 * - `only-when-safe` [default] — remove a worktree only when the ruled
 *   safe-cleanup predicate (`worktreeLifecycle.isWorktreeSafeToCleanup`) proves
 *   it safe (clean AND ancestry/PR-merged or zero commits ahead). Anything not
 *   provably safe is conservatively Kept.
 * - `always` — remove a CLEAN worktree unconditionally; a DIRTY tree is still
 *   never removed (no non-Discard path removes uncommitted work — Phase 2 gate).
 *
 * Auto-archive (the hourly sweep) ALWAYS Keeps regardless of this setting — it
 * structurally cannot prompt, so it can never clean.
 */
export type WorktreeCleanupPolicy = "never" | "only-when-safe" | "always";

export const DEFAULT_WORKTREE_CLEANUP_POLICY: WorktreeCleanupPolicy =
  "only-when-safe";

function isWorktreeCleanupPolicy(value: unknown): value is WorktreeCleanupPolicy {
  return value === "never" || value === "only-when-safe" || value === "always";
}

const TRANSCRIPT_VIEW_MODE_CYCLE: TranscriptViewMode[] = [
  "summary",
  "normal",
  "verbose",
];

export const DEFAULT_AGENT_AUTO_ARCHIVE_DAYS = 14;

interface AgentSettingsValues {
  composerMode: AgentComposerMode;
  railCollapsed: boolean;
  onboardingDismissed: boolean;
  autoArchiveDays: number | null;
  autoFailoverEnabled: boolean;
  /** Project-level default for which MCP servers new agent sessions start
   * with. `null` = every non-disabled server (mirrors the old header
   * popover's undefined-filter semantics). Explicit per-conversation values
   * (profiles, /new inheritance) always override this. */
  defaultEnabledMcpServerIds: string[] | null;
  /** Global transcript render density. Default = "normal". */
  transcriptViewMode: TranscriptViewMode;
  /** Tile program (P4-S3): worktree cleanup-on-archive policy. Default =
   * "only-when-safe". */
  worktreeCleanupPolicy: WorktreeCleanupPolicy;
}

interface AgentSettingsState extends AgentSettingsValues {
  setComposerMode: (mode: AgentComposerMode) => void;
  setRailCollapsed: (collapsed: boolean) => void;
  setOnboardingDismissed: (dismissed: boolean) => void;
  dismissOnboarding: () => void;
  showOnboarding: () => void;
  setAutoArchiveDays: (days: number | null) => void;
  setAutoFailoverEnabled: (enabled: boolean) => void;
  setDefaultEnabledMcpServerIds: (ids: string[] | null) => void;
  setTranscriptViewMode: (mode: TranscriptViewMode) => void;
  cycleTranscriptViewMode: () => void;
  setWorktreeCleanupPolicy: (policy: WorktreeCleanupPolicy) => void;
  hydrateFromStorage: () => void;
}

type PersistedAgentSettings = Partial<AgentSettingsValues>;

const STORAGE_KEY = storageKey("agent-settings");
const LEGACY_COMPOSER_MODE_KEY = storageKey("composer-mode");
const LEGACY_RAIL_COLLAPSED_KEY = storageKey("agent-tabbed-rail-collapsed");
const LEGACY_ONBOARDING_DISMISSED_KEY = storageKey("agents-onboarding-dismissed");

function isComposerMode(value: unknown): value is AgentComposerMode {
  return value === "local" || value === "worktree";
}

function isTranscriptViewMode(value: unknown): value is TranscriptViewMode {
  return value === "summary" || value === "normal" || value === "verbose";
}

function readPersistedSettings(): PersistedAgentSettings {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedAgentSettings) : {};
  } catch {
    return {};
  }
}

function readLegacyFlag(key: string, fallback: boolean): boolean {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {
    // Ignore unavailable storage.
  }
  return fallback;
}

function readLegacyComposerMode(): AgentComposerMode {
  try {
    if (typeof localStorage === "undefined") return "local";
    const raw = localStorage.getItem(LEGACY_COMPOSER_MODE_KEY);
    return isComposerMode(raw) ? raw : "local";
  } catch {
    return "local";
  }
}

function normalizeAutoArchiveDays(value: unknown): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AGENT_AUTO_ARCHIVE_DAYS;
  return Math.min(365, Math.max(1, Math.round(numeric)));
}

function loadSettings(): AgentSettingsValues {
  const persisted = readPersistedSettings();
  return {
    composerMode: isComposerMode(persisted.composerMode)
      ? persisted.composerMode
      : readLegacyComposerMode(),
    railCollapsed:
      persisted.railCollapsed ?? readLegacyFlag(LEGACY_RAIL_COLLAPSED_KEY, false),
    onboardingDismissed:
      persisted.onboardingDismissed ??
      readLegacyFlag(LEGACY_ONBOARDING_DISMISSED_KEY, false),
    autoArchiveDays: normalizeAutoArchiveDays(persisted.autoArchiveDays),
    autoFailoverEnabled: persisted.autoFailoverEnabled ?? true,
    defaultEnabledMcpServerIds:
      Array.isArray(persisted.defaultEnabledMcpServerIds)
        ? persisted.defaultEnabledMcpServerIds
        : null,
    transcriptViewMode: isTranscriptViewMode(persisted.transcriptViewMode)
      ? persisted.transcriptViewMode
      : "normal",
    worktreeCleanupPolicy: isWorktreeCleanupPolicy(persisted.worktreeCleanupPolicy)
      ? persisted.worktreeCleanupPolicy
      : DEFAULT_WORKTREE_CLEANUP_POLICY,
  };
}

function saveSettings(settings: AgentSettingsValues): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    localStorage.setItem(LEGACY_COMPOSER_MODE_KEY, settings.composerMode);
    localStorage.setItem(
      LEGACY_RAIL_COLLAPSED_KEY,
      settings.railCollapsed ? "1" : "0",
    );
    localStorage.setItem(
      LEGACY_ONBOARDING_DISMISSED_KEY,
      settings.onboardingDismissed ? "1" : "0",
    );
  } catch {
    // Ignore unavailable storage.
  }
}

const initialSettings = loadSettings();

export const useAgentSettingsStore = create<AgentSettingsState>((set, get) => {
  function update(partial: Partial<AgentSettingsValues>) {
    const next = { ...get(), ...partial };
    set(partial);
    saveSettings({
      composerMode: next.composerMode,
      railCollapsed: next.railCollapsed,
      onboardingDismissed: next.onboardingDismissed,
      autoArchiveDays: next.autoArchiveDays,
      autoFailoverEnabled: next.autoFailoverEnabled,
      defaultEnabledMcpServerIds: next.defaultEnabledMcpServerIds,
      transcriptViewMode: next.transcriptViewMode,
      worktreeCleanupPolicy: next.worktreeCleanupPolicy,
    });
  }

  return {
    ...initialSettings,

    setComposerMode: (composerMode) => update({ composerMode }),
    setRailCollapsed: (railCollapsed) => update({ railCollapsed }),
    setOnboardingDismissed: (onboardingDismissed) =>
      update({ onboardingDismissed }),
    dismissOnboarding: () => update({ onboardingDismissed: true }),
    showOnboarding: () => update({ onboardingDismissed: false }),
    setAutoArchiveDays: (autoArchiveDays) =>
      update({ autoArchiveDays: normalizeAutoArchiveDays(autoArchiveDays) }),
    setAutoFailoverEnabled: (autoFailoverEnabled) =>
      update({ autoFailoverEnabled }),
    setDefaultEnabledMcpServerIds: (defaultEnabledMcpServerIds) =>
      update({ defaultEnabledMcpServerIds }),
    setTranscriptViewMode: (transcriptViewMode) =>
      update({ transcriptViewMode }),
    cycleTranscriptViewMode: () => {
      const current = get().transcriptViewMode;
      const idx = TRANSCRIPT_VIEW_MODE_CYCLE.indexOf(current);
      const next =
        TRANSCRIPT_VIEW_MODE_CYCLE[(idx + 1) % TRANSCRIPT_VIEW_MODE_CYCLE.length];
      update({ transcriptViewMode: next });
    },
    setWorktreeCleanupPolicy: (worktreeCleanupPolicy) =>
      update({ worktreeCleanupPolicy }),
    hydrateFromStorage: () => set(loadSettings()),
  };
});

export function getAgentAutoArchiveIdleMs(): number | null {
  const days = useAgentSettingsStore.getState().autoArchiveDays;
  if (days === null) return null;
  return days * 24 * 60 * 60 * 1000;
}

/** Tile program (P4-S3): imperative read of the current worktree cleanup
 * policy for the archive fan-out (which runs outside React). */
export function getWorktreeCleanupPolicy(): WorktreeCleanupPolicy {
  return useAgentSettingsStore.getState().worktreeCleanupPolicy;
}
