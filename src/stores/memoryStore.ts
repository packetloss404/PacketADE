import { create } from "zustand";
import {
  saveMemorySlice,
  summarizeSession,
  extractPatterns,
  readPtyTranscript,
  togglePinnedPattern as togglePinnedPatternBackend,
} from "@/lib/tauri";
import { parseJsonFromResponse, generateId } from "@/lib/storage";
import {
  memoryRecordProvenance,
  unknownProvenance,
} from "@/lib/provenance";
import {
  getMemorySettings,
  MAX_MEMORY_BRIEF_MAX_CHARS,
  MIN_MEMORY_BRIEF_MAX_CHARS,
} from "@/stores/memorySettingsStore";
import type { MemoryProjectPathMatching } from "@/stores/memorySettingsStore";
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
import type { ProvenanceEnvelope } from "@/types/provenance";
import type { ProjectMemoryNote } from "@/types/project-memory";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";

function normalizePath(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      // Strip trailing separators, but keep a bare "/". These are
      // spellings of the SAME directory, and treating them as different
      // scopes silently dropped memory under `exact` matching.
      .replace(/(.)\/+$/, "$1")
      .toLowerCase()
  );
}

/** v0.8-H: kind discriminator for the structured context preview. */
export type ContextItemKind = "pattern" | "lesson" | "session" | "project_note";

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

/**
 * P2-18: pure stats summary for the single surviving ambient memory
 * surface (HeaderOverflowMenu's flyout + MemoryInjectionCard's collapsed
 * row). Derives counts from the SAME brief the launch pipeline injects
 * (composeMemoryBrief) so previews never overstate what will actually
 * be sent.
 */
export function memoryBriefStats(brief: MemoryBrief): {
  patterns: number;
  lessons: number;
  summaries: number;
  notes: number;
  approxTokens: number;
} {
  let patterns = 0;
  let lessons = 0;
  let summaries = 0;
  let notes = 0;
  for (const item of brief.items) {
    if (item.kind === "pattern") patterns += 1;
    else if (item.kind === "lesson") lessons += 1;
    else if (item.kind === "session") summaries += 1;
    else if (item.kind === "project_note") notes += 1;
  }
  const approxTokens = Math.max(0, Math.round(brief.text.length / 4));
  return { patterns, lessons, summaries, notes, approxTokens };
}

interface MemoryStore {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  lastPatternRefreshAt: number | null;
  summariesSinceLastRefresh: number;
  isLearning: boolean;
  learningStatus: string | null;

  // Hydration
  hydrateFromBackend: (persisted: Awaited<ReturnType<typeof loadPersistedState>>) => void;

  // Auto-capture (called from the flight lifecycle)
  captureFlightCompleted: (payload: FlightCompletedPayload, scope: MemoryScopeInput) => void;
  /** M9: merge a rich LLM retrospective onto the already-captured
   *  `flight_completed` event for `flightId` (async enrichment). No-op if the
   *  event was never captured (e.g. `captureFlights` disabled). */
  updateFlightRetrospective: (
    flightId: string,
    retro: Partial<FlightCompletedPayload>,
  ) => void;
  /**
   * v0.8-D — manual capture from any UI surface (initial caller is GitHub
   * "Save as memory"). Bypasses the per-type capture toggles in
   * memorySettings: if a human explicitly clicked Save, we save. Tags
   * default to `[source]` so the event is filterable later.
   */
  captureManually: (input: {
    /** A plain path (local) or a full `MemoryBriefScope` (remote-capable). */
    scope: MemoryScopeInput;
    source: string;
    summary: string;
    body: string;
    tags?: string[];
    provenance?: ProvenanceEnvelope[];
  }) => MemoryEvent;

  // Auto-learning: summarize a session transcript and store the result
  /**
   * Record a finished PTY session, then (best-effort) enrich it with an LLM
   * summary. The event is written and persisted BEFORE the summarization call
   * so the Timeline is populated even when no aux provider is configured, the
   * model returns junk, or the call hangs — memory is a record of what
   * happened, not a record of what an LLM managed to describe.
   */
  learnFromSession: (
    sessionId: string,
    agentId: string,
    scope: MemoryScopeInput,
    durationMs: number,
    status?: SessionCompletedPayload["status"],
  ) => Promise<void>;

  // Manual pattern refresh
  refreshPatterns: (scope: MemoryScopeInput) => Promise<void>;

  /**
   * Opt-in, reversible migration: re-stamp memory recorded under the plain
   * remote path with this remote scope's key. Returns how many records moved.
   * Never called automatically — see `findLegacyRemoteMemory`.
   */
  adoptLegacyRemoteMemory: (scope: MemoryBriefScope) => number;
  /** Undo `adoptLegacyRemoteMemory` for this scope. Returns records restored. */
  revertAdoptedRemoteMemory: (scope: MemoryBriefScope) => number;

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

  /** M3: merge a JSON memory export into the corpus (dedup by id). Returns the
   *  counts of newly-added items, or null if the JSON was invalid. */
  importMemory: (json: string) => { addedEvents: number; addedPatterns: number } | null;

  /** M5: record which learned-pattern ids were injected into a flight's launch
   *  brief, so their confidence can be rerated when the flight settles. Unions
   *  with any prior record for the same flight. */
  recordInjectedPatterns: (flightId: string, patternIds: string[]) => void;
  /** M5: drop a flight's injection provenance without rerating (e.g. the flight
   *  was cancelled — not the pattern's fault). */
  clearInjectedPatterns: (flightId: string) => void;
  /** M5: rerate the confidence of every pattern injected into `flightId` by the
   *  flight's success, then clear that flight's provenance. No-op if nothing was
   *  recorded (e.g. injection disabled, or the flight settled after a restart). */
  adjustConfidenceForFlight: (flightId: string, success: boolean) => void;

