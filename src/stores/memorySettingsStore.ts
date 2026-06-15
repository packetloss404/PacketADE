import { create } from "zustand";
import { storageKey } from "@/lib/brand";

export const DEFAULT_MEMORY_MAX_EVENTS = 200;
export const DEFAULT_MEMORY_MAX_PATTERNS = 20;
export const DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD = 3;
export const DEFAULT_MEMORY_CONTEXT_MAX_PATTERNS = 10;
export const DEFAULT_MEMORY_CONTEXT_MAX_SESSIONS = 5;
export const DEFAULT_MEMORY_CONTEXT_MAX_LESSONS = 5;
export const DEFAULT_MEMORY_RETENTION_DAYS = 30;

const STORAGE_KEY = storageKey("memory-settings");

/**
 * v0.8 setting: how the memory store decides whether a project-scoped
 * pattern or event matches the current session's project path.
 *
 * - `exact` (default): normalized path equality — the historical
 *   behaviour. Subdirectories of a workspace see nothing the workspace
 *   recorded at the root.
 * - `parent`: match when either side is a path prefix of the other.
 *   Lets sub-workspaces inherit a parent project's memory while still
 *   isolating sibling projects.
 * - `global`: ignore the project path entirely — every project-scoped
 *   pattern becomes effectively global.
 */
export type MemoryProjectPathMatching = "exact" | "parent" | "global";

export interface MemorySettingsValues {
  captureSessions: boolean;
  captureTasks: boolean;
  captureFlights: boolean;
  summarizeSessions: boolean;
  extractPatterns: boolean;
  retentionDays: number | null;
  maxEvents: number;
  maxPatterns: number;
  patternRefreshThreshold: number;
  contextMaxPatterns: number;
  contextMaxSessions: number;
  contextMaxLessons: number;
  /** v0.8: how to match `projectPath` for memory context lookups. */
  projectPathMatching: MemoryProjectPathMatching;
  /**
   * v0.8: when true (default), pinned patterns are kept even if the
   * pattern cap would otherwise evict them. When false, pinned
   * patterns are treated like any other entry in the LRU.
   */
  pinnedExemptFromCap: boolean;
}

interface MemorySettingsStore extends MemorySettingsValues {
  setCaptureSessions: (enabled: boolean) => void;
  setCaptureTasks: (enabled: boolean) => void;
  setCaptureFlights: (enabled: boolean) => void;
  setSummarizeSessions: (enabled: boolean) => void;
  setExtractPatterns: (enabled: boolean) => void;
  setRetentionDays: (days: number | null) => void;
  setMaxEvents: (count: number) => void;
  setMaxPatterns: (count: number) => void;
  setPatternRefreshThreshold: (count: number) => void;
  setContextMaxPatterns: (count: number) => void;
  setContextMaxSessions: (count: number) => void;
  setContextMaxLessons: (count: number) => void;
  setProjectPathMatching: (mode: MemoryProjectPathMatching) => void;
  setPinnedExemptFromCap: (enabled: boolean) => void;
  resetMemorySettings: () => void;
  hydrateFromStorage: () => void;
}

const DEFAULTS: MemorySettingsValues = {
  captureSessions: true,
  captureTasks: true,
  captureFlights: true,
  summarizeSessions: true,
  extractPatterns: true,
  retentionDays: null,
  maxEvents: DEFAULT_MEMORY_MAX_EVENTS,
  maxPatterns: DEFAULT_MEMORY_MAX_PATTERNS,
  patternRefreshThreshold: DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD,
  contextMaxPatterns: DEFAULT_MEMORY_CONTEXT_MAX_PATTERNS,
  contextMaxSessions: DEFAULT_MEMORY_CONTEXT_MAX_SESSIONS,
  contextMaxLessons: DEFAULT_MEMORY_CONTEXT_MAX_LESSONS,
  projectPathMatching: "exact",
  pinnedExemptFromCap: true,
};

