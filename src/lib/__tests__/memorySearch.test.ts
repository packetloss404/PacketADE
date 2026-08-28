import { describe, expect, it } from "vitest";
import { askMemory, memorySearchCountPhrase, searchMemoryCorpus } from "@/lib/memorySearch";
import { buildMemorySearchCorpus } from "@/lib/memorySearch";
import type { LearnedPattern, MemoryEvent } from "@/types/memory";
import type { ProjectMemoryNote } from "@/types/project-memory";

const PROJECT = "D:/projects/example";
const OTHER = "D:/projects/other";
const DAY = 86_400_000;

function pattern(over: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    id: `pat-${Math.random().toString(36).slice(2)}`,
    pattern: "Use the shared Modal wrapper",
    category: "convention",
    confidence: 0.9,
    extractedAt: Date.now(),
    projectPath: PROJECT,
    pinned: false,
    ...over,
  } as LearnedPattern;
}

function sessionEvent(summary: string, timestamp = Date.now()): MemoryEvent {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    type: "session_completed",
    timestamp,
    projectPath: PROJECT,
    payload: {
      sessionId: "sid",
      agentId: "claude",
      durationMs: 1000,
      status: "done",
      summary,
      filesModified: [],
      keyDecisions: [],
    },
  } as MemoryEvent;
}

function manualNote(summary: string, body = ""): MemoryEvent {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    type: "manual_note",
    timestamp: Date.now(),
    projectPath: PROJECT,
    payload: { source: "manual", summary, body, tags: ["manual"] },
  } as MemoryEvent;
}

function flightEvent(over: Record<string, unknown> = {}, timestamp = Date.now()): MemoryEvent {
  return {
    id: `f-${Math.random().toString(36).slice(2)}`,
    type: "flight_completed",
    timestamp,
    projectPath: PROJECT,
    payload: {
      flightId: "fl-1",
      flightTitle: "Auth rework",
      summary: "Reworked the login flow",
      whatWorked: [],
      whatFailed: [],
      lessonsLearned: [],
      suggestedImprovements: [],
      tags: [],
      ...over,
    },
  } as MemoryEvent;
}

function note(title: string, body: string, archived = false): ProjectMemoryNote {
  return {
    metadata: {
      schemaVersion: 1,
      id: `n-${title}`,
      title,
      createdAt: 1,
      updatedAt: 2,
      archived,
      tags: [],
      provenanceIds: [],
    },
    body,
    revision: "r",
    relativePath: `.agents/memory/${title}.md`,
    outboundIds: [],
    backlinkIds: [],
    brokenLinks: [],
    orphaned: false,
  };
}

function ask(query: string, opts: Parameters<typeof askMemory>[5] = {}) {
  return (events: MemoryEvent[], patterns: LearnedPattern[], notes: ProjectMemoryNote[]) =>
    askMemory(query, events, patterns, notes, { kind: "local", projectPath: PROJECT }, opts);
}

