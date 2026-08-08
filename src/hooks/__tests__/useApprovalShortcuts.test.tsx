/**
 * Approval hotkey ownership.
 *
 * These keys are bound on `window`, so every waiting pane's handler runs on one
 * keypress and `preventDefault` cannot stop a sibling — they share a target.
 * Ownership therefore has to be decided INSIDE each handler, and that is what
 * these tests pin down.
 *
 * The regression being guarded: with no ownership check at all, one `y` wrote
 * `y\n` into every waiting agent's stdin, silently approving actions in panes
 * the user had never looked at.
 */
import { useRef } from "react";
import { render, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApprovalShortcuts, resetApprovalRegistry } from "@/hooks/useApprovalShortcuts";
import { useLayoutStore } from "@/stores/layoutStore";

function Pane({
  paneId,
  showApproval = true,
  onApprove = () => {},
  onDeny = () => {},
  onAbort = () => {},
}: {
  paneId: string;
  showApproval?: boolean;
  onApprove?: () => void;
  onDeny?: () => void;
  onAbort?: () => void;
}) {
  const xtermRef = useRef(null);
  useApprovalShortcuts({ showApproval, paneId, xtermRef, onApprove, onDeny, onAbort });
  return <div data-testid={paneId} />;
}

beforeEach(() => {
  resetApprovalRegistry();
  useLayoutStore.setState({ activePaneId: "" });
});

afterEach(() => {
  resetApprovalRegistry();
});

describe("a single pane awaiting approval", () => {
  it("answers y/n/Escape without needing to be clicked first", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const onAbort = vi.fn();
    render(<Pane paneId="pane-a" onApprove={onApprove} onDeny={onDeny} onAbort={onAbort} />);

    // activePaneId is "" — nothing has been clicked. Requiring a click here
    // would break the single-agent workflow for no safety gain.
    fireEvent.keyDown(window, { key: "y" });
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "n" });
    expect(onDeny).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed into an input or a terminal", () => {
    const onApprove = vi.fn();
    const { container } = render(<Pane paneId="pane-a" onApprove={onApprove} />);
    const input = document.createElement("input");
    const termHelper = document.createElement("textarea");
    container.append(input, termHelper);

    fireEvent.keyDown(input, { key: "y" });
    fireEvent.keyDown(termHelper, { key: "y" });

    expect(onApprove).not.toHaveBeenCalled();
  });

  it("ignores a keypress another layer already handled", () => {
    const onApprove = vi.fn();
    render(<Pane paneId="pane-a" onApprove={onApprove} />);

    const handled = new KeyboardEvent("keydown", { key: "y", cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);

    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe("two panes awaiting approval", () => {
  it("approves ONLY the active pane", () => {
    const paneA = vi.fn();
    const paneB = vi.fn();
    render(
      <>
        <Pane paneId="pane-a" onApprove={paneA} />
        <Pane paneId="pane-b" onApprove={paneB} />
      </>,
    );
    useLayoutStore.setState({ activePaneId: "pane-a" });

    fireEvent.keyDown(window, { key: "y" });

    // The regression: BOTH fired, so an agent the user never read got a `y`
    // written straight into its stdin.
    expect(paneA).toHaveBeenCalledTimes(1);
    expect(paneB).not.toHaveBeenCalled();
  });

  it("denies and aborts only the active pane too", () => {
    const denyA = vi.fn();
    const denyB = vi.fn();
    const abortA = vi.fn();
    const abortB = vi.fn();
    render(
      <>
        <Pane paneId="pane-a" onDeny={denyA} onAbort={abortA} />
        <Pane paneId="pane-b" onDeny={denyB} onAbort={abortB} />
      </>,
    );
    useLayoutStore.setState({ activePaneId: "pane-b" });

    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(denyB).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
    expect(denyA).not.toHaveBeenCalled();
    expect(abortA).not.toHaveBeenCalled();
  });

  it("answers nothing when neither is active — the keypress is ambiguous", () => {
    const paneA = vi.fn();
    const paneB = vi.fn();
    render(
      <>
        <Pane paneId="pane-a" onApprove={paneA} />
        <Pane paneId="pane-b" onApprove={paneB} />
      </>,
    );

    fireEvent.keyDown(window, { key: "y" });

    // Silence is the safe answer: the user picks a pane (clicking makes it
    // active) or uses that pane's on-screen Approve/Deny buttons.
    expect(paneA).not.toHaveBeenCalled();
    expect(paneB).not.toHaveBeenCalled();
  });

  it("hands the hotkey back once the other pane stops waiting", () => {
    const paneA = vi.fn();
    const paneB = vi.fn();
    const { rerender } = render(
      <>
        <Pane paneId="pane-a" onApprove={paneA} />
        <Pane paneId="pane-b" onApprove={paneB} />
      </>,
    );

    // Ambiguous while both wait.
    fireEvent.keyDown(window, { key: "y" });
    expect(paneA).not.toHaveBeenCalled();

    // B's prompt resolves; A is now the only one waiting and owns the key
    // again — the registry must have released B.
    rerender(
      <>
        <Pane paneId="pane-a" onApprove={paneA} />
        <Pane paneId="pane-b" showApproval={false} onApprove={paneB} />
      </>,
    );

    fireEvent.keyDown(window, { key: "y" });
    expect(paneA).toHaveBeenCalledTimes(1);
    expect(paneB).not.toHaveBeenCalled();
  });

  it("releases its registration on unmount", () => {
    const paneA = vi.fn();
    const paneB = vi.fn();
    const { unmount } = render(<Pane paneId="pane-b" onApprove={paneB} />);
    render(<Pane paneId="pane-a" onApprove={paneA} />);

    fireEvent.keyDown(window, { key: "y" });
    expect(paneA).not.toHaveBeenCalled();

    // Closing a waiting pane must not leave a phantom claimant that keeps the
    // survivor permanently ambiguous.
    unmount();
    fireEvent.keyDown(window, { key: "y" });
    expect(paneA).toHaveBeenCalledTimes(1);
  });
});
