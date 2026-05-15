/**
 * E7-INTEGRATE — JournalTab smoke tests.
 *
 * FE-side end-to-end coverage for the Journal tab. Sibling E7-CORE owns the
 * Rust journal-storage tests; sibling E7-UI owns the JournalTab component
 * itself. This slice verifies the wire-up: the component loads the journal
 * via `getMissionJournal`, renders markdown content, and shows an empty
 * state when the journal is blank.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({
  getMissionJournal: vi.fn(),
  getMissionJournalPath: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { getMissionJournal } from "@/lib/tauri";
import { JournalTab } from "@/components/missions/JournalTab";

const mockedGetJournal = vi.mocked(getMissionJournal);

describe("JournalTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when journal is blank", async () => {
    mockedGetJournal.mockResolvedValue("");
    render(<JournalTab missionId="m1" />);
    await waitFor(() => {
      expect(screen.getByText(/no journal entries yet/i)).toBeInTheDocument();
    });
  });

  it("renders markdown when journal has content", async () => {
    mockedGetJournal.mockResolvedValue("# Hello\n\nBody text.");
    render(<JournalTab missionId="m1" />);
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
  });

  it("calls getMissionJournal with the mission id", async () => {
    mockedGetJournal.mockResolvedValue("");
    render(<JournalTab missionId="m-abc" />);
    await waitFor(() => {
      expect(mockedGetJournal).toHaveBeenCalledWith("m-abc");
    });
  });

  it("shows the loading state before the journal resolves", () => {
    // Pending promise — never resolves during this test
    mockedGetJournal.mockReturnValue(new Promise(() => {}));
    render(<JournalTab missionId="m-loading" />);
    expect(screen.getByText(/loading journal/i)).toBeInTheDocument();
  });
});