  /** Compact prompt-injection form used when launching executor/API-agent
   * sessions. It is intentionally smaller and stricter than the context
   * preview: remote SSH scopes only match memory explicitly keyed to that
   * workspace/server. */
  composeMemoryBrief: (
    input: string | MemoryBriefScope,
    options?: { maxChars?: number; query?: string },
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
  parents: ProvenanceEnvelope[] = [],
): MemoryEvent {
  const id = generateId("mem");
  const timestamp = Date.now();
  return {
    id,
    type,
    timestamp,
    projectPath,
    payload,
    provenance: memoryRecordProvenance(
      id,
      `Memory ${type.replaceAll("_", " ")}`,
      parents,
      timestamp,
    ),
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

/** The brief's character ceiling. An explicit `options.maxChars` still wins
 *  (nothing in the app passes one today); otherwise the user's configured
 *  budget applies, clamped to the same bounds either way. */
function clampBriefChars(value: unknown): number {
  const parsed = Number(value);
  const requested = Number.isFinite(parsed) ? parsed : getMemorySettings().briefMaxChars;
  return Math.max(
    MIN_MEMORY_BRIEF_MAX_CHARS,
    Math.min(MAX_MEMORY_BRIEF_MAX_CHARS, Math.round(requested)),
  );
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

/**
 * Matched by `createProjectScopeMatcher` but deliberately never WRITTEN by
 * `memoryWriteKey`. It is a read-side alias only, so a scope can opt into
 * workspace-pinned memory later without invalidating anything already
 * recorded. Stamping it today would sever every local record from its project
 * path and break parent matching and every path-shaped display.
 */
export function workspaceMemoryProjectKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** Anything a caller may hand the memory store to identify a scope. */
export type MemoryScopeInput = string | MemoryBriefScope;

/**
 * THE write choke point. Every new memory record's `projectPath` field is
 * stamped from here, so scope keying lives in one place instead of at each of
 * the four capture call sites (which is why remote memory used to be empty by
 * construction — all four stamped a plain path).
 *
 * - local -> the plain filesystem path, unchanged. Parent matching, the
 *            project chips, `refreshPatterns` and `.agents/memory` note
 *            loading all still see a real path.
 * - ssh   -> `ssh:<serverId>:<normalized remote path>`, the only thing
 *            `createProjectScopeMatcher` will match under an ssh scope.
 */
export function memoryWriteKey(input: MemoryScopeInput): string {
  const scope = normalizeScopeInput(input);
  if (scope.kind === "ssh" && scope.serverId) {
    return remoteMemoryProjectKey(scope.serverId, scope.remotePath || scope.projectPath);
  }
  return scope.projectPath;
}

/**
 * The `project_path` argument handed to the aux-LLM Tauri commands
 * (`summarize_session`, `extract_patterns`). Identical to the write key by
 * design — the stamped scope and the attributed scope must never disagree.
 * The Rust side validates it with `validate_memory_scope`, which accepts an
 * `ssh:` label as well as a local directory because neither command touches
 * the filesystem with this value and it never reaches the model.
 */
export function memoryAuxScopeArg(input: MemoryScopeInput): string {
  return memoryWriteKey(input);
}

function memoryScopeKey(scope: Required<MemoryBriefScope>): string {
  if (scope.kind === "ssh" && scope.serverId) {
    return remoteMemoryProjectKey(scope.serverId, scope.remotePath || scope.projectPath);
  }
  if (scope.workspaceId) return workspaceMemoryProjectKey(scope.workspaceId);
  return normalizePath(scope.projectPath);
}

/** True when a recorded `projectPath` is one of our synthetic scope keys
 *  rather than a filesystem path. */
export function isMemoryScopeKey(recorded: string | undefined | null): boolean {
  if (!recorded) return false;
  return recorded.startsWith("ssh:") || recorded.startsWith("workspace:");
}

/** Ids of records eligible for adoption into a remote scope. */
export interface LegacyRemoteMemoryCandidates {
  eventIds: string[];
  patternIds: string[];
}

/**
 * Records stamped with the PLAIN remote path (`/srv/app`) instead of the
 * `ssh:` scope key. They were written before remote scoping existed — a manual
 * capture from a remote agent transcript, for instance — and no ssh scope will
 * ever match them, so they are write-only-dead.
 *
 * We never rewrite them automatically. A plain `/srv/app` is indistinguishable
 * from a genuinely local project at `/srv/app`, and from the same path on a
 * DIFFERENT server; guessing would silently move user data between scopes. The
 * user adopts them explicitly, per scope, and `revertAdoptedRemoteMemory`
 * puts them back.
 */
export function findLegacyRemoteMemory(
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  scope: MemoryBriefScope,
): LegacyRemoteMemoryCandidates {
  const normalized = normalizeScopeInput(scope);
  if (normalized.kind !== "ssh" || !normalized.serverId) {
    return { eventIds: [], patternIds: [] };
  }
  const target = normalizePath(normalized.remotePath || normalized.projectPath);
  if (!target) return { eventIds: [], patternIds: [] };
  const isCandidate = (recorded: string | undefined | null): boolean =>
    !!recorded && !isMemoryScopeKey(recorded) && normalizePath(recorded) === target;
  return {
    eventIds: events.filter((e) => isCandidate(e.projectPath)).map((e) => e.id),
    patternIds: patterns.filter((p) => isCandidate(p.projectPath)).map((p) => p.id),
  };
}

/** Records previously adopted into `scope` that `revert` would put back. */
export function findAdoptedRemoteMemory(
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  scope: MemoryBriefScope,
): LegacyRemoteMemoryCandidates {
  const normalized = normalizeScopeInput(scope);
  if (normalized.kind !== "ssh" || !normalized.serverId) {
    return { eventIds: [], patternIds: [] };
  }
  const key = memoryWriteKey(scope);
  const isAdopted = (r: { projectPath?: string | null; legacyProjectPath?: string }): boolean =>
    typeof r.legacyProjectPath === "string" && r.projectPath === key;
  return {
    eventIds: events.filter(isAdopted).map((e) => e.id),
    patternIds: patterns.filter(isAdopted).map((p) => p.id),
  };
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

// Relevance scoring (memory retrieval Phase 1). Retrieval used to be
// task-blind — it injected the top-N highest-confidence patterns regardless of
// what was being built. When a task/objective `query` is available we score
// candidate memory text by IDF-weighted term overlap against the query and
// blend that with confidence, so the injected memory is relevant to the task.
const RELEVANCE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "is", "are", "be", "this", "that", "it", "as", "at", "by", "from", "into",
  "we", "you", "should", "add", "fix", "make", "use", "using", "when", "then",
  "so", "if", "not", "no", "do", "does", "the", "your", "our", "can", "will",
]);

function relevanceTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !RELEVANCE_STOPWORDS.has(t));
}

/**
 * IDF-weighted overlap of `query` against each candidate text. The corpus is
 * tiny (≤100 patterns), so we compute document frequency across the candidates
 * and reward a candidate for sharing the query's rarer terms. Returns a score
 * per candidate in [0, 1] — the fraction of the query's achievable IDF weight
 * the candidate covers. Query terms that appear in no candidate don't count
 * (they don't discriminate). Empty/degenerate query → all zeros, so the caller
 * falls back to the prior confidence-based ordering.
 */
export function relevanceScores(query: string, candidates: string[]): number[] {
  const zeros = candidates.map(() => 0);
  const qTokens = [...new Set(relevanceTokens(query))];
  if (qTokens.length === 0 || candidates.length === 0) return zeros;
  const candTokens = candidates.map((c) => new Set(relevanceTokens(c)));
  const n = candidates.length;
  const idf = new Map<string, number>();
  for (const t of qTokens) {
    let df = 0;
    for (const set of candTokens) if (set.has(t)) df += 1;
    if (df > 0) idf.set(t, Math.log(1 + n / df));
  }
  const scoredTokens = [...idf.keys()];
  const totalIdf = scoredTokens.reduce((s, t) => s + (idf.get(t) as number), 0);
  if (totalIdf <= 0) return zeros;
  return candTokens.map((set) => {
    let matched = 0;
    for (const t of scoredTokens) if (set.has(t)) matched += idf.get(t) as number;
    return matched / totalIdf;
  });
}

/** A query term's match against one candidate, best-rule-wins. */
export interface CorpusRelevance {
  /** 0..1 - fraction of the query's achievable IDF weight this candidate covers. */
  score: number;
  /** Query terms that hit, for "matched: auth, ssh" in the UI. */
  matched: string[];
}

/**
 * Domain acronyms this codebase writes both ways. Deliberately tiny and
 * factual: these are expansions, not synonyms.
 *
 * A curated SYNONYM map was evaluated and rejected — measured against a
 * held-out query set whose vocabulary the map did not contain, it recovered
 * 0% of misses while inflating result sets 2.75x. A lookup table only ever
 * answers the phrasings someone already guessed. Acronym expansion is a
 * different thing: it is a fact about the word, not a guess about intent.
 * Keep this list short, and do not let it grow into a synonym map.
 */
const CORPUS_ACRONYMS: Record<string, string[]> = {
  pty: ["pseudoterminal", "terminal"],
  acp: ["agent", "client", "protocol"],
  mcp: ["model", "context", "protocol"],
  idf: ["inverse", "document", "frequency"],
  dto: ["data", "transfer", "object"],
  sdk: ["software", "development", "kit"],
  cli: ["command", "line"],
  tofu: ["trust", "first", "use"],
  ssh: ["secure", "shell"],
  ade: ["agent", "development", "environment"],
};

/**
 * Ask-only tokenizer. Like `relevanceTokens` but (a) keeps 2-character tokens
 * ("db", "ci", "pr"), (b) splits camelCase and PascalCase runs, and (c)
 * expands a small set of domain acronyms.
 *
 * The camelCase split is the load-bearing part and is symmetric by
 * construction. Separators and paths were already split, so a prose query
 * found a camelCase document via the raw-substring rule — but the reverse did
 * not hold: `SshConfig` collapsed to one token, `ssh` was too short for the
 * prefix rule, and `"sshconfig"` is not a substring of "the ssh config record".
 * Users type symbols into the search box while agents write prose into
 * summaries, so that asymmetry was a real miss.
 *
 * Not used by the injection path — `relevanceScores` keeps its narrow
 * exact-token behaviour so widening search cannot widen what reaches a prompt.
 */
function corpusTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    if (token.length < 2 || RELEVANCE_STOPWORDS.has(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    push(lower);

    // `hostFingerprint` -> host, fingerprint. `SSHConfig` -> ssh, config.
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ")
      .filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) push(part.toLowerCase());
    }

