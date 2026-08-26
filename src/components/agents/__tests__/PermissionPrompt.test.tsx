/**
 * Inline approval card — chrome invariants (Q2 design review).
 *
 * Two defects this file exists to keep fixed:
 *
 *  1. The accent "spine" used to be a single `border-accent-amber/60` sitting
 *     alongside `border border-l-[3px]`, i.e. a border COLOR on all four edges.
 *     The card read as an outlined box rather than a neutral card with one
 *     accent edge. The box color and the leading-edge color are now separate
 *     classes and must stay separate.
 *  2. Deny carried `ml-auto` as a direct child of a `flex-wrap` row, so a
 *     narrow mosaic tile could wrap it onto its own line — splitting the exact
 *     pair the Y/N keys mirror. Allow and Deny are now one non-wrapping group;
 *     the assertion is STRUCTURAL, not a snapshot of incidental ordering.
 *
 * Also guarded here: the `<kbd>` hints stay `aria-hidden` (they used to make
 * Allow's accessible name read "AllowY") with `aria-keyshortcuts` as the
 * accessible route, the split-button scope menu and its call shapes, and the
 * `selectable` class that keeps tool arguments copyable under the global
 * `body { user-select: none }`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PermissionPrompt } from "../PermissionPrompt";
import type { PendingPermission } from "@/types/agent-conversation";

function makeItem(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "tool-1",
    name: "bash",
    arguments: '{"command":"npm test"}',
    ...overrides,
  } as PendingPermission;
}

/** A command `isDestructiveBash` recognises — drives the red variant. */
const DESTRUCTIVE = '{"command":"rm -rf build"}';

function renderPrompt(props: Partial<Parameters<typeof PermissionPrompt>[0]> = {}) {
  const handlers = {
    onAllowOnce: vi.fn(),
    onAllowAlways: vi.fn(),
    onDeny: vi.fn(),
    onAllowAlwaysWithPattern: vi.fn(),
  };
  const utils = render(
    <PermissionPrompt item={makeItem()} {...handlers} {...props} />,
  );
  return { ...utils, ...handlers };
}

function card(): HTMLElement {
  const el = document.querySelector("[data-approval-id]");
  if (!el) throw new Error("approval card not rendered");
  return el as HTMLElement;
}

describe("PermissionPrompt — accent spine (defect 1)", () => {
  it("colors ONLY the leading edge: a neutral box class plus a separate border-l color", () => {
    renderPrompt();
    const classes = card().className.split(/\s+/);

    // Structure the spine depends on: a 1px box + a 3px leading edge.
    expect(classes).toContain("border");
    expect(classes).toContain("border-l-[3px]");

    // All four edges neutral…
    expect(classes).toContain("border-bg-border");
    // …and exactly one accent edge, applied as border-LEFT-color.
    expect(classes).toContain("border-l-accent-amber");

    // The regression: an accent border color with no edge qualifier paints
    // every edge. `border-l-*` is the only accent border class allowed here.
    const accentBorders = classes.filter((c) => /^border-accent-/.test(c));
    expect(accentBorders).toEqual([]);
  });

  it("destructive variant escalates the spine to red and leaves the box neutral", () => {
    renderPrompt({ item: makeItem({ arguments: DESTRUCTIVE }) });
    const classes = card().className.split(/\s+/);

    expect(classes).toContain("border-l-accent-red");
    expect(classes).toContain("border-bg-border");
    expect(classes).not.toContain("border-l-accent-amber");
    // Same rule as above: no all-edge accent border in the red variant either.
    expect(classes.filter((c) => /^border-accent-/.test(c))).toEqual([]);

    // Escalation the user can actually read, not just a hue.
    expect(screen.getByText("Destructive")).toBeInTheDocument();
    expect(
      screen.getByText(/delete or overwrite files that git is not tracking/i),
    ).toBeInTheDocument();
  });

  it("does not show the consequence sentence on an ordinary prompt", () => {
    renderPrompt();
    expect(
      screen.queryByText(/delete or overwrite files that git is not tracking/i),
    ).not.toBeInTheDocument();
  });

  it("uses no /opacity modifier on the spine — Graphite tokens cannot compile one", () => {
    // `tailwind.config.ts` defines the accents as `var(--color-…)` strings with
    // no `<alpha-value>`, so `border-l-accent-amber/70` emits no CSS at all and
    // the spine silently disappears. Fail loudly if someone re-adds a modifier.
    for (const args of ['{"command":"npm test"}', DESTRUCTIVE]) {
      const { unmount } = renderPrompt({ item: makeItem({ arguments: args }) });
      const spine = card()
        .className.split(/\s+/)
        .filter((c) => c.startsWith("border-l-accent"));
      expect(spine).toHaveLength(1);
      expect(spine[0]).not.toContain("/");
      unmount();
    }
  });
});

