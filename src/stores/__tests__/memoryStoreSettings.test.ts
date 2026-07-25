import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedState } from "@/lib/tauri";
import type { MemoryEvent } from "@/types/memory";

const mocks = vi.hoisted(() => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  togglePinnedPattern: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: (...args: unknown[]) => mocks.saveMemorySlice(...args),
  summarizeSession: (...args: unknown[]) => mocks.summarizeSession(...args),
  extractPatterns: (...args: unknown[]) => mocks.extractPatterns(...args),
  readPtyTranscript: (...args: unknown[]) => mocks.readPtyTranscript(...args),
  togglePinnedPattern: (...args: unknown[]) => mocks.togglePinnedPattern(...args),
}));

async function loadStores() {
  vi.resetModules();
  const memorySettings = await import("../memorySettingsStore");
  const memoryStore = await import("../memoryStore");
  return { ...memorySettings, ...memoryStore };
}

function taskEvent(id: string, timestamp: number): MemoryEvent {
  return {
    id,
    type: "task_completed",
    timestamp,
    projectPath: "D:/projects/example",
    payload: {
      taskId: id,
      taskTitle: id,
      flightId: "flight-1",
      flightTitle: "Flight",
      milestoneId: "milestone-1",
      success: true,
      exitCode: 0,
      summary: "Done",
      filesChanged: [],
      errors: [],
      durationMs: 100,
    },
  };
}