    for (const token of parts.length > 1 ? [lower, ...parts.map((p) => p.toLowerCase())] : [lower]) {
      const expansion = CORPUS_ACRONYMS[token];
      if (expansion) for (const word of expansion) push(word);
    }
  }

  return out;
}

/** Crude English suffix strip, applied only when >=4 characters remain. */
function stem(token: string): string {
  const rules: Array<[string, string]> = [
    ["ies", "y"],
    ["ing", ""],
    ["ed", ""],
    ["es", ""],
    ["s", ""],
  ];
  for (const [suffix, replacement] of rules) {
    if (token.endsWith(suffix) && token.length - suffix.length + replacement.length >= 4) {
      return token.slice(0, token.length - suffix.length) + replacement;
    }
  }
  return token;
}

/** Best-rule-wins weight for one query term against one candidate. */
function termWeight(term: string, candTokens: Set<string>, candRaw: string): number {
  if (candTokens.has(term)) return 1;
  const qStem = stem(term);
  for (const c of candTokens) {
    if (stem(c) === qStem) return 1;
  }
  for (const c of candTokens) {
    const shorter = term.length <= c.length ? term : c;
    const longer = term.length <= c.length ? c : term;
    if (shorter.length >= 4 && longer.startsWith(shorter)) return 0.75;
  }
  if (candRaw.includes(term)) return 0.5;
  return 0;
}

/**
 * Ask-only sibling of `relevanceScores`. Same IDF shape, but a query term can
 * match by stem, prefix, or raw substring - not just exact token identity - so
 * "auth" finds "authentication".
 *
 * Deliberately separate from `relevanceScores`, which stays the injection
 * scorer: widening what Ask can find must never widen what gets injected into
 * an agent's prompt. Nothing on the injection path calls this.
 */
export function corpusRelevanceScores(query: string, candidates: string[]): CorpusRelevance[] {
  const empty = candidates.map(() => ({ score: 0, matched: [] as string[] }));
  const original = query.trim();
  const trimmed = original.toLowerCase();
  if (!trimmed || candidates.length === 0) return empty;

  const rawCandidates = candidates.map((c) => c.toLowerCase());
  // Tokenize from the ORIGINAL casing: lowercasing first would destroy the
  // camelCase boundaries `corpusTokens` splits on, so a `SshConfig` query
  // would never yield `ssh` + `config`. Candidates keep their casing too.
  const qTokens = [...new Set(corpusTokens(original))];

  // Degenerate query (all stopwords, or a single 1-char token): fall back to a
  // whole-phrase substring rather than returning zeros the way the injection
  // scorer does. Same "never lose a substring hit" contract as
  // `searchMemoryEvents`.
  if (qTokens.length === 0) {
    return rawCandidates.map((raw) =>
      raw.includes(trimmed) ? { score: 1, matched: [trimmed] } : { score: 0, matched: [] },
    );
  }

  const candTokenSets = candidates.map((c) => new Set(corpusTokens(c)));
  const n = candidates.length;

  // Weight per (term, candidate), then IDF over the terms that discriminate.
  const weights = qTokens.map((term) =>
    candTokenSets.map((set, i) => termWeight(term, set, rawCandidates[i])),
  );
  const idf = new Map<string, number>();
  qTokens.forEach((term, ti) => {
    const df = weights[ti].reduce((count, w) => count + (w > 0 ? 1 : 0), 0);
    if (df > 0) idf.set(term, Math.log(1 + n / df));
  });
  const scored = qTokens.filter((t) => idf.has(t));
  const totalIdf = scored.reduce((sum, t) => sum + (idf.get(t) as number), 0);
  if (totalIdf <= 0) return empty;

  return candidates.map((_, ci) => {
    let acc = 0;
    const matched: string[] = [];
    qTokens.forEach((term, ti) => {
      if (!idf.has(term)) return;
      const w = weights[ti][ci];
      if (w > 0) {
        acc += (idf.get(term) as number) * w;
        matched.push(term);
      }
    });
    const coverage = acc / totalIdf;
    // Phrase bonus with reserved headroom: a candidate containing the whole
    // query verbatim outranks one with the same terms scattered. Adding the
    // bonus on top of coverage would be invisible whenever coverage already
    // saturates at 1, which is the common case for short queries.
    const phrase = coverage > 0 && rawCandidates[ci].includes(trimmed);
    const score = coverage * 0.8 + (phrase ? 0.2 : 0);
    return { score: Math.max(0, Math.min(1, score)), matched };
  });
}

