// Ask-tab retrieval over the FULL memory corpus.
//
// This module exists because the Ask tab used to search `computeContextItems`
// — the prompt-injection *budget selector*. That selector deliberately drops
// low-confidence patterns, caps each source, and windows flight lessons to 7
// days and session summaries to 48 hours, because those are the right rules
// for deciding what fits in a prompt. They are the wrong rules for a search
// box: anything older than two days was simply invisible, and asking about a
// note you wrote last week answered "Nothing relevant found".
//
// So search and injection are now separate paths over the same data. Nothing
// here is imported by the injection path, and this module has no notion of a
// character budget.

import {
  createProjectScopeMatcher,
  corpusRelevanceScores,
  type MemoryBriefScope,
} from "@/stores/memoryStore";
import { getMemorySettings } from "@/stores/memorySettingsStore";
import type { LearnedPattern, MemoryEvent } from "@/types/memory";
import type { ProjectMemoryNote } from "@/types/project-memory";

export type MemorySourceFilter = "all" | "global" | "project";

export type MemorySearchKind =
  | "pattern"
  | "lesson"
  | "flight"
  | "session"
  | "manual_note"
  | "task"
  | "project_note";

export const MEMORY_SEARCH_KIND_LABEL: Record<MemorySearchKind, string> = {
  pattern: "Learned pattern",
  lesson: "Flight lesson",
  flight: "Flight retrospective",
  session: "Session summary",
  manual_note: "Saved note",
  task: "Task (legacy)",
  project_note: "Project note",
};

export interface MemorySearchEntry {
  id: string;
  source: "global" | "project";
  kind: MemorySearchKind;
  /** One-line display text. */
  title: string;
  /** Secondary excerpt, "" when there is none. */
  detail: string;
  /** Full searchable text. */
  text: string;
  timestamp: number;
  /** 0..1 — a light ranking prior, never an eligibility gate. */
  trust: number;
  provenanceIds: string[];
  projectPath?: string;
}

export interface MemorySearchCounts {
  patterns: number;
  events: number;
  notes: number;
  /** Total scored entries — events fan out into more than one entry. */
  entries: number;
}

export interface MemorySearchResult extends MemorySearchEntry {
  score: number;
  relevance: number;
  matchedTerms: string[];
}

export interface MemorySearchOutcome {
  results: MemorySearchResult[];
  /** What was actually searched, after the source filter. */
  counts: MemorySearchCounts;
  /** Eligible matches before `limit` was applied. */
  totalMatches: number;
  truncated: boolean;
}

const DEFAULT_LIMIT = 50;

