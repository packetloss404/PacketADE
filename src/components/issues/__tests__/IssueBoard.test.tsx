import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IssueBoard } from "@/components/issues/IssueBoard";
import { useIssueStore } from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";

// The spec-import modal reaches for Tauri IPC on mount paths we don't
// exercise here; stub it so the board renders standalone.
vi.mock("@/components/issues/SpecImportModal", () => ({
  SpecImportModal: () => null,
}));

const BOARD_COLUMN_LABELS = [
  "Backlog",
  "Up Next",
  "In Progress",
  "Needs Attention",
  "In Review",
  "Done",
];

describe("IssueBoard column layout", () => {
  beforeEach(() => {
    useIssueStore.setState({ issues: [] });
    useFlightStore.setState({ flights: [] });
  });

  it("renders all six columns in a single non-wrapping row", () => {
    const { container } = render(<IssueBoard />);

    const columns = screen.getAllByTestId("issue-board-column");
    expect(columns).toHaveLength(BOARD_COLUMN_LABELS.length);

    const row = columns[0].parentElement;
    expect(row).not.toBeNull();
    const rowClasses = row!.className;
    // A flex row that scrolls rather than a grid that wraps: `grid-cols-5`
    // used to orphan "Done" onto a second row at every viewport.
    expect(rowClasses).toContain("flex");
    expect(rowClasses).toContain("overflow-x-auto");
    expect(rowClasses).not.toContain("grid-cols");
    expect(rowClasses).not.toContain("flex-wrap");

    // Every column shares the width evenly with a legibility floor.
    for (const col of columns) {
      expect(col.className).toContain("flex-1");
      expect(col.className).toContain("min-w-[180px]");
    }

    // And every column is a direct child of that same row.
    expect(container.querySelectorAll(":scope > div > div > div").length).toBeGreaterThan(0);
    for (const col of columns) {
      expect(col.parentElement).toBe(row);
    }
  });

  it("labels the six columns in board order", () => {
    render(<IssueBoard />);
    const headings = screen
      .getAllByTestId("issue-board-column")
      .map((col) => col.textContent ?? "");
    BOARD_COLUMN_LABELS.forEach((label, i) => {
      expect(headings[i]).toContain(label);
    });
  });
});

describe("New Issue modal dismissal", () => {
  beforeEach(() => {
    useIssueStore.setState({ issues: [] });
    useFlightStore.setState({ flights: [] });
  });

  it("closes on Escape without creating an issue", () => {
    render(<IssueBoard />);

    fireEvent.click(screen.getByRole("button", { name: /New issue/i }));
    expect(screen.getByText("New Issue")).toBeInTheDocument();

    // Type into the title field first — Escape discards the draft, matching
    // every other Modal in the app (no confirm-on-discard convention exists).
    const title = screen.getByPlaceholderText("Issue title...");
    fireEvent.change(title, { target: { value: "half typed" } });

    fireEvent.keyDown(title, { key: "Escape", bubbles: true });

    expect(screen.queryByText("New Issue")).not.toBeInTheDocument();
    expect(useIssueStore.getState().issues).toHaveLength(0);
  });
});
