import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";
import { resetModalStack } from "@/lib/modalStack";

function pressEscape() {
  fireEvent.keyDown(window, { key: "Escape" });
}

afterEach(() => {
  resetModalStack();
  document.body.innerHTML = "";
});

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

/**
 * Real nesting, as PromptLibrary produces it: the ConfirmDeleteModal is a child
 * of the PromptLibrary Modal, and opens LATER. The outer therefore registered
 * its window listener first and fires first — the exact ordering the old
 * implementation got wrong, closing the whole library instead of the confirm.
 */
describe("Modal nesting", () => {
  function Nested({
    onOuterClose,
    onInnerClose,
    showInner,
  }: {
    onOuterClose: () => void;
    onInnerClose: () => void;
    showInner: boolean;
  }) {
    return (
      <Modal onClose={onOuterClose} title="Prompt Library">
        <p>library body</p>
        {showInner && (
          <Modal onClose={onInnerClose} title="Delete prompt template?">
            <p>confirm body</p>
          </Modal>
        )}
      </Modal>
    );
  }

  it("routes Escape to the inner dialog that opened last, not the outer one", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    const view = render(
      <Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} showInner={false} />,
    );

    // Outer opened first — it owns Escape while it is alone.
    view.rerender(<Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} showInner />);

    pressEscape();

    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  it("hands Escape back to the outer dialog once the inner one closes", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    const view = render(
      <Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} showInner />,
    );

    view.rerender(
      <Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} showInner={false} />,
    );
    pressEscape();

    expect(onOuterClose).toHaveBeenCalledTimes(1);
    expect(onInnerClose).not.toHaveBeenCalled();
  });

  // React runs child effects before parent effects, so mount order alone puts
  // the inner dialog first. Depth has to win.
  it("still prefers the inner dialog when both mount in the same commit", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} showInner />);

    pressEscape();

    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  it("does not let a non-top dialog act even when the top one declines Escape", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    render(
      <Modal onClose={onOuterClose} title="Outer">
        <Modal onClose={onInnerClose} title="PTY" closeOnEscape={false}>
          <p>xterm</p>
        </Modal>
      </Modal>,
    );

    pressEscape();

    expect(onInnerClose).not.toHaveBeenCalled();
    expect(onOuterClose).not.toHaveBeenCalled();
  });
});

describe("Modal dialog semantics", () => {
  it("exposes a labelled modal dialog to assistive tech", () => {
    render(
      <Modal onClose={() => {}} title="Add MCP Server">
        <p>body</p>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Add MCP Server" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveAttribute(
      "id",
      dialog.getAttribute("aria-labelledby"),
    );
  });
});

describe("Modal focus management", () => {
  it("moves focus into the dialog on open", () => {
    render(
      <Modal onClose={() => {}} title="Focus modal">
        <button>Inside</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("leaves a consumer's autoFocus target alone", () => {
    render(
      <Modal onClose={() => {}} title="Form modal">
        <input aria-label="Template name" autoFocus />
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText("Template name"));
  });

  it("restores focus to the trigger when the dialog closes", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <Modal onClose={() => {}} title="Focus modal">
        <button>Inside</button>
      </Modal>,
    );
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab from the last focusable back to the first", () => {
    render(
      <Modal onClose={() => {}} title="Trap modal">
        <button>First body button</button>
        <button>Last body button</button>
      </Modal>,
    );

    const last = screen.getByText("Last body button");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab", bubbles: true });

    // The header close button is the first focusable in the dialog.
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
  });

  it("cycles Shift+Tab from the first focusable back to the last", () => {
    render(
      <Modal onClose={() => {}} title="Trap modal">
        <button>First body button</button>
        <button>Last body button</button>
      </Modal>,
    );

    const close = screen.getByLabelText("Close");
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true, bubbles: true });

    expect(document.activeElement).toBe(screen.getByText("Last body button"));
  });

  it("pulls focus back inside when Tab arrives with focus outside the dialog", () => {
    render(
      <Modal onClose={() => {}} title="Trap modal">
        <button>Inside</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", bubbles: true });

    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
  });

  it("leaves Tab to the inner dialog when modals nest", () => {
    render(
      <Modal onClose={() => {}} title="Outer">
        <button>Outer button</button>
        <Modal onClose={() => {}} title="Inner">
          <button>Inner button</button>
        </Modal>
      </Modal>,
    );

    const innerButton = screen.getByText("Inner button");
    innerButton.focus();
    fireEvent.keyDown(innerButton, { key: "Tab", bubbles: true });

    // Wrapped within the inner dialog — never out into the outer one.
    const innerDialog = screen.getByRole("dialog", { name: "Inner" });
    expect(innerDialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(innerDialog).getByLabelText("Close"));
  });
});