/**
 * M1: rank/filter memory events for the Timeline search box using the IDF
 * scorer (`relevanceScores`) instead of a naive substring match. Keeps any
 * substring hit (so no result the old search found is lost) but orders by
 * relevance, best first; chronological order (the caller's array order) is the
 * tie-break. A blank query returns the input unchanged.
 */
export function searchMemoryEvents<T extends { payload: unknown }>(
  events: T[],
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return events;
  const ql = q.toLowerCase();
  // `?? {}` guards against a malformed event whose payload is undefined —
  // JSON.stringify(undefined) returns undefined, and .toLowerCase() would throw.
  const candidates = events.map((e) => JSON.stringify(e.payload ?? {}).toLowerCase());
  const scores = relevanceScores(ql, candidates);
  return events
    .map((e, i) => ({ e, i, score: scores[i], substr: candidates[i].includes(ql) }))
    .filter((x) => x.score > 0 || x.substr)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.e);
}

export type MemoryDateRange = "all" | "24h" | "7d" | "30d";

const MEMORY_RANGE_MS: Record<Exclude<MemoryDateRange, "all">, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/**
 * M2: scope memory events by project path and/or a rolling date window. Pure;
 * `now` is injectable for tests. `project = null` and `dateRange = "all"` are
 * both no-ops, so this composes cleanly with the type + search filters.
 */
export function filterMemoryEventsByScope<
  T extends { projectPath?: string | null; timestamp: number },
