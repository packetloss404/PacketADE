import { create } from "zustand";
import {
  saveMemorySlice,
  summarizeSession,
  extractPatterns,
  readPtyTranscript,
  togglePinnedPattern as togglePinnedPatternBackend,
} from "@/lib/tauri";
import { parseJsonFromResponse, generateId } from "@/lib/storage";
import { getMemorySettings } from "@/stores/memorySettingsStore";
import type {
  MemoryEvent,
  MemoryEventType,
  LearnedPattern,
  SessionCompletedPayload,
  TaskCompletedPayload,
  FlightCompletedPayload,
  ManualNotePayload,
} from "@/types/memory";
import type { loadPersistedState } from "@/lib/tauri";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** v0.8-H: kind discriminator for the structured context preview. */
export type ContextItemKind = "pattern" | "lesson" | "session";

/** v0.8-H: a single row in the AgentInputArea context chevron. */
export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  title: string;
  timestamp: number;
  /** Human-readable explanation surfaced in the "Why this?" tooltip. */
  reason: string;
}

export type MemoryBriefScopeKind = "local" | "ssh";

export interface MemoryBriefScope {
  projectPath: string;
  kind?: MemoryBriefScopeKind;
  workspaceId?: string | null;
  serverId?: string | null;
  remotePath?: string | null;
}

export interface MemoryBrief {
  text: string;
  items: ContextItem[];
  charBudget: number;
  truncated: boolean;
  scopeKey: string;
}

const DEFAULT_MEMORY_BRIEF_MAX_CHARS = 1800;
const MAX_MEMORY_BRIEF_MAX_CHARS = 4000;

interface MemoryStore {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  lastPatternRefreshAt: number | null;
  summariesSinceLastRefresh: number;
  isLearning: boolean;
  learningStatus: string | null;

  // Hydration
  hydrateFromBackend: (persisted: Awaited<ReturnType<typeof loadPersistedState>>) => void;

  // Auto-capture (called from session/task/flight lifecycle)
  captureSessionCompleted: (payload: SessionCompletedPayload, projectPath: string) => void;
  captureTaskCompleted: (payload: TaskCompletedPayload, projectPath: string) => void;
  captureFlightCompleted: (payload: FlightCompletedPayload, projectPath: string) => void;
  /**
   * v0.8-D — manual capture from any UI surface (initial caller is GitHub
   * "Save as memory"). Bypasses the per-type capture toggles in
   * memorySettings: if a human explicitly clicked Save, we save. Tags
   * default to `[source]` so the event is filterable later.
   */
  captureManually: (input: {
    projectPath: string;
    source: string;
    summary: string;
    body: string;
    tags?: string[];
  }) => MemoryEvent;

  // Auto-learning: summarize a session transcript and store the result
  learnFromSession: (
    sessionId: string,
    agentId: string,
    projectPath: string,
    durationMs: number,
  ) => Promise<void>;

  // Manual pattern refresh
  refreshPatterns: (projectPath: string) => Promise<void>;

  // Cleanup
  deleteEvent: (id: string) => void;
  deletePattern: (id: string) => void;
  applyRetentionPolicy: () => void;
  /** F3: edit a learned pattern's text or category. Resets confidence to
   * 1.0 since a hand-edit is implicitly authoritative. */
  updatePattern: (
    id: string,
    updates: { pattern?: string; category?: LearnedPattern["category"] },
  ) => void;
  /** v0.8-H: flip the `pinned` flag on a pattern. Pinned patterns sort
   * first in injected context and are exempt from eviction. */
  togglePinPattern: (id: string) => void;
  clearMemory: () => void;