describe("memoryStore settings integration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.saveMemorySlice.mockResolvedValue(undefined);
    mocks.readPtyTranscript.mockResolvedValue({ data: "session transcript" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not capture flight events when flight capture is disabled", async () => {
    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setCaptureFlights(false);

    useMemoryStore.getState().captureFlightCompleted(
      {
        flightId: "flight-1",
        flightTitle: "Flight",
        summary: "Done",
        whatWorked: [],
        whatFailed: [],
        lessonsLearned: [],
        suggestedImprovements: [],
        tags: [],
      },
      "D:/projects/example",
    );

    expect(useMemoryStore.getState().events).toEqual([]);
    expect(mocks.saveMemorySlice).not.toHaveBeenCalled();
  });

  it("captures a flight event when flight capture is enabled", async () => {
    const { useMemoryStore } = await loadStores();

    useMemoryStore.getState().captureFlightCompleted(
      {
        flightId: "flight-1",
        flightTitle: "Flight",
        summary: "Done",
        whatWorked: ["a"],
        whatFailed: [],
        lessonsLearned: ["lesson"],
        suggestedImprovements: [],
        tags: ["flight"],
      },
      "D:/projects/example",
    );

    const events = useMemoryStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("flight_completed");
  });

  it("caps stored events using the configured max", async () => {
    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setMaxEvents(20);

    for (let i = 1; i <= 21; i += 1) {
      useMemoryStore.getState().captureManually({
        projectPath: "D:/projects/example",
        source: "test",
        summary: `note-${i}`,
        body: "",
      });
    }

    expect(
      useMemoryStore
        .getState()
        .events.map((event) =>
          event.type === "manual_note" ? event.payload.summary : null,
        ),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `note-${index + 2}`));
  });

  it("prunes events older than the configured retention window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));

    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setRetentionDays(1);
    useMemoryStore.setState({
      events: [
        taskEvent("old", Date.now() - 2 * 24 * 60 * 60 * 1000),
        taskEvent("new", Date.now()),
      ],
      patterns: [],
    });

    useMemoryStore.getState().applyRetentionPolicy();

    expect(useMemoryStore.getState().events.map((event) => event.id)).toEqual(["new"]);
  });

  it("persists pruned memory when retention applies during hydration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));

    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setRetentionDays(1);

    useMemoryStore.getState().hydrateFromBackend({
      memoryEvents: [
        taskEvent("old", Date.now() - 2 * 24 * 60 * 60 * 1000),
        taskEvent("new", Date.now()),
      ],
      memoryPatterns: [],
    } as unknown as PersistedState);

    expect(useMemoryStore.getState().events.map((event) => event.id)).toEqual(["new"]);
    expect(mocks.saveMemorySlice).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "new" })],
      [],
    );
  });

  it("does not read transcripts when session summarization is disabled", async () => {
    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setSummarizeSessions(false);

    await useMemoryStore
      .getState()
      .learnFromSession("session-1", "codex", "D:/projects/example", 100);

    expect(mocks.readPtyTranscript).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().events).toEqual([]);
  });

  // === v0.8-H: pin / project-scope / context-items ===

  it("filters patterns by projectPath, treating legacy patterns as global", async () => {
    const { useMemoryStore, computeContextItems } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "p-legacy",
          pattern: "legacy global",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          // no projectPath = legacy/global
        },
        {
          id: "p-this",
          pattern: "scoped to project A",
          category: "architecture",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
        {
          id: "p-other",
          pattern: "scoped to project B",
          category: "architecture",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: "D:/projects/B",
        },
      ],
    });

    const s = useMemoryStore.getState();
    const items = computeContextItems(s.events, s.patterns, { projectPath: "D:/projects/A" });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("p-legacy"); // global matches every project
    expect(ids).toContain("p-this"); // exact match
    expect(ids).not.toContain("p-other"); // different project excluded
  });

  it("sorts pinned patterns first and exempts them from confidence cutoff", async () => {
    const { useMemoryStore, computeContextItems } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "p-high",
          pattern: "high confidence",
          category: "convention",
          confidence: 0.95,
          extractedAt: 1,
          projectPath: "D:/projects/A",
        },
        {
          id: "p-low-pinned",
          pattern: "low confidence pinned",
          category: "preference",
          confidence: 0.3, // below 0.6 cutoff
          extractedAt: 2,
          projectPath: "D:/projects/A",
          pinned: true,
        },
      ],
    });

    const s = useMemoryStore.getState();
    const items = computeContextItems(s.events, s.patterns, { projectPath: "D:/projects/A" });
    expect(items.map((i) => i.id)).toEqual(["p-low-pinned", "p-high"]);
  });

  it("M8: ranks eligible patterns by relevance to a query (Ask-your-project)", async () => {
    const { useMemoryStore, computeContextItems } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "db",
          pattern: "database migrations must run in a deterministic order",
          category: "convention",
          confidence: 0.8,
          extractedAt: 1,
          projectPath: "D:/projects/A",
        },
        {
          id: "ui",
          pattern: "prefer tailwind theme tokens over raw colors",
          category: "convention",
          confidence: 0.8,
          extractedAt: 2,
          projectPath: "D:/projects/A",
        },
      ],
    });

    const s = useMemoryStore.getState();
    const items = computeContextItems(
      s.events,
      s.patterns,
      { projectPath: "D:/projects/A" },
      "how do database migrations run",
    );
    // both patterns are eligible (conf ≥ 0.6); the query pulls the relevant
    // one to the top rather than falling back to extractedAt order.
    expect(items[0].id).toBe("db");
  });

  it("togglePinPattern flips the in-memory flag immediately (optimistic)", async () => {
    mocks.togglePinnedPattern.mockResolvedValue(true);
    const { useMemoryStore } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "p-1",
          pattern: "X",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
      ],
    });

    useMemoryStore.getState().togglePinPattern("p-1");
    // Optimistic: state changes before the backend resolves.
    expect(useMemoryStore.getState().patterns[0].pinned).toBe(true);
  });

  it("ranks a task-relevant pattern above a higher-confidence irrelevant one when a query is given", async () => {
    const { useMemoryStore, computeContextItems } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "p-css",
          pattern: "prefer flexbox for layout styling",
          category: "convention",
          confidence: 0.95,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
        {
          id: "p-auth",
          pattern: "authentication uses JWT tokens with refresh",
          category: "architecture",
          confidence: 0.7,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
      ],
    });
    const s = useMemoryStore.getState();

    // Without a query: highest confidence wins (prior behaviour).
    const noQuery = computeContextItems(s.events, s.patterns, { projectPath: "D:/projects/A" });
    expect(noQuery.map((i) => i.id)).toEqual(["p-css", "p-auth"]);

    // With a task query: the relevant pattern is surfaced first despite lower
    // confidence.
    const withQuery = computeContextItems(
      s.events,
      s.patterns,
      { projectPath: "D:/projects/A" },
      "add JWT authentication to the login endpoint",
    );
    expect(withQuery.map((i) => i.id)).toEqual(["p-auth", "p-css"]);
    expect(withQuery[0].reason).toContain("Relevant to task");
  });

  it("keeps pinned patterns first even when the query matches an unpinned one", async () => {
    const { useMemoryStore, computeContextItems } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "p-auth",
          pattern: "authentication uses JWT tokens",
          category: "architecture",
          confidence: 0.7,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
        {
          id: "p-pinned",
          pattern: "always run the linter before committing",
          category: "convention",
          confidence: 0.3,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
          pinned: true,
        },
      ],
    });
    const s = useMemoryStore.getState();
    const items = computeContextItems(
      s.events,
      s.patterns,
      { projectPath: "D:/projects/A" },
      "add JWT authentication",
    );
    expect(items[0].id).toBe("p-pinned");
  });

  it("falls back to confidence order for an empty / stopword-only query", async () => {
    const { useMemoryStore, computeContextItems } = await loadStores();
    useMemoryStore.setState({
      events: [],
      patterns: [
        {
          id: "p-css",
          pattern: "prefer flexbox for layout styling",
          category: "convention",
          confidence: 0.95,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
        {
          id: "p-auth",
          pattern: "authentication uses JWT tokens",
          category: "architecture",
          confidence: 0.7,
          extractedAt: Date.now(),
          projectPath: "D:/projects/A",
        },
      ],
    });
    const s = useMemoryStore.getState();
    const items = computeContextItems(
      s.events,
      s.patterns,
      { projectPath: "D:/projects/A" },
      "the and to of", // all stopwords → no usable query
    );
    expect(items.map((i) => i.id)).toEqual(["p-css", "p-auth"]);
  });
});
