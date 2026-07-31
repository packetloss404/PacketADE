/**
 * The sanctioned destructive-action confirm.
 *
 * The audit found five competing idioms, the most common being none at all,
 * and `window.confirm` in seven files. This pins the contract every delete
 * path now leans on: the record is named, live consequences are shown, and
 * the destructive callback fires ONLY from the explicit confirm button.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

describe("ConfirmDeleteModal", () => {
  it("names the record and does not fire onConfirm on mount", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteModal
        title="Delete remote host?"
        entityName="prod (deploy@10.0.0.4:22)"
        description="is removed from this app."
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Delete remote host?" })).toBeInTheDocument();
    expect(screen.getByText(/prod \(deploy@10\.0\.0\.4:22\)/)).toBeInTheDocument();
    expect(screen.getByText(/is removed from this app\./)).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("fires onConfirm only from the confirm button", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDeleteModal
        title="Delete thing?"
        confirmLabel="Delete host"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete host" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("backs out via Cancel, the header X, and Escape without confirming", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <ConfirmDeleteModal title="Delete thing?" onConfirm={onConfirm} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
  });

  it("renders live consequences as an alert and omits the callout when there are none", () => {
    const { rerender } = render(
      <ConfirmDeleteModal
        title="Delete remote host?"
        warnings={["Connected right now.", "2 conversations run on this host."]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This is in use right now");
    expect(alert).toHaveTextContent("Connected right now.");
    expect(alert).toHaveTextContent("2 conversations run on this host.");

    rerender(
      <ConfirmDeleteModal title="Delete remote host?" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops the irreversibility note for reversible actions", () => {
    render(
      <ConfirmDeleteModal
        title="Archive note?"
        confirmLabel="Archive"
        undoNote={null}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("This cannot be undone.")).not.toBeInTheDocument();
  });
});
