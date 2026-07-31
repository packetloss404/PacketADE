import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";

function pressEscape() {
  fireEvent.keyDown(window, { key: "Escape" });
}

describe("Modal escape-to-close", () => {
  it("closes on Escape by default (no opt-in required)", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="Plain modal">
        <p>body</p>
      </Modal>,
    );

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape while focus is inside a text field", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="Form modal">
        <input aria-label="Title" defaultValue="half typed" />
      </Modal>,
    );

    const input = screen.getByLabelText("Title");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape", bubbles: true });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the caller opts out", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="PTY modal" closeOnEscape={false}>
        <p>body</p>
      </Modal>,
    );

    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close mid unbreakable operation (closeDisabled)", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="Busy modal" closeDisabled>
        <p>body</p>
      </Modal>,
    );

    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores an Escape an inner layer already handled", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} title="Layered modal">
        <input
          aria-label="Inline edit"
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        />
      </Modal>,
    );

    fireEvent.keyDown(screen.getByLabelText("Inline edit"), {
      key: "Escape",
      bubbles: true,
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks the keypress handled so later Escape layers do not double-fire", () => {
    const outerFired = vi.fn();
    render(
      <Modal onClose={() => {}} title="Layered modal">
        <p>body</p>
      </Modal>,
    );

    // Registered after the modal, so it observes the event the modal handled.
    const outer = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      outerFired();
    };
    window.addEventListener("keydown", outer);
    try {
      pressEscape();
    } finally {
      window.removeEventListener("keydown", outer);
    }

    expect(outerFired).not.toHaveBeenCalled();
  });
});
