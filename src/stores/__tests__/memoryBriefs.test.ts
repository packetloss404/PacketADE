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
});