function normalizeProjectPathMatching(value: unknown): MemoryProjectPathMatching {
  return value === "parent" || value === "global" ? value : "exact";
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeRetentionDays(value: unknown): number | null {
  if (value === null) return null;
  return clampInteger(value, DEFAULT_MEMORY_RETENTION_DAYS, 1, 3650);
}

function normalize(raw: Partial<MemorySettingsValues> | null | undefined): MemorySettingsValues {
  const source = raw ?? {};
  return {
    captureSessions: source.captureSessions ?? DEFAULTS.captureSessions,
    captureTasks: source.captureTasks ?? DEFAULTS.captureTasks,
    captureFlights: source.captureFlights ?? DEFAULTS.captureFlights,
    summarizeSessions: source.summarizeSessions ?? DEFAULTS.summarizeSessions,
    extractPatterns: source.extractPatterns ?? DEFAULTS.extractPatterns,
    retentionDays:
      source.retentionDays === undefined
        ? DEFAULTS.retentionDays
        : normalizeRetentionDays(source.retentionDays),
    maxEvents: clampInteger(source.maxEvents, DEFAULTS.maxEvents, 20, 2000),
    maxPatterns: clampInteger(source.maxPatterns, DEFAULTS.maxPatterns, 1, 100),
    patternRefreshThreshold: clampInteger(
      source.patternRefreshThreshold,
      DEFAULTS.patternRefreshThreshold,
      1,
      20,
    ),
    contextMaxPatterns: clampInteger(
      source.contextMaxPatterns,
      DEFAULTS.contextMaxPatterns,
      0,
      50,
    ),
    contextMaxSessions: clampInteger(
      source.contextMaxSessions,
      DEFAULTS.contextMaxSessions,
      0,
      50,
    ),
    contextMaxLessons: clampInteger(
      source.contextMaxLessons,
      DEFAULTS.contextMaxLessons,
      0,
      50,
    ),
    projectPathMatching: normalizeProjectPathMatching(source.projectPathMatching),
    pinnedExemptFromCap:
      typeof source.pinnedExemptFromCap === "boolean"
        ? source.pinnedExemptFromCap
        : DEFAULTS.pinnedExemptFromCap,
  };
}

function loadSettings(): MemorySettingsValues {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return normalize(JSON.parse(raw) as Partial<MemorySettingsValues>);
  } catch {
    return DEFAULTS;
  }
}

function persist(settings: MemorySettingsValues) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Preferences are best-effort; runtime state still updates.
  }
}

const initial = loadSettings();

export const useMemorySettingsStore = create<MemorySettingsStore>((set, get) => {
  const update = (patch: Partial<MemorySettingsValues>) => {
    const next = normalize({ ...get(), ...patch });
    set(next);
    persist(next);
  };

  return {
    ...initial,
    setCaptureSessions: (captureSessions) => update({ captureSessions }),
    setCaptureTasks: (captureTasks) => update({ captureTasks }),
    setCaptureFlights: (captureFlights) => update({ captureFlights }),
    setSummarizeSessions: (summarizeSessions) => update({ summarizeSessions }),
    setExtractPatterns: (extractPatterns) => update({ extractPatterns }),
    setRetentionDays: (retentionDays) => update({ retentionDays }),
    setMaxEvents: (maxEvents) => update({ maxEvents }),
    setMaxPatterns: (maxPatterns) => update({ maxPatterns }),
    setPatternRefreshThreshold: (patternRefreshThreshold) =>
      update({ patternRefreshThreshold }),
    setContextMaxPatterns: (contextMaxPatterns) => update({ contextMaxPatterns }),
    setContextMaxSessions: (contextMaxSessions) => update({ contextMaxSessions }),
    setContextMaxLessons: (contextMaxLessons) => update({ contextMaxLessons }),
    setProjectPathMatching: (projectPathMatching) => update({ projectPathMatching }),
    setPinnedExemptFromCap: (pinnedExemptFromCap) => update({ pinnedExemptFromCap }),
    resetMemorySettings: () => update(DEFAULTS),
    hydrateFromStorage: () => {
      const next = loadSettings();
      set(next);
      persist(next);
    },
  };
});

export function getMemorySettings(): MemorySettingsValues {
  const state = useMemorySettingsStore.getState();
  return normalize({
    captureSessions: state.captureSessions,
    captureTasks: state.captureTasks,
    captureFlights: state.captureFlights,
    summarizeSessions: state.summarizeSessions,
    extractPatterns: state.extractPatterns,
    retentionDays: state.retentionDays,
    maxEvents: state.maxEvents,
    maxPatterns: state.maxPatterns,
    patternRefreshThreshold: state.patternRefreshThreshold,
    contextMaxPatterns: state.contextMaxPatterns,
    contextMaxSessions: state.contextMaxSessions,
    contextMaxLessons: state.contextMaxLessons,
    projectPathMatching: state.projectPathMatching,
    pinnedExemptFromCap: state.pinnedExemptFromCap,
  });
}