describe("PermissionPrompt — Allow/Deny never wrap apart (defect 2)", () => {
  it("keeps Allow and Deny inside ONE non-wrapping flex group", () => {
    renderPrompt();
    const group = screen.getByTestId("approval-verbs");
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });

    expect(group).toContainElement(allow);
    expect(group).toContainElement(deny);

    // The group itself must not wrap — that is what makes the pair atomic at
    // any tile width, rather than relying on the row happening to fit.
    const groupClasses = group.className.split(/\s+/);
    expect(groupClasses).toContain("flex");
    expect(groupClasses).not.toContain("flex-wrap");
  });

  it("gives the pair no ml-auto — only the tertiary 'with reason…' floats right", () => {
    renderPrompt();
    const group = screen.getByTestId("approval-verbs");
    const deny = screen.getByRole("button", { name: "Deny" });
    const reason = screen.getByRole("button", { name: /with reason/i });

    // `ml-auto` on Deny is what let a wrapping row break the pair.
    expect(deny.className).not.toContain("ml-auto");
    expect(group.className).not.toContain("ml-auto");
    expect(reason.className.split(/\s+/)).toContain("ml-auto");

    // …and the right-floating affordance is outside the verb group.
    expect(group).not.toContainElement(reason);
  });

  it("weights Allow and Deny equally — same tint ramp on a safety gate", () => {
    renderPrompt();
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });

    expect(allow.className).toContain("bg-accent-green/15");
    expect(allow.className).toContain("hover:bg-accent-green/25");
    expect(deny.className).toContain("bg-accent-red/15");
    expect(deny.className).toContain("hover:bg-accent-red/25");

    // Neither verb may become a solid CTA.
    for (const el of [allow, deny]) {
      const classes = el.className.split(/\s+/);
      expect(classes).not.toContain("bg-accent-green");
      expect(classes).not.toContain("bg-accent-red");
      expect(classes).not.toContain("bg-accent-amber");
    }
  });
});

describe("PermissionPrompt — keyboard hints", () => {
  it("exposes Y/N via aria-keyshortcuts while keeping the <kbd> chips hidden", () => {
    renderPrompt({ showKeyboardHints: true });
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });

    expect(allow).toHaveAttribute("aria-keyshortcuts", "y");
    expect(deny).toHaveAttribute("aria-keyshortcuts", "n");

    // The chips are decoration; if they leak into the accessible name the
    // button reads "AllowY", which is what `aria-hidden` prevents.
    for (const el of [allow, deny]) {
      const kbd = el.querySelector("kbd");
      expect(kbd).not.toBeNull();
      expect(kbd).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("omits aria-keyshortcuts when this card is not the Y/N target", () => {
    renderPrompt();
    expect(screen.getByRole("button", { name: "Allow" })).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
    expect(screen.getByRole("button", { name: "Deny" })).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
    expect(document.querySelector("kbd")).toBeNull();
  });
});

describe("PermissionPrompt — surviving behaviour", () => {
  it("Allow / Deny still call the plain handlers", () => {
    const { onAllowOnce, onDeny } = renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAllowOnce).toHaveBeenCalledWith("tool-1");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledWith("tool-1");
  });

  it("the scope menu still opens upward and offers once / session / saved rule", () => {
    const { onAllowAlways, onAllowAlwaysWithPattern } = renderPrompt({
      conversationAllowedTools: [],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Allow with a wider scope" }),
    );

    const menu = screen.getByRole("menu");
    // Inline in a transcript the card is almost always last in the scroll, so
    // the menu must open upward or it opens off-screen.
    expect(menu.className).toContain("bottom-full");

    expect(
      screen.getByRole("menuitem", { name: "Allow once" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Allow for this session/ }),
    );
    expect(onAllowAlways).toHaveBeenCalledWith("tool-1");

    fireEvent.click(
      screen.getByRole("button", { name: "Allow with a wider scope" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Always allow/ }));
    expect(onAllowAlwaysWithPattern).toHaveBeenCalledWith(
      "tool-1",
      "Bash(npm test:*)",
    );
  });

  it("disables the saved-rule scope when the pattern is already allowed", () => {
    renderPrompt({ conversationAllowedTools: ["Bash(npm test:*)"] });
    fireEvent.click(
      screen.getByRole("button", { name: "Allow with a wider scope" }),
    );
    expect(screen.getByRole("menuitem", { name: /Always allow/ })).toBeDisabled();
    expect(screen.getByText("already in")).toBeInTheDocument();
  });

  it("hides the saved-rule scope when the conversation has no allowlist", () => {
    // `undefined` means "all tools allowed" — appending would NARROW access.
    renderPrompt({ conversationAllowedTools: undefined });
    fireEvent.click(
      screen.getByRole("button", { name: "Allow with a wider scope" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: /Always allow/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps tool arguments copyable under the global user-select:none", () => {
    renderPrompt();
    for (const pre of Array.from(document.querySelectorAll("pre"))) {
      expect(pre.className.split(/\s+/)).toContain("selectable");
    }
  });

  it("deny-with-reason still forwards the steering text", () => {
    const { onDeny } = renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: /with reason/i }));
    fireEvent.change(screen.getByLabelText("Denial reason"), {
      target: { value: "  use the test script instead  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Deny & steer/ }));
    expect(onDeny).toHaveBeenCalledWith("tool-1", "use the test script instead");
  });
});