  /** Context injection (live, not snapshot). Accepts either a project-path
   * string (legacy single-arg form) or an options object so callers can
   * pass a sessionId without breaking back-compat. */
  getContextForSession: (input: string | { sessionId?: string; projectPath: string }) => string;
  /** v0.8-H: structured form of `getContextForSession` used by the
   * AgentInputArea context-preview chevron. Returns the same items that
   * would compose the injected string, broken into rows the UI can
   * render with relative time + reason tooltips. */
  getContextItemsForSession: (
    input: string | ({ sessionId?: string } & MemoryBriefScope),
  ) => ContextItem[];
  /** Compact prompt-injection form used when launching executor/API-agent
   * sessions. It is intentionally smaller and stricter than the context
   * preview: remote SSH scopes only match memory explicitly keyed to that
   * workspace/server. */
  composeMemoryBrief: (
    input: string | MemoryBriefScope,
    options?: { maxChars?: number },
  ) => MemoryBrief;
}

function createEvent<T extends MemoryEventType>(
  type: T,
  projectPath: string,
  payload: T extends "session_completed"
    ? SessionCompletedPayload
    : T extends "task_completed"
      ? TaskCompletedPayload
      : T extends "flight_completed"
        ? FlightCompletedPayload
        : ManualNotePayload,
): MemoryEvent {
  return {
    id: generateId("mem"),
    type,
    timestamp: Date.now(),
    projectPath,
    payload,
  } as MemoryEvent;
}

function capEvents(events: MemoryEvent[]): MemoryEvent[] {
  const settings = getMemorySettings();
  const retained =
    settings.retentionDays === null
      ? events
      : events.filter((event) => {
          const cutoff = Date.now() - settings.retentionDays! * 24 * 60 * 60 * 1000;
          return event.timestamp >= cutoff;
        });
  if (retained.length <= settings.maxEvents) return retained;
  return retained.slice(retained.length - settings.maxEvents);
}

function capPatterns(patterns: LearnedPattern[]): LearnedPattern[] {
  const settings = getMemorySettings();
  const maxPatterns = settings.maxPatterns;
  // v0.8-H — pinned patterns are exempt from eviction by default. We
  // keep all pinned entries even if it pushes us over `maxPatterns`,
  // and the remaining (unpinned) entries are sorted by confidence then
  // recency and trimmed to fill whatever headroom is left.
  //
  // v0.8 setting `pinnedExemptFromCap = false`: pinned patterns are
  // demoted to the same LRU as everything else — useful for users who
  // want a hard ceiling regardless of how many things they have
  // pinned.
  if (!settings.pinnedExemptFromCap) {
    if (patterns.length <= maxPatterns) return patterns;
    const sorted = [...patterns].sort(
      (a, b) => b.confidence - a.confidence || b.extractedAt - a.extractedAt,
    );
    const survivors = new Set<string>(sorted.slice(0, maxPatterns).map((p) => p.id));
    return patterns.filter((p) => survivors.has(p.id));
  }
  const pinned = patterns.filter((p) => p.pinned);
  const unpinned = patterns.filter((p) => !p.pinned);
  const headroom = Math.max(0, maxPatterns - pinned.length);
  const keptUnpinned =
    unpinned.length <= headroom
      ? unpinned
      : [...unpinned]
          .sort((a, b) => b.confidence - a.confidence || b.extractedAt - a.extractedAt)
          .slice(0, headroom);
  const survivors = new Set<string>([...pinned.map((p) => p.id), ...keptUnpinned.map((p) => p.id)]);
  // Preserve original ordering so the rest of the store doesn't see
  // patterns shuffle on every persist.
  return patterns.filter((p) => survivors.has(p.id));
}

function clampBriefChars(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MEMORY_BRIEF_MAX_CHARS;
  return Math.max(400, Math.min(MAX_MEMORY_BRIEF_MAX_CHARS, Math.round(parsed)));
}

function normalizeBriefText(text: string, maxChars = 260): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeScopeInput(input: string | MemoryBriefScope): Required<MemoryBriefScope> {
  if (typeof input === "string") {
    return {
      projectPath: input,
      kind: "local",
      workspaceId: null,
      serverId: null,
      remotePath: null,
    };
  }
  return {
    projectPath: input.projectPath,
    kind: input.kind ?? (input.serverId ? "ssh" : "local"),
    workspaceId: input.workspaceId ?? null,
    serverId: input.serverId ?? null,
    remotePath: input.remotePath ?? null,
  };
}

