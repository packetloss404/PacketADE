/**
 * Tile program (P4-S1) — focusPaneRequest: the NET-NEW focus+flash plumbing.
 *
 * Verifies `requestPaneFocus`:
 *   - activates the target workspace (activeWorkspaceId);
 *   - sets `layoutStore.activePaneId` to the target pane (the EXISTING mosaic
 *     focus mechanism — no new focus machinery);
 *   - publishes a transient flash request that clears itself after PANE_FLASH_MS;
 *   - a stale auto-clear never wipes a fresher request (token guard);
 *   - NEVER touches zoom state (focus+flash only, no auto-zoom, no rearrange).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

import { PANE_FLASH_MS, useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import type { Workspace, WorkspacePane } from "@/types/workspace";

function pane(id: string): WorkspacePane {
  return { id, agentId: "terminal", sessionId: null };
}

function ws(id: string, panes: WorkspacePane[]): Workspace {
  return {
    id,
    name: id,
    agents: [],
    panes,
    projectPath: "/proj",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  };
}

describe("workspaceStore.requestPaneFocus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      workspaces: [ws("w1", [pane("p1"), pane("p2")])],
      activeWorkspaceId: null,
      zoomedPaneId: null,
      focusPaneRequest: null,
    });
    useLayoutStore.setState({ activePaneId: "", projectPath: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates the workspace, sets activePaneId, and flashes — without touching zoom", () => {
    // A pre-existing zoom must survive an unrelated focus request.
    useWorkspaceStore.setState({ zoomedPaneId: "some-other-pane" });

    useWorkspaceStore.getState().requestPaneFocus("w1", "p1");

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("w1");
    expect(useLayoutStore.getState().activePaneId).toBe("p1");

    const req = useWorkspaceStore.getState().focusPaneRequest;
    expect(req).toMatchObject({ workspaceId: "w1", paneId: "p1" });
    expect(typeof req?.token).toBe("number");

    // Zoom is untouched.
    expect(useWorkspaceStore.getState().zoomedPaneId).toBe("some-other-pane");
  });

  it("the flash request clears itself after PANE_FLASH_MS", () => {
    useWorkspaceStore.getState().requestPaneFocus("w1", "p1");
    expect(useWorkspaceStore.getState().focusPaneRequest).not.toBeNull();

    vi.advanceTimersByTime(PANE_FLASH_MS);
    expect(useWorkspaceStore.getState().focusPaneRequest).toBeNull();
  });

  it("re-focusing the same pane re-triggers a fresh token", () => {
    useWorkspaceStore.getState().requestPaneFocus("w1", "p1");
    const first = useWorkspaceStore.getState().focusPaneRequest?.token;
    useWorkspaceStore.getState().requestPaneFocus("w1", "p1");
    const second = useWorkspaceStore.getState().focusPaneRequest?.token;
    expect(second).not.toBe(first);
  });

  it("a stale auto-clear never wipes a newer request (token guard)", () => {
    useWorkspaceStore.getState().requestPaneFocus("w1", "p1");
    vi.advanceTimersByTime(600);

    // A second request supersedes the first before the first timer fires.
    useWorkspaceStore.getState().requestPaneFocus("w1", "p2");
    const secondToken = useWorkspaceStore.getState().focusPaneRequest?.token;

    // First request's timer fires (at 1200) — must NOT clear the newer request.
    vi.advanceTimersByTime(600);
    expect(useWorkspaceStore.getState().focusPaneRequest?.paneId).toBe("p2");
    expect(useWorkspaceStore.getState().focusPaneRequest?.token).toBe(secondToken);

    // The second request's own timer clears it.
    vi.advanceTimersByTime(600);
    expect(useWorkspaceStore.getState().focusPaneRequest).toBeNull();
  });
});
