/**
 * E7-INTEGRATE — JournalTab smoke tests.
 *
 * FE-side end-to-end coverage for the Journal tab. Sibling E7-CORE owns the
 * Rust journal-storage tests; sibling E7-UI owns the JournalTab component
 * itself. This slice verifies the wire-up: the component loads the journal
 * via `getFlightJournalTail`, renders markdown content, and shows an empty
 * state when the bounded journal slice is blank.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({
  getFlightJournalTail: vi.fn(),
  getFlightJournalPath: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: () => void) => {
    (
      globalThis as typeof globalThis & { __packetadeJournalListener?: () => void }
    ).__packetadeJournalListener = handler;
    return Promise.resolve(() => {});
  }),
}));

import { getFlightJournalTail, type FlightJournalRead } from "@/lib/tauri";
import { JournalTab } from "@/components/flights/JournalTab";

const mockedGetJournalTail = vi.mocked(getFlightJournalTail);

function journalRead(
  markdown: string,
  overrides: Partial<Omit<FlightJournalRead, "markdown">> = {},
): FlightJournalRead {
  return {
    markdown,
    totalBytes: markdown.length,
    returnedBytes: markdown.length,
    truncated: false,
    ...overrides,
  };
}

describe("JournalTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as typeof globalThis & { __packetadeJournalListener?: () => void })
      .__packetadeJournalListener;
  });

  it("renders empty state when journal is blank", async () => {
    mockedGetJournalTail.mockResolvedValue(journalRead(""));
    render(<JournalTab flightId="m1" />);
    await waitFor(() => {
      expect(screen.getByText(/no journal entries yet/i)).toBeInTheDocument();
    });
  });

  it("renders markdown when journal has content", async () => {
    mockedGetJournalTail.mockResolvedValue(journalRead("# Hello\n\nBody text."));
    render(<JournalTab flightId="m1" />);
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
  });

  it("calls getFlightJournalTail with the flight id and bounded cap", async () => {
    mockedGetJournalTail.mockResolvedValue(journalRead(""));
    render(<JournalTab flightId="m-abc" />);
    await waitFor(() => {
      expect(mockedGetJournalTail).toHaveBeenCalledWith("m-abc", 131072);
    });
  });

  it("shows the loading state before the journal resolves", () => {
    // Pending promise — never resolves during this test
    mockedGetJournalTail.mockReturnValue(new Promise(() => {}));
    render(<JournalTab flightId="m-loading" />);
    expect(screen.getByText(/loading journal/i)).toBeInTheDocument();
  });

  it("shows tail state when the backend returned a capped slice", async () => {
    mockedGetJournalTail.mockResolvedValue(
      journalRead("## Latest\n\nOnly latest entries.", {
        totalBytes: 262144,
        returnedBytes: 131072,
        truncated: true,
      }),
    );

    render(<JournalTab flightId="m-tail" />);

    await waitFor(() => {
      expect(screen.getByText(/showing latest 128 KB of 256 KB/i)).toBeInTheDocument();
    });
  });

  it("reloads a bounded tail rather than a full journal when append events arrive", async () => {
    mockedGetJournalTail
      .mockResolvedValueOnce(journalRead("# First"))
      .mockResolvedValueOnce(journalRead("# Second"));

    render(<JournalTab flightId="m-refresh" />);

    await waitFor(() => {
      expect(screen.getByText("First")).toBeInTheDocument();
    });

    const listener = (globalThis as typeof globalThis & { __packetadeJournalListener?: () => void })
      .__packetadeJournalListener;
    expect(listener).toBeDefined();

    await act(async () => {
      listener?.();
    });

    await waitFor(() => {
      expect(screen.getByText("Second")).toBeInTheDocument();
    });
    expect(mockedGetJournalTail).toHaveBeenCalledTimes(2);
    expect(mockedGetJournalTail).toHaveBeenLastCalledWith("m-refresh", 131072);
  });
});