export function remoteMemoryProjectKey(serverId: string, remotePath: string): string {
  return `ssh:${serverId}:${normalizePath(remotePath)}`;
}

export function workspaceMemoryProjectKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

function memoryScopeKey(scope: Required<MemoryBriefScope>): string {
  if (scope.kind === "ssh" && scope.serverId) {
    return remoteMemoryProjectKey(scope.serverId, scope.remotePath || scope.projectPath);
  }
  if (scope.workspaceId) return workspaceMemoryProjectKey(scope.workspaceId);
  return normalizePath(scope.projectPath);
}

async function persistState(events: MemoryEvent[], patterns?: LearnedPattern[]) {
  try {
    await saveMemorySlice(events, patterns);
  } catch (err) {
    // Non-fatal: state is still in memory, but the user will lose it on
    // restart. Surface to the console so dev / log-readers notice instead
    // of failing silently — a recurring failure here means disk-full,
    // permission denied, or a backend bug.
    console.error("[memory] failed to persist memory slice:", err);
  }
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  events: [],
  patterns: [],
  lastPatternRefreshAt: null,
  summariesSinceLastRefresh: 0,
  isLearning: false,
  learningStatus: null,

  hydrateFromBackend: (persisted) => {
    const rawEvents = (persisted.memoryEvents ?? []) as MemoryEvent[];
    const rawPatterns = (persisted.memoryPatterns ?? []) as LearnedPattern[];
    const events = capEvents(rawEvents);
    const patterns = capPatterns(rawPatterns);
    set({ events, patterns });
    if (events.length !== rawEvents.length || patterns.length !== rawPatterns.length) {
      void persistState(events, patterns);
    }
  },

  captureSessionCompleted: (payload, projectPath) => {
    if (!getMemorySettings().captureSessions) return;
    const event = createEvent("session_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  captureTaskCompleted: (payload, projectPath) => {
    if (!getMemorySettings().captureTasks) return;
    const event = createEvent("task_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  captureFlightCompleted: (payload, projectPath) => {
    if (!getMemorySettings().captureFlights) return;
    const event = createEvent("flight_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  captureManually: ({ projectPath, source, summary, body, tags }) => {
    // v0.8-D — bypass the per-type capture toggles: this is an explicit
    // human action ("Save as memory"), not a passive auto-capture.
    const payload: ManualNotePayload = {
      source,
      summary,
      body,
      tags: tags && tags.length > 0 ? tags : [source],
    };
    const event = createEvent("manual_note", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
    return event;
  },

  learnFromSession: async (sessionId, agentId, projectPath, durationMs) => {
    const settings = getMemorySettings();
    if (!settings.captureSessions || !settings.summarizeSessions) return;
    if (get().isLearning) return; // don't stack concurrent learning calls

    set({ isLearning: true, learningStatus: "Reading session transcript..." });

    try {
      // 1. Read the PTY transcript
      const transcript = await readPtyTranscript(sessionId);
      if (!transcript?.data?.trim()) {
        set({ isLearning: false, learningStatus: null });
        return;
      }

      // Trim transcript to last ~4000 chars to avoid blowing up the LLM call
      const trimmedTranscript =
        transcript.data.length > 4000 ? transcript.data.slice(-4000) : transcript.data;

      // 2. Summarize the session
      set({ learningStatus: "Summarizing session..." });
      const summaryResult = await summarizeSession(projectPath, trimmedTranscript);
      const parsed = parseJsonFromResponse(summaryResult) as {
        summary: string;
        keyDecisions: string[];
        filesModified: string[];
      };

      if (!parsed?.summary) {
        set({ isLearning: false, learningStatus: null });
        return;
      }

      // 3. Store the summarized event
      const event = createEvent("session_completed", projectPath, {
        sessionId,
        agentId,
        durationMs,
        status: "done",
        summary: parsed.summary,
        filesModified: parsed.filesModified ?? [],
        keyDecisions: parsed.keyDecisions ?? [],
      });
      const events = capEvents([...get().events, event]);
      const count = get().summariesSinceLastRefresh + 1;
      set({ events, summariesSinceLastRefresh: count });

      // 4. Auto-extract patterns if threshold met
      if (settings.extractPatterns && count >= settings.patternRefreshThreshold) {
        set({ learningStatus: "Extracting patterns..." });
        await get().refreshPatterns(projectPath);
      }

      set({ isLearning: false, learningStatus: null });
      void persistState(get().events, get().patterns);
    } catch (e) {
      console.warn("Memory learning failed:", e);
      set({ isLearning: false, learningStatus: null });
    }
  },

  refreshPatterns: async (projectPath) => {
    const { events } = get();
    const normalizedPath = normalizePath(projectPath);

    // Collect session summaries for this project
    const summaries = events
      .filter(
        (e): e is Extract<MemoryEvent, { type: "session_completed" }> =>
          e.type === "session_completed" &&
          normalizePath(e.projectPath) === normalizedPath &&
          e.payload.summary !== null,
      )
      .slice(-10) // last 10 summarized sessions
      .map((e) => e.payload.summary)
      .join("\n---\n");

    if (!summaries.trim()) return;

    try {
      const result = await extractPatterns(projectPath, summaries);
      const parsed = parseJsonFromResponse(result) as {
        pattern: string;
        category: string;
        confidence: number;
      }[];

      if (!Array.isArray(parsed)) return;

      const newPatterns: LearnedPattern[] = parsed
        .filter((p) => p.pattern && p.confidence >= 0.5)
        .slice(0, getMemorySettings().maxPatterns)
        .map((p) => ({
          id: generateId("pat"),
          pattern: p.pattern,
          category: (p.category as LearnedPattern["category"]) ?? "convention",
          confidence: p.confidence,
          extractedAt: Date.now(),
          // v0.8-H — stamp the project so patterns no longer leak across
          // workspaces. Source events were already filtered by
          // `normalizedPath` above so this is the right project to attribute.
          projectPath,
          pinned: false,
        }));

      // v0.8-H — preserve pinned patterns from the previous extraction
      // (they're authoritative and shouldn't disappear when we re-extract).
      const existing = get().patterns;
      const pinnedFromBefore = existing.filter((p) => p.pinned);
      const patterns = capPatterns([...pinnedFromBefore, ...newPatterns]);
      set({
        patterns,
        lastPatternRefreshAt: Date.now(),
        summariesSinceLastRefresh: 0,
      });
      void persistState(get().events, patterns);
    } catch (e) {
      console.warn("Pattern extraction failed:", e);
    }
  },

  deleteEvent: (id) => {
    const events = get().events.filter((e) => e.id !== id);
    set({ events });
    void persistState(events, get().patterns);
  },

  deletePattern: (id) => {
    const patterns = get().patterns.filter((p) => p.id !== id);
    set({ patterns });
    void persistState(get().events, patterns);
  },

  applyRetentionPolicy: () => {
    const events = capEvents(get().events);
    const patterns = capPatterns(get().patterns);
    set({ events, patterns });
    void persistState(events, patterns);
  },

  updatePattern: (id, updates) => {
    const patterns = get().patterns.map((p) =>
      p.id === id
        ? {
            ...p,
            pattern: updates.pattern ?? p.pattern,
            category: updates.category ?? p.category,
            // Hand-edit = authoritative; bump confidence so the edited
            // pattern outranks future auto-extractions for the same idea.
            confidence: 1.0,
          }
        : p,
    );
    set({ patterns });
    void persistState(get().events, patterns);
  },

  togglePinPattern: (id) => {
    // Optimistic flip — the in-memory state updates immediately so the UI
    // feels instant; the backend toggle is atomic and authoritative, so
    // on success we leave state alone, and on failure we revert.
    const before = get().patterns;
    const next = before.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p));
    set({ patterns: next });
    void togglePinnedPatternBackend(id)
      .then((result) => {
        if (result === null) {
          // Pattern not found on the backend — likely deleted on another
          // tab. Drop the stale entry locally.
          set({ patterns: get().patterns.filter((p) => p.id !== id) });
          return;
        }
        // Reconcile if the backend disagrees with our optimistic flip
        // (e.g. two clicks raced and the persisted record settled on a
        // different value than what we predicted).
        const stored = get().patterns.find((p) => p.id === id);
        if (stored && stored.pinned !== result) {
          set({
            patterns: get().patterns.map((p) => (p.id === id ? { ...p, pinned: result } : p)),
          });
        }
      })
      .catch((err) => {
        console.warn("togglePinnedPattern backend call failed:", err);
        set({ patterns: before });
      });
  },

  clearMemory: () => {
    set({
      events: [],
      patterns: [],
      lastPatternRefreshAt: null,
      summariesSinceLastRefresh: 0,
    });
    void persistState([], []);
  },

  getContextForSession: (input) => {
    const projectPath = typeof input === "string" ? input : input.projectPath;
    if (!projectPath) return "";

    const items = get().getContextItemsForSession(
      typeof input === "string" ? { projectPath } : input,
    );
    if (items.length === 0) return "";

    const lines: string[] = [];

    const patternItems = items.filter((i) => i.kind === "pattern");
    if (patternItems.length > 0) {
      lines.push("## Learned Patterns");
      for (const it of patternItems) lines.push(`- ${it.title}`);
      lines.push("");
    }

    const lessonItems = items.filter((i) => i.kind === "lesson");
    if (lessonItems.length > 0) {
      lines.push("## Lessons from Previous Flights");
      for (const it of lessonItems) lines.push(`- ${it.title}`);
      lines.push("");
    }

    const sessionItems = items.filter((i) => i.kind === "session");
    if (sessionItems.length > 0) {
      lines.push("## Recent Session Context");
      for (const it of sessionItems) lines.push(`- ${it.title}`);
      lines.push("");
    }

    return lines.join("\n");
  },

  getContextItemsForSession: (input) => {
    const scope = normalizeScopeInput(input);
    if (!scope.projectPath) return [];

    const normalizedCurrent = normalizePath(scope.projectPath);
    const explicitScopeKeys = new Set<string>();
    if (scope.workspaceId) {
      explicitScopeKeys.add(normalizePath(workspaceMemoryProjectKey(scope.workspaceId)));
    }
    if (scope.kind === "ssh" && scope.serverId) {
      explicitScopeKeys.add(
        normalizePath(
          remoteMemoryProjectKey(scope.serverId, scope.remotePath || scope.projectPath),
        ),
      );
    }
    const { events, patterns } = get();
    const settings = getMemorySettings();
    const out: ContextItem[] = [];

    // v0.8: `projectPathMatching` setting controls strictness.
    //   exact  — historical behaviour: normalized path equality
    //   parent — match when either side is a prefix of the other, so
    //            sub-workspaces inherit memory from a parent project
    //   global — every project-scoped item is considered a match
    //
    // Items with no `projectPath` (legacy / global) always match.
    const projectPathsMatch = (recorded: string | undefined | null): boolean => {
      if (scope.kind === "ssh") {
        if (!recorded) return false;
        return explicitScopeKeys.has(normalizePath(recorded));
      }

      if (!recorded) return true; // legacy/global item — always relevant
      if (explicitScopeKeys.has(normalizePath(recorded))) return true;
      if (settings.projectPathMatching === "global") return true;
      const recordedN = normalizePath(recorded);
      if (recordedN === normalizedCurrent) return true;
      if (settings.projectPathMatching === "parent") {
        const a = recordedN.endsWith("/") ? recordedN : recordedN + "/";
        const b = normalizedCurrent.endsWith("/") ? normalizedCurrent : normalizedCurrent + "/";
        return a.startsWith(b) || b.startsWith(a);
      }
      return false;
    };

    // 1. Learned patterns. Pinned patterns sort first and are exempt
    //    from the confidence cutoff (the user pinned them, so we trust
    //    their judgment over a 0.6 numerical threshold). Patterns
    //    without a `projectPath` are legacy/global — they always match.
    //    Patterns with a `projectPath` are filtered through
    //    `projectPathsMatch` so the v0.8 matching mode is honoured.
    const relevantPatterns = patterns
      .filter((p) => {
        if (!projectPathsMatch(p.projectPath)) return false;
        return p.pinned || p.confidence >= 0.6;
      })
      .sort((a, b) => {
        if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) {
          return a.pinned ? -1 : 1;
        }
        if (a.confidence !== b.confidence) return b.confidence - a.confidence;
        return b.extractedAt - a.extractedAt;
      })
      .slice(0, settings.contextMaxPatterns);

    for (const p of relevantPatterns) {
      const scope = p.projectPath ? "this project" : "all projects";
      out.push({
        id: p.id,
        kind: "pattern",
        title: `[${p.category}] ${p.pattern}`,
        timestamp: p.extractedAt,
        reason: p.pinned
          ? `Pinned · ${scope} · confidence ${(p.confidence * 100).toFixed(0)}%`
          : `Top pattern · ${scope} · confidence ${(p.confidence * 100).toFixed(0)}%`,
      });
    }

    // 2. Lessons from flight retrospectives (last 7 days, current project)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const flightEvents = events.filter(
      (e): e is Extract<MemoryEvent, { type: "flight_completed" }> =>
        e.type === "flight_completed" && projectPathsMatch(e.projectPath) && e.timestamp > cutoff,
    );
    let pushed = 0;
    outer: for (const e of flightEvents) {
      for (const l of e.payload.lessonsLearned) {
        if (pushed >= settings.contextMaxLessons) break outer;
        out.push({
          id: `${e.id}:lesson:${pushed}`,
          kind: "lesson",
          title: l,
          timestamp: e.timestamp,
          reason: "Lesson from flight retrospective (last 7 days)",
        });
        pushed += 1;
      }
    }

    // 3. Recent session summaries (last 48h, current project only)
    const sessionCutoff = Date.now() - 48 * 60 * 60 * 1000;
    const sessions = events
      .filter(
        (e): e is Extract<MemoryEvent, { type: "session_completed" }> =>
          e.type === "session_completed" &&
          projectPathsMatch(e.projectPath) &&
          e.timestamp > sessionCutoff &&
          e.payload.summary !== null,
      )
      .slice(-settings.contextMaxSessions);

    for (const e of sessions) {
      out.push({
        id: e.id,
        kind: "session",
        title: e.payload.summary ?? "",
        timestamp: e.timestamp,
        reason: "Recent session summary (last 48 hours)",
      });
    }

    return out;
  },

  composeMemoryBrief: (input, options) => {
    const scope = normalizeScopeInput(input);
    const charBudget = clampBriefChars(options?.maxChars);
    const items = get().getContextItemsForSession(scope);
    const scopeKey = memoryScopeKey(scope);
    if (items.length === 0) {
      return { text: "", items: [], charBudget, truncated: false, scopeKey };
    }

    const lines: string[] = [
      "## PacketADE Memory Brief",
      "Use this project memory when relevant. Prefer current repository files over stale notes.",
      "",
    ];
    const included: ContextItem[] = [];
    let truncated = false;

    const pushLine = (line: string, item?: ContextItem): boolean => {
      const next = [...lines, line].join("\n");
      if (next.length > charBudget) {
        truncated = true;
        return false;
      }
      lines.push(line);
      if (item) included.push(item);
      return true;
    };

    const groups: Array<[ContextItemKind, string]> = [
      ["pattern", "Learned patterns"],
      ["lesson", "Flight lessons"],
      ["session", "Recent session context"],
    ];

    for (const [kind, label] of groups) {
      const groupItems = items.filter((item) => item.kind === kind);
      if (groupItems.length === 0) continue;
      if (!pushLine(`${label}:`)) break;
      for (const item of groupItems) {
        if (!pushLine(`- ${normalizeBriefText(item.title)}`, item)) break;
      }
      if (!pushLine("")) break;
    }

    return {
      text: lines.join("\n").trim(),
      items: included,
      charBudget,
      truncated,
      scopeKey,
    };
  },
}));
