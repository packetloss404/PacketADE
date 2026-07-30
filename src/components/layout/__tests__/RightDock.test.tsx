/**
 * D2 / P0-2 — the shared dock's rendering contract.
 *
 * Complements the pure-arithmetic tests in `rightDockStore.test.ts`: this file
 * proves the component honours the contract — one panel rendered at a time,
 * inline width clamped to what the viewport can afford, and a graceful
 * collapse (rather than a starved canvas) at the 800px minimum window.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FileText, GitBranch, PanelLeft } from "lucide-react";
import { RightDock, type RightDockPanel } from "@/components/layout/RightDock";
import { useRightDockStore } from "@/stores/rightDockStore";
import { REMOTE_UNSUPPORTED_TOOLTIP } from "@/lib/remoteConversation";

function setViewport(width: number) {
  (window as unknown as { innerWidth: number }).innerWidth = width;
  fireEvent(window, new Event("resize"));
}

const panels: RightDockPanel[] = [
  { id: "editor", label: "Editor", icon: FileText, render: () => <div>editor body</div> },
  { id: "git", label: "Git", icon: GitBranch, render: () => <div>git body</div> },
];

describe("RightDock", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.getState().reset();
    // The Workspace dock ships collapsed; these tests exercise the expanded
    // rendering path, so opt in explicitly.
    useRightDockStore.getState().setExpanded("workspace", true);
    setViewport(1024);
  });

  it("renders nothing when no panels are registered", () => {
    const { container } = render(
      <RightDock surface="workspace" panels={[]} ariaLabel="Workspace panels" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows exactly one panel body at a time", () => {
    render(<RightDock surface="workspace" panels={panels} ariaLabel="Workspace panels" />);

    expect(screen.getByText("editor body")).toBeInTheDocument();
    expect(screen.queryByText("git body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Git" }));
    expect(screen.getByText("git body")).toBeInTheDocument();
    expect(screen.queryByText("editor body")).not.toBeInTheDocument();
  });

  it("clamps the inline width to what the viewport can afford", () => {
    useRightDockStore.getState().setWidth("workspace", 720);
    const { container } = render(
      <RightDock surface="workspace" panels={panels} ariaLabel="Workspace panels" />,
    );
    // 1024 − 44 rail − 240 sidebar − 320 min centre = 420.
    expect(container.querySelector("aside")!.style.width).toBe("420px");
    expect(container.querySelector("aside")!.getAttribute("data-dock-overlay")).toBe("false");

    setViewport(1600);
    expect(container.querySelector("aside")!.style.width).toBe("720px");
  });

  it("collapses to the icon rail at the 800px minimum window instead of starving the canvas", () => {
    const { container } = render(
      <RightDock surface="workspace" panels={panels} ariaLabel="Workspace panels" />,
    );
    expect(container.querySelector("aside")).not.toBeNull();

    setViewport(800);

    // No inline dock: the rail is all that remains in flow.
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByTestId("right-dock-rail-workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show right pane" })).toBeInTheDocument();

    // Explicitly expanding at this width floats the panel and keeps the rail.
    fireEvent.click(screen.getByRole("button", { name: "Show right pane" }));
    const aside = container.querySelector("aside")!;
    expect(aside.getAttribute("data-dock-overlay")).toBe("true");
    expect(screen.getByTestId("right-dock-rail-workspace")).toBeInTheDocument();
    // 800 − 44 − 240 − 48 peek = 468 cap; the 420 default fits under it.
    expect(Number.parseInt(aside.style.width, 10)).toBeLessThanOrEqual(468);

    // Widening restores the inline dock automatically.
    setViewport(1600);
    expect(container.querySelector("aside")!.getAttribute("data-dock-overlay")).toBe("false");
  });

  it("falls back to the first selectable panel and never selects a disabled one", () => {
    useRightDockStore.getState().openPanel("workspace", "editor");
    const gated: RightDockPanel[] = [
      {
        id: "editor",
        label: "Editor",
        icon: FileText,
        disabled: true,
        disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
        render: () => <div>editor body</div>,
      },
      { id: "git", label: "Git", icon: GitBranch, render: () => <div>git body</div> },
    ];
    render(<RightDock surface="workspace" panels={gated} ariaLabel="Workspace panels" />);

    const editorTab = screen.getByRole("tab", { name: "Editor" });
    expect(editorTab).toBeDisabled();
    expect(editorTab.getAttribute("title")).toContain(REMOTE_UNSUPPORTED_TOOLTIP);
    expect(screen.queryByText("editor body")).not.toBeInTheDocument();
    expect(screen.getByText("git body")).toBeInTheDocument();

    fireEvent.click(editorTab);
    expect(screen.queryByText("editor body")).not.toBeInTheDocument();
  });

  it("persists width per surface through the shared resizer", () => {
    render(<RightDock surface="agents" panels={[
      { id: "inspector", label: "Inspector", icon: PanelLeft, render: () => <div>i</div> },
    ]} ariaLabel="Inspector views" />);

    const handle = screen.getByRole("separator", { name: /resize right pane/i });
    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 700 });
    fireEvent.pointerUp(window);

    const saved = JSON.parse(localStorage.getItem("packetade:right-dock-v1")!);
    expect(saved.agents.width).toBe(1024 - 700);
    // The Workspace surface keeps its own width.
    expect(saved.workspace.width).toBe(420);
  });
});
