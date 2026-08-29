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
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnedPattern, MemoryEvent } from "@/types/memory";

// memoryStore is REAL (composeMemoryBrief + memoryBriefStats are the subject);
// only its Tauri boundary is stubbed.
vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  scanCodebaseMemory: vi.fn(),
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
import { useMemoryStore, CODEBASE_SCAN_SOURCE } from "@/stores/memoryStore";

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
    expect(screen.getByText(/PacketBench Memory Brief/)).toBeInTheDocument();
    // Nonzero, budget-derived estimate — not the ~0 of an empty brief.
    expect(document.body.textContent).not.toContain("~0 tok");
    expect(document.body.textContent).toMatch(/~[1-9]\d* tok/);
  });
});

/**
 * Memory deletes used to be confirm-inverted: clear-all asked (via
 * `window.confirm`), while the IRREVERSIBLE per-pattern and per-event deletes
 * fired instantly from a 9-10px hover trash icon. All three now go through the
 * shared styled confirm.
 */
describe("MemoryView delete confirmations", () => {
  it("clear-all opens the styled confirm, not window.confirm, and cancel keeps memory", () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    useMemoryStore.setState({ patterns: [pattern()] });

    render(<MemoryView />);
    fireEvent.click(screen.getByTitle("Clear all memory"));

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Clear all memory?" })).toBeInTheDocument();
    expect(useMemoryStore.getState().patterns).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useMemoryStore.getState().patterns).toHaveLength(1);

    fireEvent.click(screen.getByTitle("Clear all memory"));
    fireEvent.click(screen.getByRole("button", { name: "Clear memory" }));
    expect(useMemoryStore.getState().patterns).toHaveLength(0);
    nativeConfirm.mockRestore();
  });

  it("per-pattern delete confirms and names the pattern; cancel keeps it", () => {
    useMemoryStore.setState({ patterns: [pattern()] });

    render(<MemoryView />);
    fireEvent.click(screen.getByTitle("Delete pattern"));

    expect(useMemoryStore.getState().patterns).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Delete learned pattern?" })).toBeInTheDocument();
    expect(screen.getAllByText(/Prefer lucide icons/).length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useMemoryStore.getState().patterns).toHaveLength(1);

    fireEvent.click(screen.getByTitle("Delete pattern"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useMemoryStore.getState().patterns).toHaveLength(0);
  });
});

/**
 * "Scan codebase" is the Memory pane's entry point to `scan_codebase_memory`,
 * which had no caller at all — the Settings row that routes it configured a
 * feature nothing could run.
 */
describe("MemoryView codebase scan", () => {
  function scanNote(): MemoryEvent {
    return {
      id: "mem-scan-1",
      type: "manual_note",
      timestamp: Date.now(),
      projectPath: "D:/projects/current",
      payload: {
        source: CODEBASE_SCAN_SOURCE,
        summary: "Codebase index: 2 key files",
        body: "- src/main.ts — App entry point",
        tags: [CODEBASE_SCAN_SOURCE],
      },
    };
  }

  it("runs the scan for the active local project", () => {
    const scanCodebase = vi.fn().mockResolvedValue(true);
    useMemoryStore.setState({ scanCodebase });

    render(<MemoryView />);
    fireEvent.click(screen.getByRole("button", { name: /Scan codebase/ }));

    expect(scanCodebase).toHaveBeenCalledWith("D:/projects/current");
  });

  it("says Re-scan once this project already has an index, because a rerun replaces it", () => {
    useMemoryStore.setState({ events: [scanNote()] });

    render(<MemoryView />);

    const button = screen.getByRole("button", { name: /Re-scan codebase/ });
    expect(button).toHaveAttribute(
      "title",
      expect.stringContaining("replaces the existing codebase index note"),
    );
  });

  it("cannot be run with no project open", () => {
    layoutState.projectPath = "";

    render(<MemoryView />);

    const button = screen.getByRole("button", { name: /Scan codebase/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Open a local workspace to index its codebase");
  });
});