>(
  events: T[],
  opts: { project?: string | null; dateRange?: MemoryDateRange; now?: number },
): T[] {
  const { project = null, dateRange = "all", now = Date.now() } = opts;
  const cutoff = dateRange === "all" ? null : now - MEMORY_RANGE_MS[dateRange];
  return events.filter((e) => {
    if (project && e.projectPath !== project) return false;
    if (cutoff !== null && e.timestamp < cutoff) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * M3 — export / import.
 * ------------------------------------------------------------------ */

/** M3: stable, import-round-trippable JSON export of the memory corpus. */
export function serializeMemoryExport(events: MemoryEvent[], patterns: LearnedPattern[]): string {
  return JSON.stringify({ version: 1, events, patterns }, null, 2);
}

const IMPORTABLE_EVENT_TYPES = new Set<MemoryEventType>([
  "session_completed",
  "task_completed",
  "flight_completed",
  "manual_note",
]);

/** A structurally-valid MemoryEvent: correct id/type/timestamp and an object
 *  payload. This is the import trust boundary — a malformed entry (e.g. a
 *  `flight_completed` with no `payload.lessonsLearned`) would otherwise crash
 *  the digest / hint / search consumers that assume the shape. */
function isValidMemoryEvent(e: unknown): e is MemoryEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.id === "string" &&
    typeof ev.timestamp === "number" &&
    IMPORTABLE_EVENT_TYPES.has(ev.type as MemoryEventType) &&
    typeof ev.payload === "object" &&
    ev.payload !== null
  );
}

/** M3: parse + validate a JSON memory export. Returns null on bad input. */
export function parseMemoryImport(
  json: string,
): { events: MemoryEvent[]; patterns: LearnedPattern[] } | null {
  try {
    const parsed = JSON.parse(json) as { events?: unknown; patterns?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    const patterns = Array.isArray(parsed.patterns) ? (parsed.patterns as LearnedPattern[]) : [];
    return {
      // Structurally validate events (untrusted import data); patterns only need
      // a string id to be a dedup candidate.
      events: events.filter(isValidMemoryEvent).map((event) => ({
        ...event,
        provenance:
          event.provenance ??
          unknownProvenance(
            event.id,
            "Imported legacy memory event",
            event.timestamp,
          ),
      })),
      patterns: patterns
        .filter((p) => p && typeof p.id === "string")
        .map((pattern) => ({
          ...pattern,
          provenance:
            pattern.provenance ??
            unknownProvenance(
              pattern.id,
              "Imported legacy learned pattern",
              pattern.extractedAt,
            ),
        })),
    };
  } catch {
    return null;
  }
}

/**
 * M3: merge imported events/patterns into the current corpus, deduped by id
 * (existing entries win). Returns the merged arrays plus counts of new items.
 */
export function mergeMemoryImport(
  current: { events: MemoryEvent[]; patterns: LearnedPattern[] },
  imported: { events: MemoryEvent[]; patterns: LearnedPattern[] },
): {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  addedEvents: number;
  addedPatterns: number;
} {
  const merge = <T extends { id: string }>(
    existing: T[],
    incoming: T[],
  ): { merged: T[]; added: number } => {
    const map = new Map(existing.map((x) => [x.id, x]));
    let added = 0;
    for (const x of incoming) {
      if (!map.has(x.id)) {
        map.set(x.id, x);
        added++;
      }
    }
    return { merged: [...map.values()], added };
  };
  const e = merge(current.events, imported.events);
  const p = merge(current.patterns, imported.patterns);
  return { events: e.merged, patterns: p.merged, addedEvents: e.added, addedPatterns: p.added };
}

/** M3: a human-readable Markdown digest of the memory corpus.
 *
 *  `labelScope` resolves a stored scope key to display text. Without it the
 *  scope breakdown would print raw `ssh:<serverId>:<path>` keys, so the section
 *  is only emitted when a resolver is supplied (which the Memory pane does). */
export function serializeMemoryMarkdown(
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  options: { labelScope?: (key: string) => string } = {},
): string {
  const lines: string[] = ["# PacketBench memory export", ""];
  const byType = new Map<string, number>();
  for (const ev of events) byType.set(ev.type, (byType.get(ev.type) ?? 0) + 1);
  lines.push(`- Events: ${events.length}`);
  for (const [t, n] of byType) lines.push(`  - ${t}: ${n}`);
  lines.push(`- Learned patterns: ${patterns.length}`, "");

  const labelScope = options.labelScope;
  if (labelScope) {
    const byScope = new Map<string, number>();
    for (const ev of events) {
      if (!ev.projectPath) continue;
      byScope.set(ev.projectPath, (byScope.get(ev.projectPath) ?? 0) + 1);
    }
    if (byScope.size > 0) {
      lines.push("## Scopes", "");
      for (const [key, n] of [...byScope].sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${labelScope(key)}: ${n} event${n === 1 ? "" : "s"}`);
      }
      lines.push("");
    }
  }

  if (patterns.length) {
    const byCat = new Map<string, LearnedPattern[]>();
    for (const p of patterns) {
      const arr = byCat.get(p.category) ?? [];
      arr.push(p);
      byCat.set(p.category, arr);
    }
    lines.push("## Learned patterns", "");
    for (const [cat, ps] of byCat) {
      lines.push(`### ${cat}`, "");
      for (const p of [...ps].sort((a, b) => b.confidence - a.confidence)) {
        lines.push(`- ${p.pinned ? "📌 " : ""}(${Math.round(p.confidence * 100)}%) ${p.pattern}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * M5 — outcome-based confidence rerating.
 * ------------------------------------------------------------------ */

// A pattern that was injected into a flight's brief earns a small confidence
// bump when that flight succeeds and a steeper decay when it fails — a burned
// pattern loses trust faster than an unproven one earns it. Both are clamped.
const CONFIDENCE_BUMP = 0.05;
const CONFIDENCE_DECAY = 0.1;
const CONFIDENCE_FLOOR = 0.1;
const CONFIDENCE_CEIL = 1;

/** M5: pure — the new confidence after an outcome, clamped to [floor, 1]. */
export function rerateConfidence(current: number, success: boolean): number {
  const next = success ? current + CONFIDENCE_BUMP : current - CONFIDENCE_DECAY;
  return Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEIL, next));
}

/**
 * M5: pure — rerate every pattern whose id is in `injectedIds` by the flight's
 * outcome, returning a new array. Untouched entries are preserved by reference
 * so a no-op rerate leaves the array referentially stable per-element.
 */
export function applyConfidenceRerate(
  patterns: LearnedPattern[],
  injectedIds: Iterable<string>,
  success: boolean,
): LearnedPattern[] {
  const idSet = new Set(injectedIds);
  if (idSet.size === 0) return patterns;
  return patterns.map((p) => {
    if (!idSet.has(p.id)) return p;
    const confidence = rerateConfidence(p.confidence, success);
    return confidence === p.confidence ? p : { ...p, confidence };
  });
}

// In-session provenance: which learned-pattern ids were injected into each
// flight's launch brief. Deliberately NOT persisted — rerating is best-effort,
// and a flight that only settles in a later session simply goes unrerated
// rather than dragging a provenance map through the backend state schema.
const injectedPatternsByFlight = new Map<string, string[]>();

// Sessions with an enrichment pass in flight, keyed by sessionId. A single
// global `isLearning` boolean used to serve this purpose, which meant two
// panes closing together recorded only one session, and one hung provider
// call wedged capture for the rest of the app's lifetime.
const learningSessions = new Set<string>();

/** Ceiling on the aux-LLM summarize call so a hung provider can't wedge capture. */
const SUMMARIZE_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * v0.8-H: structured context items behind `composeMemoryBrief` (prompt
 * injection) and `memoryBriefStats`. Kept as an internal module helper — the
 * only external callers are the store methods above and the store's own unit
 * tests; no UI surface consumes it directly. (It also backed the rendered
 * `getContextForSession` preview until that method was removed as dead;
 * MemoryView now renders the same budgeted brief the launch pipeline injects.)
 *
 * When `query` (the task/objective text) is provided, patterns and lessons are
 * ranked by relevance-to-the-task blended with confidence, instead of purely by
 * confidence. Without a query, behaviour is unchanged.
 */
/** Decides whether a recorded item's `projectPath` belongs to a given scope. */
export type ProjectScopeMatcher = (recorded: string | undefined | null) => boolean;

/**
 * Extracted verbatim from `computeContextItems` so the Ask search path can
 * scope results with exactly the same rules the injection path uses, without
 * importing the injection path's caps and time windows.
 *
 * `matching` controls strictness:
 *   exact  - normalized path equality (historical behaviour)
 *   parent - either side is a prefix of the other, so sub-workspaces inherit
 *            memory from a parent project
 *   global - every project-scoped item matches
 *
 * Items with no `projectPath` (legacy / global) always match, except under an
 * SSH scope, which only ever matches memory explicitly keyed to that
 * workspace/server.
 */
export function createProjectScopeMatcher(
  input: string | MemoryBriefScope,
  options: { matching: MemoryProjectPathMatching },
): ProjectScopeMatcher {
  const scope = normalizeScopeInput(input);
  const normalizedCurrent = normalizePath(scope.projectPath);
  const explicitScopeKeys = new Set<string>();
  if (scope.workspaceId) {
    explicitScopeKeys.add(normalizePath(workspaceMemoryProjectKey(scope.workspaceId)));
  }
  if (scope.kind === "ssh" && scope.serverId) {
    explicitScopeKeys.add(
      normalizePath(remoteMemoryProjectKey(scope.serverId, scope.remotePath || scope.projectPath)),
    );
  }

  return (recorded: string | undefined | null): boolean => {
    if (scope.kind === "ssh") {
      if (!recorded) return false;
      return explicitScopeKeys.has(normalizePath(recorded));
    }

    if (!recorded) return true; // legacy/global item - always relevant
    if (explicitScopeKeys.has(normalizePath(recorded))) return true;
    // A synthetic scope key (`ssh:` / `workspace:`) matches by EXACT key
    // identity or not at all. Without this, `global` matching — and any
    // `parent` prefix collision — would pull another server's remote memory
    // into a local project's brief, which is the one thing ssh isolation must
    // never allow. Path-matching modes are about filesystem paths; a scope key
    // is not one.
    if (isMemoryScopeKey(recorded)) return false;
    if (options.matching === "global") return true;
    const recordedN = normalizePath(recorded);
    if (recordedN === normalizedCurrent) return true;
    if (options.matching === "parent") {
      const a = recordedN.endsWith("/") ? recordedN : recordedN + "/";
      const b = normalizedCurrent.endsWith("/") ? normalizedCurrent : normalizedCurrent + "/";
      return a.startsWith(b) || b.startsWith(a);
    }
    return false;
  };
}

export function computeContextItems(
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  input: string | ({ sessionId?: string } & MemoryBriefScope),
  query?: string,
  /** Durable `.agents/memory` notes for this project. These are hand-authored
   *  and long-lived, so unlike sessions they carry no recency window. */
  notes: ProjectMemoryNote[] = [],
): ContextItem[] {
  const hasQuery = Boolean(query && query.trim());
  const scope = normalizeScopeInput(input);
  if (!scope.projectPath) return [];

  const settings = getMemorySettings();
  const projectPathsMatch = createProjectScopeMatcher(scope, {
    matching: settings.projectPathMatching,
  });
  const out: ContextItem[] = [];

  // 1. Learned patterns. Pinned patterns sort first and are exempt
  //    from the confidence cutoff (the user pinned them, so we trust
  //    their judgment over a 0.6 numerical threshold). Patterns
  //    without a `projectPath` are legacy/global — they always match.
  //    Patterns with a `projectPath` are filtered through
  //    `projectPathsMatch` so the v0.8 matching mode is honoured.
  const filteredPatterns = patterns.filter((p) => {
    if (!projectPathsMatch(p.projectPath)) return false;
    return p.pinned || p.confidence >= 0.6;
  });
  // Relevance re-ranks the trusted set (the confidence gate above still decides
  // *what* is eligible); a query only changes the *order*, so we always inject
  // the most task-relevant of the patterns we already trust.
  const patternRel = hasQuery
    ? relevanceScores(
        query as string,
        filteredPatterns.map((p) => `${p.category} ${p.pattern}`),
      )
    : null;
  const relevantPatterns = filteredPatterns
    .map((p, i) => ({ p, rel: patternRel ? patternRel[i] : 0 }))
    .sort((a, b) => {
      if ((a.p.pinned ? 1 : 0) !== (b.p.pinned ? 1 : 0)) {
        return a.p.pinned ? -1 : 1;
      }
      if (patternRel) {
        const as = 0.6 * a.rel + 0.4 * a.p.confidence;
        const bs = 0.6 * b.rel + 0.4 * b.p.confidence;
        if (as !== bs) return bs - as;
      } else if (a.p.confidence !== b.p.confidence) {
        return b.p.confidence - a.p.confidence;
      }
      return b.p.extractedAt - a.p.extractedAt;
    })
    .slice(0, settings.contextMaxPatterns);

  for (const { p, rel } of relevantPatterns) {
    const patternScope = p.projectPath ? "this project" : "all projects";
    const lead = p.pinned
      ? "Pinned"
      : patternRel && rel > 0
        ? "Relevant to task"
        : "Top pattern";
    out.push({
      id: p.id,
      kind: "pattern",
      title: `[${p.category}] ${p.pattern}`,
      timestamp: p.extractedAt,
      reason: `${lead} · ${patternScope} · confidence ${(p.confidence * 100).toFixed(0)}%`,
    });
  }

  // 2. Lessons from flight retrospectives (last 7 days, current project)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const flightEvents = events.filter(
    (e): e is Extract<MemoryEvent, { type: "flight_completed" }> =>
      e.type === "flight_completed" && projectPathsMatch(e.projectPath) && e.timestamp > cutoff,
  );
  if (hasQuery) {
    // Rank all candidate lessons by relevance to the task, then take the top N.
    const candidates = flightEvents.flatMap((e) =>
      e.payload.lessonsLearned.map((text) => ({ text, timestamp: e.timestamp, eventId: e.id })),
    );
    const lessonRel = relevanceScores(
      query as string,
      candidates.map((c) => c.text),
    );
    candidates
      .map((c, i) => ({ c, rel: lessonRel[i] }))
      .sort((a, b) => b.rel - a.rel || b.c.timestamp - a.c.timestamp)
      .slice(0, settings.contextMaxLessons)
      .forEach(({ c, rel }, k) => {
        out.push({
          id: `${c.eventId}:lesson:${k}`,
          kind: "lesson",
          title: c.text,
          timestamp: c.timestamp,
          reason:
            rel > 0
              ? "Relevant lesson from a flight retrospective (last 7 days)"
              : "Lesson from flight retrospective (last 7 days)",
        });
      });
  } else {
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

  // 4. Durable project notes from `.agents/memory`. No recency window and no
  // confidence gate - a note exists because a human or an agent deliberately
  // wrote it down.
  const liveNotes = notes.filter((n) => !n.metadata.archived);
  if (liveNotes.length > 0) {
    const noteRel = hasQuery
      ? relevanceScores(
          query as string,
          liveNotes.map((n) => `${n.metadata.title} ${n.body} ${n.metadata.tags.join(" ")}`),
        )
      : null;
    liveNotes
      .map((n, i) => ({ n, rel: noteRel ? noteRel[i] : 0 }))
      .sort((a, b) => {
        if (noteRel && a.rel !== b.rel) return b.rel - a.rel;
        return (b.n.metadata.updatedAt ?? 0) - (a.n.metadata.updatedAt ?? 0);
      })
      .slice(0, settings.contextMaxNotes)
      .forEach(({ n, rel }) => {
        out.push({
          id: `note:${n.metadata.id}`,
          kind: "project_note",
          title: `${n.metadata.title}: ${normalizeBriefText(n.body, 200)}`,
          timestamp: n.metadata.updatedAt ?? 0,
          reason:
            noteRel && rel > 0
              ? "Relevant project note (.agents/memory)"
              : "Project note (.agents/memory)",
        });
      });
  }

  return out;
}

/**
 * Notes the project-memory store currently holds, but only when they belong to
 * the project being briefed. The store tracks one project at a time, so a stale
 * snapshot from a previously-open project must never leak into another
 * project's prompt.
 */
function projectNotesFor(scope: MemoryScopeInput): ProjectMemoryNote[] {
  const normalized = normalizeScopeInput(scope);
  // `.agents/memory` is read off THIS machine's filesystem, so it can only
  // ever belong to a local scope. Without this guard a local project that
  // happens to sit at the same path as a remote one (`/srv/app` on a Linux
  // workstation) would leak its notes into that remote workspace's brief.
  if (normalized.kind === "ssh") return [];
  const store = useProjectMemoryStore.getState();
  if (!store.projectPath) return [];
  if (normalizePath(store.projectPath) !== normalizePath(normalized.projectPath)) return [];
  return store.snapshot.notes;
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  events: [],
  patterns: [],
  lastPatternRefreshAt: null,
  summariesSinceLastRefresh: 0,
  isLearning: false,
  learningStatus: null,

  hydrateFromBackend: (persisted) => {
    const rawEvents = ((persisted.memoryEvents ?? []) as MemoryEvent[]).map(
      (event) => ({
        ...event,
        provenance:
          event.provenance ??
          unknownProvenance(event.id, "Legacy memory event", event.timestamp),
      }),
    );
    const rawPatterns = (
      (persisted.memoryPatterns ?? []) as LearnedPattern[]
    ).map((pattern) => ({
      ...pattern,
      provenance:
        pattern.provenance ??
        unknownProvenance(
          pattern.id,
          "Legacy learned pattern",
          pattern.extractedAt,
        ),
    }));
    const events = capEvents(rawEvents);
    const patterns = capPatterns(rawPatterns);

    // Rebuild the auto-extraction counter from persisted data. It used to
    // reset to 0 on every launch, so reaching `patternRefreshThreshold`
    // required N qualifying sessions inside a single app run - which in
    // practice never happened. `lastPatternRefreshAt` is not itself persisted,
    // so the newest pattern's extraction time stands in for it.
    const lastPatternRefreshAt = patterns.reduce<number | null>(
      (latest, p) => (latest === null || p.extractedAt > latest ? p.extractedAt : latest),
      null,
    );
    const summariesSinceLastRefresh = events.filter(
      (e) =>
        e.type === "session_completed" &&
        e.payload.summary !== null &&
        (lastPatternRefreshAt === null || e.timestamp > lastPatternRefreshAt),
    ).length;

    set({ events, patterns, lastPatternRefreshAt, summariesSinceLastRefresh });
    if (events.length !== rawEvents.length || patterns.length !== rawPatterns.length) {
      void persistState(events, patterns);
    }
  },

  captureFlightCompleted: (payload, scope) => {
    if (!getMemorySettings().captureFlights) return;
    const event = createEvent("flight_completed", memoryWriteKey(scope), payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  updateFlightRetrospective: (flightId, retro) => {
    let changed = false;
    const events = get().events.map((e) => {
      if (e.type !== "flight_completed" || e.payload.flightId !== flightId) return e;
      changed = true;
      return { ...e, payload: { ...e.payload, ...retro } };
    });
    if (!changed) return;
    set({ events });
    void persistState(events, get().patterns);
  },

  recordInjectedPatterns: (flightId, patternIds) => {
    if (patternIds.length === 0) return;
    // Union with any prior record: a flight can be launched more than once
    // (e.g. extra attempts added later) with different injected sets, and every
    // pattern that ever rode along should be eligible for rerating.
    const prior = injectedPatternsByFlight.get(flightId);
    const merged = prior ? [...new Set([...prior, ...patternIds])] : patternIds;
    injectedPatternsByFlight.set(flightId, merged);
  },

  clearInjectedPatterns: (flightId) => {
    injectedPatternsByFlight.delete(flightId);
  },

  adjustConfidenceForFlight: (flightId, success) => {
    const ids = injectedPatternsByFlight.get(flightId);
    if (!ids || ids.length === 0) return;
    injectedPatternsByFlight.delete(flightId);
    const patterns = applyConfidenceRerate(get().patterns, ids, success);
    set({ patterns });
    void persistState(get().events, patterns);
  },

  captureManually: ({
    scope,
    source,
    summary,
    body,
    tags,
    provenance,
  }) => {
    // v0.8-D — bypass the per-type capture toggles: this is an explicit
    // human action ("Save as memory"), not a passive auto-capture.
    const payload: ManualNotePayload = {
      source,
      summary,
      body,
      tags: tags && tags.length > 0 ? tags : [source],
    };
    const event = createEvent(
      "manual_note",
      memoryWriteKey(scope),
      payload,
      provenance,
    );
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
    return event;
  },

  learnFromSession: async (sessionId, agentId, scope, durationMs, status = "done") => {
    // The scope is resolved once, here: the stamped key and the aux-LLM
    // argument must never disagree about which project this session belongs to.
    const writeKey = memoryWriteKey(scope);
    const settings = getMemorySettings();
    if (!settings.captureSessions) return;
    // Per-session guard: two panes closing together must both be recorded, and
    // a wedged enrichment call must not silently drop every later session.
    if (learningSessions.has(sessionId)) return;
    // Idempotent per session: the natural-exit path and the unmount path can
    // both fire for one session under a close/exit race, and a session must
    // appear in the timeline exactly once.
    if (
      get().events.some(
        (e) => e.type === "session_completed" && e.payload.sessionId === sessionId,
      )
    ) {
      return;
    }
    learningSessions.add(sessionId);

    // --- Phase 1: record the bare event. No network, no LLM, no failure mode.
    const event = createEvent("session_completed", writeKey, {
      sessionId,
      agentId,
      durationMs,
      status,
      summary: null,
      filesModified: [],
      keyDecisions: [],
    });
    set({ events: capEvents([...get().events, event]) });
    void persistState(get().events, get().patterns);

    if (!settings.summarizeSessions) {
      learningSessions.delete(sessionId);
      return;
    }

    // --- Phase 2: best-effort enrichment. Any failure leaves the phase-1
    // event in place and surfaces the reason in the Memory header.
    set({ isLearning: true, learningStatus: "Reading session transcript..." });
    try {
      const transcript = await readPtyTranscript(sessionId);
      if (!transcript?.data?.trim()) {
        set({ isLearning: false, learningStatus: null });
        return;
      }

      // Trim transcript to last ~4000 chars to avoid blowing up the LLM call
      const trimmedTranscript =
        transcript.data.length > 4000 ? transcript.data.slice(-4000) : transcript.data;

      set({ learningStatus: "Summarizing session..." });
      const summaryResult = await withTimeout(
        summarizeSession(memoryAuxScopeArg(scope), trimmedTranscript),
        SUMMARIZE_TIMEOUT_MS,
        "Summarization timed out",
      );
      const parsed = parseJsonFromResponse(summaryResult) as {
        summary: string;
        keyDecisions: string[];
        filesModified: string[];
      };

      if (!parsed?.summary) {
        set({ isLearning: false, learningStatus: null });
        return;
      }

      // Patch the phase-1 event in place rather than appending a second one.
      const events = get().events.map((e) =>
        e.id === event.id && e.type === "session_completed"
          ? {
              ...e,
              payload: {
                ...e.payload,
                summary: parsed.summary,
                filesModified: parsed.filesModified ?? [],
                keyDecisions: parsed.keyDecisions ?? [],
              },
            }
          : e,
      );
      const count = get().summariesSinceLastRefresh + 1;
      set({ events, summariesSinceLastRefresh: count, learningStatus: null });

      // Auto-extract patterns if threshold met
      if (settings.extractPatterns && count >= settings.patternRefreshThreshold) {
        set({ learningStatus: "Extracting patterns..." });
        await get().refreshPatterns(scope);
      }

      set({ isLearning: false, learningStatus: null });
      void persistState(get().events, get().patterns);
    } catch (e) {
      // The session itself is already recorded; only the summary is missing.
      // Say so instead of failing silently into an empty-looking pane.
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("Memory summarization failed:", e);
      set({
        isLearning: false,
        learningStatus: `Session recorded, but summarizing failed: ${reason}`,
      });
    } finally {
      learningSessions.delete(sessionId);
    }
  },

  refreshPatterns: async (scope) => {
    const { events } = get();
    // Extraction is keyed on the WRITE key, not the display path: under a
    // remote scope the corpus is the `ssh:<server>:<path>` records, and the
    // patterns it produces are stamped with the same key so they can only be
    // retrieved back into that same remote workspace.
    const writeKey = memoryWriteKey(scope);
    const normalizedPath = normalizePath(writeKey);
    const inProject = events.filter(
      (e) => normalizePath(e.projectPath) === normalizedPath,
    );

    // Corpus for extraction. This used to be session summaries ONLY, so a user
    // whose memory consisted of manual notes and flight retrospectives could
    // never extract a single pattern. Everything the user deliberately kept is
    // fair source material.
    const summaries = inProject
      .flatMap((e) => {
        if (e.type === "session_completed") {
          return e.payload.summary ? [e.payload.summary] : [];
        }
        if (e.type === "manual_note") {
          return [`${e.payload.summary}\n${e.payload.body}`];
        }
        if (e.type === "flight_completed") {
          return [
            [e.payload.summary, ...e.payload.lessonsLearned].filter(Boolean).join("\n"),
          ];
        }
        return [];
      })
      .slice(-10)
      .join("\n---\n");

    if (!summaries.trim()) {
      set({
        learningStatus:
          "Nothing to learn from yet for this project - finish a session or save a note first.",
      });
      return;
    }

    set({ isLearning: true, learningStatus: "Extracting patterns..." });
    try {
      const result = await extractPatterns(memoryAuxScopeArg(scope), summaries);
      const parsed = parseJsonFromResponse(result) as {
        pattern: string;
        category: string;
        confidence: number;
      }[];

      if (!Array.isArray(parsed)) {
        set({ isLearning: false, learningStatus: "The model returned an unusable pattern list." });
        return;
      }

      const newPatterns: LearnedPattern[] = parsed
        .filter((p) => p.pattern && p.confidence >= 0.5)
        .slice(0, getMemorySettings().maxPatterns)
        .map((p) => {
          const id = generateId("pat");
          const extractedAt = Date.now();
          const parents = events
            .filter(
              (event) =>
                event.type === "session_completed" &&
                normalizePath(event.projectPath) === normalizedPath,
            )
            .slice(-10)
            .flatMap((event) => (event.provenance ? [event.provenance] : []));
          return {
          id,
          pattern: p.pattern,
          category: (p.category as LearnedPattern["category"]) ?? "convention",
          confidence: p.confidence,
          extractedAt,
          // v0.8-H — stamp the scope so patterns no longer leak across
          // workspaces. Source events were already filtered by
          // `normalizedPath` above so this is the right scope to attribute.
          projectPath: writeKey,
          pinned: false,
          provenance: memoryRecordProvenance(
            id,
            "Learned memory pattern",
            parents,
            extractedAt,
          ),
        };
        });

      // v0.8-H — preserve pinned patterns from the previous extraction
      // (they're authoritative and shouldn't disappear when we re-extract).
      const existing = get().patterns;
      const pinnedFromBefore = existing.filter((p) => p.pinned);
      const patterns = capPatterns([...pinnedFromBefore, ...newPatterns]);
      set({
        patterns,
        lastPatternRefreshAt: Date.now(),
        summariesSinceLastRefresh: 0,
        isLearning: false,
        learningStatus:
          newPatterns.length === 0
            ? "No patterns met the confidence threshold this time."
            : null,
      });
      void persistState(get().events, patterns);
    } catch (e) {
      // Surface it. A silent console.warn here is why Refresh reads as a dead
      // button when no aux LLM provider is configured.
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("Pattern extraction failed:", e);
      set({ isLearning: false, learningStatus: `Pattern extraction failed: ${reason}` });
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

  adoptLegacyRemoteMemory: (scope) => {
    const { events, patterns } = get();
    const found = findLegacyRemoteMemory(events, patterns, scope);
    const eventIds = new Set(found.eventIds);
    const patternIds = new Set(found.patternIds);
    if (eventIds.size === 0 && patternIds.size === 0) return 0;
    const key = memoryWriteKey(scope);
    // `legacyProjectPath` is written once and only once: if a record was
    // somehow adopted before, its ORIGINAL path is what revert must restore.
    const nextEvents = events.map((e) =>
      eventIds.has(e.id)
        ? { ...e, projectPath: key, legacyProjectPath: e.legacyProjectPath ?? e.projectPath }
        : e,
    );
    const nextPatterns = patterns.map((p) =>
      patternIds.has(p.id)
        ? { ...p, projectPath: key, legacyProjectPath: p.legacyProjectPath ?? p.projectPath }
        : p,
    );
    set({ events: nextEvents, patterns: nextPatterns });
    void persistState(nextEvents, nextPatterns);
    return eventIds.size + patternIds.size;
  },

  revertAdoptedRemoteMemory: (scope) => {
    const { events, patterns } = get();
    const found = findAdoptedRemoteMemory(events, patterns, scope);
    const eventIds = new Set(found.eventIds);
    const patternIds = new Set(found.patternIds);
    if (eventIds.size === 0 && patternIds.size === 0) return 0;
    const restore = <T extends { id: string; projectPath?: string; legacyProjectPath?: string }>(
      record: T,
      ids: Set<string>,
    ): T => {
      if (!ids.has(record.id) || record.legacyProjectPath === undefined) return record;
      const { legacyProjectPath, ...rest } = record;
      return { ...rest, projectPath: legacyProjectPath } as T;
    };
    const nextEvents = events.map((e) => restore(e, eventIds));
    const nextPatterns = patterns.map((p) => restore(p, patternIds));
    set({ events: nextEvents, patterns: nextPatterns });
    void persistState(nextEvents, nextPatterns);
    return eventIds.size + patternIds.size;
  },

  importMemory: (json) => {
    const parsed = parseMemoryImport(json);
    if (!parsed) return null;
    const merged = mergeMemoryImport({ events: get().events, patterns: get().patterns }, parsed);
    const events = capEvents(merged.events);
    const patterns = capPatterns(merged.patterns);
    set({ events, patterns });
    void persistState(events, patterns);
    return { addedEvents: merged.addedEvents, addedPatterns: merged.addedPatterns };
  },

  composeMemoryBrief: (input, options) => {
    const scope = normalizeScopeInput(input);
    const charBudget = clampBriefChars(options?.maxChars);
    const items = computeContextItems(
      get().events,
      get().patterns,
      scope,
      options?.query,
      projectNotesFor(scope),
    );
    const scopeKey = memoryScopeKey(scope);
    if (items.length === 0) {
      return { text: "", items: [], charBudget, truncated: false, scopeKey };
    }

    const lines: string[] = [
      "## PacketBench Memory Brief",
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
      ["project_note", "Project notes"],
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
