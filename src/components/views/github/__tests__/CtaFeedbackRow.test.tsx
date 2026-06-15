import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CtaFeedbackRow } from "@/components/views/github/CtaFeedbackRow";

// CtaFeedbackRow is a tiny tone-coded status strip used under the issue /
// investigation action bars. The component's prop type is
// `NonNullable<CtaFeedback>` (the parent is responsible for the null
// branch), so the spec's "renders null when feedback is null" case is not
// reachable here — we instead verify the three tone branches and the
// dismiss callback wiring.

describe("CtaFeedbackRow", () => {
  it("applies the tone-specific color class for success / error / info", () => {
    const { rerender, container } = render(
      <CtaFeedbackRow
        feedback={{ tone: "success", message: "Saved" }}
        onDismiss={() => {}}
      />,
    );

    // Root strip element is the first child of the container.
    const successRoot = container.firstElementChild!;
    expect(successRoot.className).toContain("text-accent-green");
    expect(successRoot.className).toContain("bg-accent-green/10");

    rerender(
      <CtaFeedbackRow
        feedback={{ tone: "error", message: "Boom" }}
        onDismiss={() => {}}
      />,
    );
    const errorRoot = container.firstElementChild!;
    expect(errorRoot.className).toContain("text-accent-red");
    expect(errorRoot.className).toContain("bg-accent-red/10");

    rerender(
      <CtaFeedbackRow
        feedback={{ tone: "info", message: "FYI" }}
        onDismiss={() => {}}
      />,
    );
    const infoRoot = container.firstElementChild!;
    expect(infoRoot.className).toContain("text-accent-blue");
    expect(infoRoot.className).toContain("bg-accent-blue/10");

    // The message is rendered in every tone.
    expect(screen.getByText("FYI")).toBeInTheDocument();
  });

  it("renders the optional link affordance and fires dismiss", () => {
    const onDismiss = vi.fn();
    const onLinkClick = vi.fn();
    render(
      <CtaFeedbackRow
        feedback={{
          tone: "success",
          message: "Saved",
          linkLabel: "View",
          onLinkClick,
        }}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(onLinkClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
