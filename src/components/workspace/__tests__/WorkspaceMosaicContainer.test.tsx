import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { useWorkspaceStore } from "@/stores/workspaceStore";
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
});
