import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useReviewStore } from "@/stores/reviewStore";
import type { Workspace } from "@/types/workspace";

// Track PTY-owner mounts. TerminalPane owns the agent PTY (useTerminalSession
// auto-starts a session ~200ms after mount), so a second mounted TerminalPane
// for the same paneId IS the duplicate-agent-spawn bug this suite guards
// against, and any unmount/remount across zoom would kill the live PTY.
const mountLog = vi.hoisted(() => [] as string[]);

vi.mock("@/components/session/TerminalPane", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPane: ({ paneId }: { paneId: string }) => {
      useEffect(() => {
        mountLog.push(`mount:${paneId}`);
        return () => {
          mountLog.push(`unmount:${paneId}`);
        };
      }, [paneId]);
      return <div data-testid={`terminal-${paneId}`} />;
    },
  };
});

function makeWorkspace(): Workspace {
  const now = Date.now();
  return {
    id: "ws-1",
    name: "Zoom test workspace",
    agents: ["claude-code", "codex"],
    panes: [
      { id: "pane-a", agentId: "claude-code", sessionId: null },
      { id: "pane-b", agentId: "codex", sessionId: null },
    ],
    projectPath: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

function terminalCount(container: HTMLElement, paneId: string): number {
  return container.querySelectorAll(`[data-testid="terminal-${paneId}"]`).length;
}

describe("WorkspaceMosaicContainer zoom", () => {
  beforeEach(() => {
    mountLog.length = 0;
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
    useReviewStore.setState({ open: false, conversationId: null, focusPath: null });
  });

  it("mounts exactly one PTY-owning pane per tile while zoomed (no duplicate agent spawn)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-b")).toBe(1);

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });

    // The old zoom overlay mounted a SECOND WorkspacePane for the zoomed
    // pane, spawning a duplicate agent PTY. Exactly one instance must exist.
    expect(terminalCount(container, "pane-a")).toBe(1);
    // Non-zoomed panes stay mounted (hidden) so their PTYs persist.
    expect(terminalCount(container, "pane-b")).toBe(1);

    expect(mountLog.filter((e) => e === "mount:pane-a")).toHaveLength(1);
    expect(mountLog.filter((e) => e === "mount:pane-b")).toHaveLength(1);
    expect(mountLog.filter((e) => e.startsWith("unmount:"))).toHaveLength(0);
  });

  it("preserves the mounted panes across zoom in and out (PTY persistence)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });
    // Escape exits zoom
    fireEvent.keyDown(window, { key: "Escape" });

    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
    expect(terminalCount(container, "pane-a")).toBe(1);
    expect(terminalCount(container, "pane-b")).toBe(1);
    // No pane ever unmounted or remounted across the zoom round-trip.
    expect(mountLog.filter((e) => e === "mount:pane-a")).toHaveLength(1);
    expect(mountLog.filter((e) => e === "mount:pane-b")).toHaveLength(1);
    expect(mountLog.filter((e) => e.startsWith("unmount:"))).toHaveLength(0);
  });

  it("applies the CSS maximize hooks to the already-mounted tile", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const { container } = render(<WorkspaceMosaicContainer workspace={workspace} />);

    const mosaicEl = container.querySelector(".mosaic");
    expect(mosaicEl).not.toBeNull();
    expect(mosaicEl!.classList.contains("mosaic-zoom-active")).toBe(false);
    expect(container.querySelector('[data-pane-zoomed="true"]')).toBeNull();

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });

    expect(mosaicEl!.classList.contains("mosaic-zoom-active")).toBe(true);
    const zoomedWrapper = container.querySelector('[data-pane-zoomed="true"]');
    expect(zoomedWrapper).not.toBeNull();
    // The zoom marker sits on pane-a's wrapper inside its mosaic tile, which
    // mosaic-overrides.css maximizes in place.
    expect(
      zoomedWrapper!.querySelector('[data-testid="terminal-pane-a"]'),
    ).not.toBeNull();
    expect(zoomedWrapper!.closest(".mosaic-tile")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(mosaicEl!.classList.contains("mosaic-zoom-active")).toBe(false);
    expect(container.querySelector('[data-pane-zoomed="true"]')).toBeNull();
  });

  // ---- P3-S1 condition-based Escape layering --------------------------

  it("zoom-exit no-ops while the review surface is open (Escape closes review first, not zoom)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspaceMosaicContainer workspace={workspace} />);

    act(() => {
      useWorkspaceStore.getState().setZoomedPane("pane-a");
    });
    // Review is open (the tile auto-zoomed for it). Its own Escape handler
    // owns this keypress; the mosaic zoom-exit must stand down so the two
    // never double-fire off one Escape.
    act(() => {
      useReviewStore.setState({ open: true, conversationId: "conv-1" });
    });

    fireEvent.keyDown(window, { key: "Escape" });
    // Zoom survives — review would have consumed this Escape.
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("pane-a");

    // Once review is closed, the next Escape exits zoom as usual.
    act(() => {
      useReviewStore.setState({ open: false, conversationId: null });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });
});

