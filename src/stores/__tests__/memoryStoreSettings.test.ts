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
      flightId: "mission-1",
      flightTitle: "Mission",
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

  it("does not capture session events when session capture is disabled", async () => {
    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setCaptureSessions(false);

    useMemoryStore.getState().captureSessionCompleted(
      {
        sessionId: "session-1",
        agentId: "codex",
        durationMs: 100,
        status: "done",
        summary: "Done",
        filesModified: [],
        keyDecisions: [],
      },
      "D:/projects/example",
    );

    expect(useMemoryStore.getState().events).toEqual([]);
    expect(mocks.saveMemorySlice).not.toHaveBeenCalled();
  });

  it("caps stored events using the configured max", async () => {
    const { useMemorySettingsStore, useMemoryStore } = await loadStores();
    useMemorySettingsStore.getState().setMaxEvents(20);

    for (let i = 1; i <= 21; i += 1) {
      const id = `task-${i}`;
      useMemoryStore.getState().captureTaskCompleted(
        {
          taskId: id,
          taskTitle: id,
          flightId: "mission-1",
          flightTitle: "Mission",
          milestoneId: "milestone-1",
          success: true,
          exitCode: 0,
          summary: "Done",
          filesChanged: [],
          errors: [],
          durationMs: 100,
        },
        "D:/projects/example",
      );
    }

    expect(
      useMemoryStore
        .getState()
        .events.map((event) =>
          event.type === "task_completed" ? event.payload.taskId : null,
        ),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `task-${index + 2}`));
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
    const { useMemoryStore } = await loadStores();
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

    const items = useMemoryStore
      .getState()
      .getContextItemsForSession({ projectPath: "D:/projects/A" });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("p-legacy"); // global matches every project
    expect(ids).toContain("p-this"); // exact match
    expect(ids).not.toContain("p-other"); // different project excluded
  });

  it("sorts pinned patterns first and exempts them from confidence cutoff", async () => {
    const { useMemoryStore } = await loadStores();
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

    const items = useMemoryStore
      .getState()
      .getContextItemsForSession({ projectPath: "D:/projects/A" });
    expect(items.map((i) => i.id)).toEqual(["p-low-pinned", "p-high"]);
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
});