/** Kind priors reorder equally-relevant hits; they never create one. */
const KIND_PRIOR: Record<MemorySearchKind, number> = {
  pattern: 1.0,
  project_note: 1.0,
  lesson: 0.9,
  manual_note: 0.8,
  flight: 0.6,
  session: 0.5,
  task: 0.4,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function oneLine(text: string, max = 160): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Every memory item in scope, with no relevance filtering, no caps and no time
 * windows. Scope matching reuses the injection path's own matcher so search and
 * injection agree about which project an item belongs to.
 */
export function buildMemorySearchCorpus(
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  notes: ProjectMemoryNote[],
  scope: string | MemoryBriefScope,
  options: { includeAllProjects?: boolean } = {},
): MemorySearchEntry[] {
  const matches = createProjectScopeMatcher(scope, {
    matching: options.includeAllProjects ? "global" : getMemorySettings().projectPathMatching,
  });
  const out: MemorySearchEntry[] = [];

  for (const p of patterns) {
    if (!matches(p.projectPath)) continue;
    out.push({
      id: `pattern:${p.id}`,
      source: "global",
      kind: "pattern",
      title: `[${p.category}] ${p.pattern}`,
      detail: "",
      text: `${p.category} ${p.pattern}`,
      timestamp: p.extractedAt,
      trust: p.pinned ? 1 : clamp01(p.confidence),
      provenanceIds: [],
      projectPath: p.projectPath,
    });
  }

  for (const e of events) {
    if (!matches(e.projectPath)) continue;
    const provenanceIds = e.provenance ? [e.id] : [];

    if (e.type === "flight_completed") {
      const p = e.payload;
      p.lessonsLearned.forEach((lesson, i) => {
        out.push({
          id: `lesson:${e.id}:${i}`,
          source: "global",
          kind: "lesson",
          title: oneLine(lesson),
          detail: "",
          text: lesson,
          timestamp: e.timestamp,
          trust: 1,
          provenanceIds,
          projectPath: e.projectPath,
        });
      });
      // The retrospective itself was previously unsearchable: only
      // `lessonsLearned` was ever mined, so summary/whatWorked/whatFailed were
      // invisible to Ask.
      const flightText = [
        p.flightTitle,
        p.summary,
        ...p.whatWorked,
        ...p.whatFailed,
        ...p.suggestedImprovements,
        ...p.tags,
      ]
        .filter(Boolean)
        .join("\n");
      out.push({
        id: `flight:${e.id}`,
        source: "global",
        kind: "flight",
        title: oneLine(p.summary || p.flightTitle),
        detail: excerpt(p.flightTitle),
        text: flightText,
        timestamp: e.timestamp,
        trust: 1,
        provenanceIds,
        projectPath: e.projectPath,
      });
      continue;
    }

    if (e.type === "session_completed") {
      const p = e.payload;
      if (!p.summary) continue;
      out.push({
        id: `session:${e.id}`,
        source: "global",
        kind: "session",
        title: oneLine(p.summary),
        detail: excerpt(p.keyDecisions.join(" · ")),
        text: [p.summary, ...p.keyDecisions, ...p.filesModified].join("\n"),
        timestamp: e.timestamp,
        trust: 1,
        provenanceIds,
        projectPath: e.projectPath,
      });
      continue;
    }

    if (e.type === "manual_note") {
      // Saved notes had no branch in `computeContextItems` at all, so the
      // events produced by the pane's own "New memory" button were
      // unsearchable.
      const p = e.payload;
      out.push({
        id: `note:${e.id}`,
        source: "global",
        kind: "manual_note",
        title: oneLine(p.summary),
        detail: excerpt(p.body),
        text: [p.summary, p.body, ...p.tags].join("\n"),
        timestamp: e.timestamp,
        trust: 1,
        provenanceIds,
        projectPath: e.projectPath,
      });
      continue;
    }

    if (e.type === "task_completed") {
      const p = e.payload;
      out.push({
        id: `task:${e.id}`,
        source: "global",
        kind: "task",
        title: oneLine(p.taskTitle || p.summary),
        detail: excerpt(p.summary),
        text: [p.taskTitle, p.summary, ...p.errors].filter(Boolean).join("\n"),
        timestamp: e.timestamp,
        trust: 1,
        provenanceIds,
        projectPath: e.projectPath,
      });
    }
  }

  for (const note of notes) {
    if (note.metadata.archived) continue;
    out.push({
      id: `project_note:${note.metadata.id}`,
      source: "project",
      kind: "project_note",
      title: note.metadata.title,
      detail: excerpt(note.body),
      text: [note.metadata.title, note.body, ...note.metadata.tags].join("\n"),
      timestamp: note.metadata.updatedAt ?? 0,
      trust: 1,
      provenanceIds: note.metadata.provenanceIds,
    });
  }

  return out;
}

/**
 * Rank a prepared corpus against a query. Eligibility is `relevance > 0` and
 * nothing else — the kind/recency/trust priors only reorder hits, so a stale
 * low-confidence item that genuinely matches can never be filtered away.
 */
export function searchMemoryCorpus(
  query: string,
  corpus: MemorySearchEntry[],
  options: { source?: MemorySourceFilter; limit?: number; now?: number } = {},
): MemorySearchOutcome {
  const source = options.source ?? "all";
  const limit = options.limit ?? DEFAULT_LIMIT;
  const now = options.now ?? Date.now();

  const scoped = corpus.filter((e) =>
    source === "all" ? true : source === "project" ? e.source === "project" : e.source === "global",
  );

  const counts: MemorySearchCounts = {
    patterns: scoped.filter((e) => e.kind === "pattern").length,
    events: new Set(
      scoped
        .filter((e) => e.source === "global" && e.kind !== "pattern")
        .map((e) => e.id.split(":").slice(1).join(":")),
    ).size,
    notes: scoped.filter((e) => e.kind === "project_note").length,
    entries: scoped.length,
  };

  const q = query.trim();
  if (!q || scoped.length === 0) {
    return { results: [], counts, totalMatches: 0, truncated: false };
  }

  const relevance = corpusRelevanceScores(
    q,
    scoped.map((e) => e.text),
  );

  const eligible: MemorySearchResult[] = [];
  scoped.forEach((entry, i) => {
    const rel = relevance[i];
    if (rel.score <= 0) return;
    const ageDays = entry.timestamp > 0 ? (now - entry.timestamp) / 86_400_000 : Infinity;
    const recency = Number.isFinite(ageDays) ? Math.exp(-Math.max(0, ageDays) / 60) : 0;
    const score =
      0.7 * rel.score + 0.15 * KIND_PRIOR[entry.kind] + 0.1 * recency + 0.05 * entry.trust;
    eligible.push({ ...entry, score, relevance: rel.score, matchedTerms: rel.matched });
  });

  eligible.sort(
    (a, b) => b.score - a.score || b.timestamp - a.timestamp || a.title.localeCompare(b.title),
  );

  // Dedupe by display title, keeping the best-scoring (the sort guarantees the
  // first occurrence is the best).
  const seen = new Set<string>();
  const deduped = eligible.filter((r) => {
    const key = r.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const results = deduped.slice(0, limit);
  return {
    results,
    counts,
    totalMatches: deduped.length,
    truncated: deduped.length > results.length,
  };
}

/** The single entry point the Ask tab calls. */
export function askMemory(
  query: string,
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  notes: ProjectMemoryNote[],
  scope: string | MemoryBriefScope,
  options: {
    source?: MemorySourceFilter;
    limit?: number;
    includeAllProjects?: boolean;
    now?: number;
  } = {},
): MemorySearchOutcome {
  const corpus = buildMemorySearchCorpus(events, patterns, notes, scope, {
    includeAllProjects: options.includeAllProjects,
  });
  return searchMemoryCorpus(query, corpus, {
    source: options.source,
    limit: options.limit,
    now: options.now,
  });
}

/** "12 patterns, 48 events and 3 project notes" — for legible zero-result copy. */
export function memorySearchCountPhrase(counts: MemorySearchCounts): string {
  const parts: string[] = [];
  if (counts.patterns > 0) {
    parts.push(`${counts.patterns} pattern${counts.patterns === 1 ? "" : "s"}`);
  }
  if (counts.events > 0) parts.push(`${counts.events} event${counts.events === 1 ? "" : "s"}`);
  if (counts.notes > 0) {
    parts.push(`${counts.notes} project note${counts.notes === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
