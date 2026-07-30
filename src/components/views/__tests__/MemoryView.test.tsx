/**
 * MemoryView — right-rail preview TRUTH (P2-18).
 *
 * The rail now renders the SAME budgeted brief the launch pipeline injects
 * (composeMemoryBrief) and derives its "tok brief" estimate from
 * memoryBriefStats. The legacy getContextForSession preview + its
 * `patterns.length * 32` token fallback could report a nonzero brief for a
 * scope whose brief is actually empty (patterns that don't match the active
 * project). These tests pin the truthful behavior: an empty brief reads as
 * ~0 tok, and a matching brief surfaces its real text + a nonzero estimate.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnedPattern } from "@/types/memory";

// memoryStore is REAL (composeMemoryBrief + memoryBriefStats are the subject);
// only its Tauri boundary is stubbed.
vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  togglePinnedPattern: vi.fn(),
  loadPersistedState: vi.fn(),
  // Pulled in transitively now that event cards deep-link into conversations
  // (MemoryEventCard → openConversationInAgents → sessionGlue → agentTaskStore).
  loadConversations: vi.fn().mockResolvedValue([]),
}));

// Control the active project path the preview is scoped to.
const layoutState = vi.hoisted(() => ({ projectPath: "D:/projects/current" }));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: (selector: (s: typeof layoutState) => unknown) => selector(layoutState),
}));

import { MemoryView } from "@/components/views/MemoryView";
import { useMemoryStore } from "@/stores/memoryStore";

function pattern(over: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    id: "p-1",
    pattern: "Prefer lucide icons and theme tokens over raw colors.",
    category: "convention",
    confidence: 0.9,
    extractedAt: Date.now(),
    projectPath: "D:/projects/current",
    ...over,
  };
}

beforeEach(() => {
  layoutState.projectPath = "D:/projects/current";
  useMemoryStore.setState({ events: [], patterns: [] });
});

describe("MemoryView preview truth", () => {
  it("reports ~0 tok and the empty-brief placeholder when no memory matches the active project", () => {
    // A pattern that belongs to a DIFFERENT project — under exact matching it
    // never enters this project's brief, so the brief is genuinely empty.
    useMemoryStore.setState({ patterns: [pattern({ projectPath: "D:/projects/OTHER" })] });

    render(<MemoryView />);

    expect(screen.getByText(/No memory brief will be injected yet/)).toBeInTheDocument();
    // Truthful estimate: an empty brief is ~0 tok. The old fallback would have
    // shown ~8 tok (patterns.length * 32 / 4) for this same empty preview.
    expect(document.body.textContent).toContain("~0 tok");
    expect(document.body.textContent).not.toContain("~8 tok");
  });

  it("renders the real composed brief text and a nonzero estimate when memory matches", () => {
    useMemoryStore.setState({ patterns: [pattern()] });

    render(<MemoryView />);

    // The preview shows the same brief the launch pipeline composes.
    expect(screen.getByText(/PacketADE Memory Brief/)).toBeInTheDocument();
    // Nonzero, budget-derived estimate — not the ~0 of an empty brief.
    expect(document.body.textContent).not.toContain("~0 tok");
    expect(document.body.textContent).toMatch(/~[1-9]\d* tok/);
  });
});
