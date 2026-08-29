import { create } from "zustand";
import { storageKey } from "@/lib/brand";

export const DEFAULT_MEMORY_MAX_EVENTS = 200;
export const DEFAULT_MEMORY_MAX_PATTERNS = 20;
export const DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD = 3;
export const DEFAULT_MEMORY_CONTEXT_MAX_PATTERNS = 10;
export const DEFAULT_MEMORY_CONTEXT_MAX_SESSIONS = 5;
export const DEFAULT_MEMORY_CONTEXT_MAX_LESSONS = 5;
export const DEFAULT_MEMORY_CONTEXT_MAX_NOTES = 5;
export const DEFAULT_MEMORY_RETENTION_DAYS = 30;
/**
 * Character ceiling on the composed memory brief. Lived in `memoryStore.ts`
 * as an un-settable constant with an `options.maxChars` override that no
 * caller ever passed, so it was the real binding limit on every injected
 * brief while the source caps beside it were user-editable. The bounds are
 * the ones `clampBriefChars` already enforced.
 */
export const DEFAULT_MEMORY_BRIEF_MAX_CHARS = 1800;
export const MIN_MEMORY_BRIEF_MAX_CHARS = 400;
export const MAX_MEMORY_BRIEF_MAX_CHARS = 4000;

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
  captureFlights: boolean;
  summarizeSessions: boolean;
  extractPatterns: boolean;
  /**
   * When true (default), the composed memory brief is prepended to async
   * Flight prompts at launch. Turn off to keep Flight launches free of any
   * ambient project memory while still capturing/injecting elsewhere.
   */
  injectIntoFlightPrompts: boolean;
  retentionDays: number | null;
  maxEvents: number;
  maxPatterns: number;
  patternRefreshThreshold: number;
  contextMaxPatterns: number;
  contextMaxSessions: number;
  contextMaxLessons: number;
  /**
   * Durable `.agents/memory` project notes allowed into the composed brief.
   *
   * Its three siblings above were settings from the start; this one was a
   * hardcoded `MAX_CONTEXT_PROJECT_NOTES = 5` in `memoryStore.ts` from the
   * day note injection landed, so a project whose memory lives mostly in
   * hand-written notes could not widen the brief the way a
   * pattern-heavy project could. The default is still 5, so the shipped
   * behaviour is unchanged. `0` drops notes from the brief entirely.
   */
  contextMaxNotes: number;
  /**
   * Hard character budget for the composed brief. Sources are assembled in
   * order and the brief stops once this is reached, so raising a source cap
   * above what this budget can hold changes nothing.
   */
  briefMaxChars: number;
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
  setCaptureFlights: (enabled: boolean) => void;
  setSummarizeSessions: (enabled: boolean) => void;
  setExtractPatterns: (enabled: boolean) => void;
  setInjectIntoFlightPrompts: (enabled: boolean) => void;
  setRetentionDays: (days: number | null) => void;
  setMaxEvents: (count: number) => void;
  setMaxPatterns: (count: number) => void;
  setPatternRefreshThreshold: (count: number) => void;
  setContextMaxPatterns: (count: number) => void;
  setContextMaxSessions: (count: number) => void;
  setContextMaxLessons: (count: number) => void;
  setContextMaxNotes: (count: number) => void;
  setBriefMaxChars: (chars: number) => void;
  setProjectPathMatching: (mode: MemoryProjectPathMatching) => void;
  setPinnedExemptFromCap: (enabled: boolean) => void;
  resetMemorySettings: () => void;
}

const DEFAULTS: MemorySettingsValues = {
  captureSessions: true,
  captureFlights: true,
  summarizeSessions: true,
  extractPatterns: true,
  injectIntoFlightPrompts: true,
  retentionDays: null,
  maxEvents: DEFAULT_MEMORY_MAX_EVENTS,
  maxPatterns: DEFAULT_MEMORY_MAX_PATTERNS,
  patternRefreshThreshold: DEFAULT_MEMORY_PATTERN_REFRESH_THRESHOLD,
  contextMaxPatterns: DEFAULT_MEMORY_CONTEXT_MAX_PATTERNS,
  contextMaxSessions: DEFAULT_MEMORY_CONTEXT_MAX_SESSIONS,
  contextMaxLessons: DEFAULT_MEMORY_CONTEXT_MAX_LESSONS,
  contextMaxNotes: DEFAULT_MEMORY_CONTEXT_MAX_NOTES,
  briefMaxChars: DEFAULT_MEMORY_BRIEF_MAX_CHARS,
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
    captureFlights: source.captureFlights ?? DEFAULTS.captureFlights,
    summarizeSessions: source.summarizeSessions ?? DEFAULTS.summarizeSessions,
    extractPatterns: source.extractPatterns ?? DEFAULTS.extractPatterns,
    injectIntoFlightPrompts:
      source.injectIntoFlightPrompts ?? DEFAULTS.injectIntoFlightPrompts,
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
    contextMaxNotes: clampInteger(source.contextMaxNotes, DEFAULTS.contextMaxNotes, 0, 50),
    briefMaxChars: clampInteger(
      source.briefMaxChars,
      DEFAULTS.briefMaxChars,
      MIN_MEMORY_BRIEF_MAX_CHARS,
      MAX_MEMORY_BRIEF_MAX_CHARS,
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
    setCaptureFlights: (captureFlights) => update({ captureFlights }),
    setSummarizeSessions: (summarizeSessions) => update({ summarizeSessions }),
    setExtractPatterns: (extractPatterns) => update({ extractPatterns }),
    setInjectIntoFlightPrompts: (injectIntoFlightPrompts) =>
      update({ injectIntoFlightPrompts }),
    setRetentionDays: (retentionDays) => update({ retentionDays }),
    setMaxEvents: (maxEvents) => update({ maxEvents }),
    setMaxPatterns: (maxPatterns) => update({ maxPatterns }),
    setPatternRefreshThreshold: (patternRefreshThreshold) =>
      update({ patternRefreshThreshold }),
    setContextMaxPatterns: (contextMaxPatterns) => update({ contextMaxPatterns }),
    setContextMaxSessions: (contextMaxSessions) => update({ contextMaxSessions }),
    setContextMaxLessons: (contextMaxLessons) => update({ contextMaxLessons }),
    setContextMaxNotes: (contextMaxNotes) => update({ contextMaxNotes }),
    setBriefMaxChars: (briefMaxChars) => update({ briefMaxChars }),
    setProjectPathMatching: (projectPathMatching) => update({ projectPathMatching }),
    setPinnedExemptFromCap: (pinnedExemptFromCap) => update({ pinnedExemptFromCap }),
    resetMemorySettings: () => update(DEFAULTS),
  };
});

export function getMemorySettings(): MemorySettingsValues {
  const state = useMemorySettingsStore.getState();
  return normalize({
    captureSessions: state.captureSessions,
    captureFlights: state.captureFlights,
    summarizeSessions: state.summarizeSessions,
    extractPatterns: state.extractPatterns,
    injectIntoFlightPrompts: state.injectIntoFlightPrompts,
    retentionDays: state.retentionDays,
    maxEvents: state.maxEvents,
    maxPatterns: state.maxPatterns,
    patternRefreshThreshold: state.patternRefreshThreshold,
    contextMaxPatterns: state.contextMaxPatterns,
    contextMaxSessions: state.contextMaxSessions,
    contextMaxLessons: state.contextMaxLessons,
    contextMaxNotes: state.contextMaxNotes,
    briefMaxChars: state.briefMaxChars,
    projectPathMatching: state.projectPathMatching,
    pinnedExemptFromCap: state.pinnedExemptFromCap,
  });
}