/**
 * Pane add/remove must not remount a SURVIVING tile.
 *
 * A remount runs `useTerminalSession`'s unmount cleanup (`killPty`) and then
 * auto-starts a fresh PTY, so remounting a survivor kills a running agent
 * mid-task. `MosaicRoot.renderRecursively` flattens each split into a keyed
 * Fragment, so a leaf that changes DEPTH lands under a differently-keyed
 * Fragment and React remounts it — reordering within one split's children is
 * safe, re-nesting is not.
 */
describe("WorkspaceMosaicContainer pane add/remove stability", () => {
  function withPanes(ids: string[]): Workspace {
    return {
      ...makeWorkspace(),
      agents: ids.map(() => "claude-code" as const),
      panes: ids.map((id) => ({ id, agentId: "claude-code" as const, sessionId: null })),
    };
  }

  beforeEach(() => {
    mountLog.length = 0;
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
  });

  it("adding panes one at a time never unmounts an already-running pane", () => {
    const { rerender } = render(<WorkspaceMosaicContainer workspace={withPanes(["pane-a"])} />);

    for (const ids of [
      ["pane-a", "pane-b"],
      ["pane-a", "pane-b", "pane-c"],
      ["pane-a", "pane-b", "pane-c", "pane-d"],
      ["pane-a", "pane-b", "pane-c", "pane-d", "pane-e"],
    ]) {
      act(() => {
        rerender(<WorkspaceMosaicContainer workspace={withPanes(ids)} />);
      });
    }

    // The regression: 2 -> 3 logged "unmount:pane-b, mount:pane-b", killing a
    // running codex when a terminal was added beside it.
    expect(mountLog.filter((e) => e.startsWith("unmount:"))).toEqual([]);
    for (const id of ["pane-a", "pane-b", "pane-c", "pane-d", "pane-e"]) {
      expect(mountLog.filter((e) => e === `mount:${id}`)).toHaveLength(1);
    }
  });

  it("removing a middle pane unmounts only that pane", () => {
    const { rerender } = render(
      <WorkspaceMosaicContainer workspace={withPanes(["pane-a", "pane-b", "pane-c"])} />,
    );
    mountLog.length = 0;

    act(() => {
      rerender(<WorkspaceMosaicContainer workspace={withPanes(["pane-a", "pane-c"])} />);
    });

    // Previously the parent split collapsed to a bare leaf, lifting pane-c a
    // level and restarting it.
    expect(mountLog).toEqual(["unmount:pane-b"]);
  });

  it("renders exactly one tile per pane at every count (no duplicate leaves)", () => {
    for (let n = 1; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => `pane-${i}`);
      const { container, unmount } = render(
        <WorkspaceMosaicContainer workspace={withPanes(ids)} />,
      );
      for (const id of ids) {
        // buildPresetTree used to clamp a short id list with `Math.min`,
        // repeating the last id (n=3, n=5 -> two tiles, two PTYs for one pane)
        // and dropping ids past the preset's capacity (n=7, n=8 -> no tile).
        expect(terminalCount(container, id), `pane ${id} at n=${n}`).toBe(1);
      }
      unmount();
    }
  });
});