describe("memory search corpus", () => {
  it("includes low-confidence, unpinned patterns the injection budget drops", () => {
    const p = pattern({ confidence: 0.1, pattern: "Kerberos ticket renewal" });
    const out = ask("kerberos")([], [p], []);
    expect(out.results).toHaveLength(1);
  });

  it("includes patterns beyond the injection cap of 10", () => {
    const patterns = Array.from({ length: 30 }, (_, i) =>
      pattern({ pattern: `Widget rule number ${i}`, confidence: 0.7 }),
    );
    const out = ask("widget")([], patterns, []);
    expect(out.results.length).toBeGreaterThan(10);
  });

  it("finds a flight lesson far outside the 7-day injection window", () => {
    const e = flightEvent({ lessonsLearned: ["Pin the SSH host fingerprint"] }, Date.now() - 400 * DAY);
    const out = ask("fingerprint")([e], [], []);
    expect(out.results).toHaveLength(1);
  });

  it("finds a session summary far outside the 48-hour injection window", () => {
    const e = sessionEvent("Migrated the keyring wrapper", Date.now() - 30 * DAY);
    const out = ask("keyring")([e], [], []);
    expect(out.results).toHaveLength(1);
  });

  it("finds a manual note, which the injection path never surfaced at all", () => {
    const e = manualNote("Deploys need the staging token", "Ask ops for it.");
    const out = ask("staging")([e], [], []);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].kind).toBe("manual_note");
  });

  it("searches flight summary and whatFailed, not just lessonsLearned", () => {
    const e = flightEvent({ whatFailed: ["The telemetry exporter deadlocked"] });
    const out = ask("deadlocked")([e], [], []);
    expect(out.results.some((r) => r.kind === "flight")).toBe(true);
  });

  it("excludes archived project notes", () => {
    const out = ask("zebra")([], [], [note("Zebra", "zebra content", true)]);
    expect(out.results).toHaveLength(0);
  });

  it("isolates other projects unless includeAllProjects is set", () => {
    const foreign = pattern({ projectPath: OTHER, pattern: "Foreign zebra rule" });
    expect(ask("zebra")([], [foreign], []).results).toHaveLength(0);
    expect(ask("zebra", { includeAllProjects: true })([], [foreign], []).results).toHaveLength(1);
  });

  it("partitions results by source filter and reports matching counts", () => {
    const events = [manualNote("SSH zebra note")];
    const notes = [note("SSH", "zebra in markdown")];

    const globalOnly = ask("zebra", { source: "global" })(events, [], notes);
    expect(globalOnly.results.every((r) => r.source === "global")).toBe(true);
    expect(globalOnly.counts.notes).toBe(0);

    const projectOnly = ask("zebra", { source: "project" })(events, [], notes);
    expect(projectOnly.results.every((r) => r.source === "project")).toBe(true);
    expect(projectOnly.counts.events).toBe(0);
  });

  it("reports what was searched even when nothing matched", () => {
    const out = ask("nonexistentterm")([manualNote("Something else")], [pattern()], []);
    expect(out.results).toHaveLength(0);
    expect(out.counts.entries).toBeGreaterThan(0);
    expect(out.counts.patterns).toBe(1);
    expect(out.counts.events).toBe(1);
  });

  it("reports truncation past the limit", () => {
    const patterns = Array.from({ length: 60 }, (_, i) =>
      pattern({ pattern: `Widget rule ${i}` }),
    );
    const out = ask("widget", { limit: 50 })([], patterns, []);
    expect(out.results).toHaveLength(50);
    expect(out.totalMatches).toBe(60);
    expect(out.truncated).toBe(true);
  });

  it("never returns a zero-relevance entry however strong its priors", () => {
    const p = pattern({ pinned: true, confidence: 1, pattern: "Totally unrelated text" });
    const out = ask("kerberos")([], [p], []);
    expect(out.results).toHaveLength(0);
  });

  it("ranks a real keyword hit above a merely-trusted item", () => {
    const weak = pattern({ pinned: true, confidence: 1, pattern: "General guidance about ssh" });
    const strong = pattern({
      confidence: 0.2,
      pattern: "SSH host fingerprint pinning is mandatory",
    });
    const out = ask("ssh host fingerprint pinning")([], [weak, strong], []);
    expect(out.results[0].title).toContain("fingerprint");
  });

  it("answers the originally-filed bug: 'SSH auth' finds an 'authentication' note", () => {
    const notes = [note("SSH access", "SSH access uses key-based authentication")];
    const out = ask("how do we handle SSH auth?")([], [], notes);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].matchedTerms).toEqual(expect.arrayContaining(["ssh", "auth"]));
  });

  it("dedupes identical titles, keeping the best-scoring", () => {
    const a = manualNote("Duplicate title");
    const b = manualNote("Duplicate title");
    const out = ask("duplicate")([a, b], [], []);
    expect(out.results).toHaveLength(1);
  });

  it("applies no character budget to the result list", () => {
    const long = "widget ".repeat(400);
    const events = Array.from({ length: 8 }, (_, i) => manualNote(`Widget ${i}`, long));
    const out = ask("widget")(events, [], []);
    expect(out.results).toHaveLength(8);
  });
});

describe("searchMemoryCorpus edges", () => {
  it("returns an empty outcome for a blank query but still reports counts", () => {
    const corpus = buildMemorySearchCorpus([manualNote("Hi")], [], [], {
      kind: "local",
      projectPath: PROJECT,
    });
    const out = searchMemoryCorpus("   ", corpus);
    expect(out.results).toHaveLength(0);
    expect(out.counts.entries).toBe(1);
  });
});

describe("memorySearchCountPhrase", () => {
  it("pluralises and joins naturally", () => {
    expect(memorySearchCountPhrase({ patterns: 12, events: 48, notes: 3, entries: 63 })).toBe(
      "12 patterns, 48 events and 3 project notes",
    );
    expect(memorySearchCountPhrase({ patterns: 1, events: 0, notes: 1, entries: 2 })).toBe(
      "1 pattern and 1 project note",
    );
    expect(memorySearchCountPhrase({ patterns: 0, events: 0, notes: 0, entries: 0 })).toBe("nothing");
  });
});
