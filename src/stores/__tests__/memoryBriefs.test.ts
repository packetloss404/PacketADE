import { beforeEach, describe, expect, it, vi } from "vitest";
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
  const memoryStore = await import("../memoryStore");
  return memoryStore;
}

function sessionEvent(id: string, projectPath: string, summary: string): MemoryEvent {
  return {
    id,
    type: "session_completed",
    timestamp: Date.now(),
    projectPath,
    payload: {
      sessionId: id,
      agentId: "api-openai",
      durationMs: 100,
      status: "done",
      summary,
      filesModified: [],
      keyDecisions: [],
    },
  };
}

describe("memory briefs", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("composes a bounded prompt brief from project-scoped memory", async () => {
    const { useMemoryStore } = await loadStores();
    useMemoryStore.setState({
      events: [
        sessionEvent(
          "s-1",
          "D:/projects/example",
          "Use the shared Modal component and keep the compact toolbar spacing intact.",
        ),
      ],
      patterns: [
        {
          id: "p-1",
          pattern: "Prefer lucide icons and theme tokens over raw colors.",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: "D:/projects/example",
        },
      ],
    });

    const brief = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: "D:/projects/example" }, { maxChars: 500 });

    expect(brief.text.length).toBeLessThanOrEqual(500);
    expect(brief.text).toContain("PacketBench Memory Brief");
    expect(brief.text).toContain("Prefer lucide icons");
    expect(brief.items.map((item) => item.id)).toContain("p-1");
    expect(brief.items.map((item) => item.id)).toContain("s-1");
  });

  it("marks the brief truncated and honours the char budget for an oversized corpus", async () => {
    const { useMemoryStore } = await loadStores();
    // 10 verbose patterns (the default contextMaxPatterns) each well over the
    // per-line budget so the assembled brief overflows a 600-char cap.
    useMemoryStore.setState({
      patterns: Array.from({ length: 10 }, (_, i) => ({
        id: `p-${i}`,
        pattern:
          `Pattern ${i}: prefer the shared design tokens and lucide icons over raw hex ` +
          `colors, keep the compact toolbar spacing intact, and never reformat src with prettier.`,
        category: "convention" as const,
        confidence: 0.9,
        extractedAt: Date.now() - i,
        projectPath: "D:/projects/example",
      })),
    });

    const brief = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: "D:/projects/example" }, { maxChars: 600 });

    expect(brief.truncated).toBe(true);
    expect(brief.text.length).toBeLessThanOrEqual(600);
    // At least one (but not all ten) patterns survived the budget.
    expect(brief.items.length).toBeGreaterThan(0);
    expect(brief.items.length).toBeLessThan(10);
  });

  it("clamps maxChars to the 400 floor and 4000 ceiling", async () => {
    const { useMemoryStore } = await loadStores();

    const floored = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: "D:/projects/example" }, { maxChars: 1 });
    expect(floored.charBudget).toBe(400);

    const ceilinged = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: "D:/projects/example" }, { maxChars: 999999 });
    expect(ceilinged.charBudget).toBe(4000);
  });

  it("does not leak local or legacy memory into SSH briefs", async () => {
    const { remoteMemoryProjectKey, useMemoryStore } = await loadStores();
    useMemoryStore.setState({
      events: [
        sessionEvent("legacy", "", "legacy global note"),
        sessionEvent("plain-remote-path", "/srv/app", "plain remote path note"),
        sessionEvent(
          "explicit-remote",
          remoteMemoryProjectKey("srv-1", "/srv/app"),
          "remote-scoped deployment note",
        ),
      ],
      patterns: [
        {
          id: "local-pattern",
          pattern: "local-only convention",
          category: "convention",
          confidence: 0.95,
          extractedAt: Date.now(),
          projectPath: "D:/projects/app",
        },
      ],
    });

    const brief = useMemoryStore.getState().composeMemoryBrief({
      kind: "ssh",
      projectPath: "/srv/app",
      serverId: "srv-1",
      remotePath: "/srv/app",
    });

    expect(brief.text).toContain("remote-scoped deployment note");
    expect(brief.text).not.toContain("legacy global note");
    expect(brief.text).not.toContain("plain remote path note");
    expect(brief.text).not.toContain("local-only convention");
  });

  it("injects durable project notes into the brief", async () => {
    // Regression guard for the gap that made Memory feel useless: project
    // notes in `.agents/memory` were loaded, rendered in their own tab, and
    // then never reached a single agent prompt.
    const { useMemoryStore } = await loadStores();
    const { useProjectMemoryStore } = await import("../projectMemoryStore");

    useProjectMemoryStore.setState({
      projectPath: "D:/projects/example",
      snapshot: {
        schemaVersion: 1,
        directory: ".agents/memory",
        notes: [
          {
            metadata: {
              schemaVersion: 1,
              id: "note-1",
              title: "SSH host pinning",
              tags: ["ssh"],
              createdAt: 1,
              updatedAt: 2,
              archived: false,
              provenanceIds: [],
            },
            body: "Always populate SshConfig.host_fingerprint from ServerConfig.",
            path: ".agents/memory/note-1.md",
          },
        ],
        warnings: [],
        revision: "r1",
      },
    } as never);

    useMemoryStore.setState({ events: [], patterns: [] });

    const brief = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: "D:/projects/example", kind: "local" });

    expect(brief.text).toContain("Project notes");
    expect(brief.text).toContain("SSH host pinning");
    expect(brief.items.some((i) => i.kind === "project_note")).toBe(true);
  });

  it("does not leak another project's notes into the brief", async () => {
    const { useMemoryStore } = await loadStores();
    const { useProjectMemoryStore } = await import("../projectMemoryStore");

    useProjectMemoryStore.setState({
      projectPath: "D:/projects/other",
      snapshot: {
        schemaVersion: 1,
        directory: ".agents/memory",
        notes: [
          {
            metadata: {
              schemaVersion: 1,
              id: "note-x",
              title: "Secret from another project",
              tags: [],
              createdAt: 1,
              updatedAt: 2,
              archived: false,
              provenanceIds: [],
            },
            body: "Should never appear.",
            path: ".agents/memory/note-x.md",
          },
        ],
        warnings: [],
        revision: "r1",
      },
    } as never);

    useMemoryStore.setState({ events: [], patterns: [] });

    const brief = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: "D:/projects/example", kind: "local" });

    expect(brief.text).not.toContain("Secret from another project");
  });


  it("widens Ask without widening injection", async () => {
    // The separation gate. Ask searches the whole corpus; the brief keeps its
    // confidence gate, per-source caps and recency windows. If Ask's rules ever
    // leak into `composeMemoryBrief`, this fails loudly.
    const { useMemoryStore } = await loadStores();
    const { askMemory } = await import("@/lib/memorySearch");
    const project = "D:/projects/example";
    const DAY = 86_400_000;

    const lowConfidencePattern = {
      id: "pat-low",
      pattern: "Zebra handling is delegated to the sidecar",
      category: "convention",
      confidence: 0.3,
      extractedAt: Date.now(),
      projectPath: project,
      pinned: false,
    };
    const oldLesson: MemoryEvent = {
      id: "f-old",
      type: "flight_completed",
      timestamp: Date.now() - 10 * DAY,
      projectPath: project,
      payload: {
        flightId: "fl-1",
        flightTitle: "Zebra flight",
        summary: "s",
        whatWorked: [],
        whatFailed: [],
        lessonsLearned: ["Zebra migrations must run before boot"],
        suggestedImprovements: [],
        tags: [],
      },
    } as unknown as MemoryEvent;
    const oldSession = sessionEvent("s-old", project, "Zebra rollout completed");
    oldSession.timestamp = Date.now() - 3 * DAY;
    const savedNote: MemoryEvent = {
      id: "m-1",
      type: "manual_note",
      timestamp: Date.now(),
      projectPath: project,
      payload: { source: "manual", summary: "Zebra runbook", body: "b", tags: [] },
    } as unknown as MemoryEvent;

    const events = [oldLesson, oldSession, savedNote];
    const patterns = [lowConfidencePattern] as never;
    useMemoryStore.setState({ events, patterns });

    const brief = useMemoryStore
      .getState()
      .composeMemoryBrief({ projectPath: project, kind: "local" });
    expect(brief.text).not.toContain("Zebra");

    const found = askMemory("zebra", events, patterns, [], {
      kind: "local",
      projectPath: project,
    });
    // Every source the brief refused: the low-confidence pattern, the 10-day-old
    // flight (both its lesson and the retrospective itself), the 3-day-old
    // session summary, and the saved note.
    expect(new Set(found.results.map((r) => r.kind))).toEqual(
      new Set(["pattern", "lesson", "flight", "session", "manual_note"]),
    );
  });

});
