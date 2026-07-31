/**
 * UX-09: the confirmation names what dies and defaults to the safe action.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CloseConfirmDialog } from "@/components/common/CloseConfirmDialog";

describe("CloseConfirmDialog", () => {
  it("lists every live-work kind by count", () => {
    render(
      <CloseConfirmDialog
        summary={{ ptySessions: 3, conversations: 1, attempts: 2, total: 6 }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("3 terminal sessions will be killed")).toBeInTheDocument();
    expect(screen.getByText("1 agent conversation mid-turn will be cut off")).toBeInTheDocument();
    expect(screen.getByText("2 flight attempts still running will be abandoned")).toBeInTheDocument();
  });

  it("omits kinds with no live work", () => {
    render(
      <CloseConfirmDialog
        summary={{ ptySessions: 1, conversations: 0, attempts: 0, total: 1 }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("1 terminal session will be killed")).toBeInTheDocument();
    expect(screen.queryByText(/agent conversation/)).not.toBeInTheDocument();
    expect(screen.queryByText(/flight attempt/)).not.toBeInTheDocument();
  });

  it("wires Cancel, Close anyway, and Escape", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CloseConfirmDialog
        summary={{ ptySessions: 1, conversations: 0, attempts: 0, total: 1 }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Close anyway"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
