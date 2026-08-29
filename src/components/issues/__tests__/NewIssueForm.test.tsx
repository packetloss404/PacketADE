/**
 * Regression cover for the New Issue dialog's Status picker.
 *
 * `IssueBoard` opens this dialog with `defaultStatus` taken from the column
 * header the user clicked — including `backlog`, `up_next` and `in_review`,
 * the three statuses v0.8.5 added to `IssueStatus`. The dialog's hand-written
 * `<option>` list never grew to match, so the controlled `<select>` was handed
 * a value with no matching option and rendered blank. The submitted status was
 * still correct if the user left the control alone, which is exactly why it
 * went unnoticed: only the control was wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewIssueForm } from "@/components/issues/NewIssueForm";
import { useIssueStore, type IssueStatus } from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";

/** Every status the board can hand this dialog, with its display label. */
const EXPECTED_OPTIONS: [IssueStatus, string][] = [
  ["backlog", "Backlog"],
  ["up_next", "Up Next"],
  ["todo", "To Do"],
  ["in_progress", "In Progress"],
  ["in_review", "In Review"],
  ["qa", "QA"],
  ["done", "Done"],
  ["blocked", "Blocked"],
  ["needs_human", "Needs Human"],
];

function statusSelect(): HTMLSelectElement {
  // Priority is the other <select> in the row; Status is the second one.
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === "in_progress"),
  );
  if (!found) throw new Error("status select not found");
  return found;
}

describe("NewIssueForm status picker", () => {
  beforeEach(() => {
    localStorage.clear();
    useIssueStore.setState({ issues: [], epics: [], nextTicketNum: 1 });
    useFlightStore.setState({ flights: [] });
  });

  it("offers every IssueStatus, in board order", () => {
    render(<NewIssueForm defaultStatus="todo" onClose={() => {}} />);

    const options = Array.from(statusSelect().options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual(EXPECTED_OPTIONS);
  });

  it.each(EXPECTED_OPTIONS)(
    "shows %s as the selected option when the board opens on that column",
    (status) => {
      render(<NewIssueForm defaultStatus={status} onClose={() => {}} />);

      const select = statusSelect();
      // The blank-render symptom: a controlled <select> whose value matches no
      // option reports `selectedIndex === -1` and shows nothing.
      expect(select.value).toBe(status);
      expect(select.selectedIndex).toBeGreaterThanOrEqual(0);
      expect(select.options[select.selectedIndex].value).toBe(status);
    },
  );

  it("creates the issue with the status the picker is showing", () => {
    const onClose = vi.fn();
    render(<NewIssueForm defaultStatus="backlog" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("Issue title..."), {
      target: { value: "Investigate flake" },
    });
    fireEvent.change(statusSelect(), { target: { value: "in_review" } });
    fireEvent.click(screen.getByText("Create Issue"));

    expect(useIssueStore.getState().issues[0]).toMatchObject({
      title: "Investigate flake",
      status: "in_review",
    });
    expect(onClose).toHaveBeenCalled();
  });
});
