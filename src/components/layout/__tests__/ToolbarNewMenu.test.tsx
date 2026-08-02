/**
 * The global "+ New" menu.
 *
 * Creation-flows review: the app's top-level object — the Workspace — was
 * missing from the app's top-level create menu, while the button's own tooltip
 * promised "Create a new session, flight, or issue".
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined) };
});

// Status chips poll on their own timers — irrelevant here and a source of
// act() noise.
vi.mock("@/components/layout/SidecarStatusChip", () => ({ SidecarStatusChip: () => null }));
vi.mock("@/components/layout/RunningAgentsChip", () => ({ RunningAgentsChip: () => null }));

import { Toolbar } from "@/components/layout/Toolbar";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

describe("Toolbar '+ New' menu", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, creationRequest: null });
    useAppStore.setState({ activeView: "agents" });
  });

  it("tells the truth about what it creates", () => {
    render(<Toolbar />);

    expect(screen.getByTitle("Create a new workspace, flight, or issue")).toBeInTheDocument();
  });

  it("can create a workspace", () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByTitle("Create a new workspace, flight, or issue"));
    fireEvent.click(screen.getByText("New Workspace"));

    // The Workspace surface owns the one creation form; the Toolbar publishes
    // a request and activates that surface.
    expect(useWorkspaceStore.getState().creationRequest).not.toBeNull();
    expect(useAppStore.getState().activeView).toBe("workspace");
  });

  it("shows the authoritative remote path and disables the local folder picker", () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: "remote-workspace",
      workspaces: [
        {
          id: "remote-workspace",
          name: "Remote repo",
          agents: ["packetcode"],
          panes: [],
          projectPath: "C:\\stale-local-repo",
          remoteProjectPath: "/srv/current-repo",
          serverId: "ssh-1",
          createdAt: 1,
          updatedAt: 1,
          status: "active",
        },
      ],
    });

    render(<Toolbar />);

    expect(
      screen.getByTitle(
        "Remote project: /srv/current-repo (Remote repo) — change it in Workspace settings",
      ),
    ).toBeDisabled();
  });
});
