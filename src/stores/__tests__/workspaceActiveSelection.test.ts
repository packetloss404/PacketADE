import { beforeEach, describe, expect, it, vi } from "vitest";

// workspaceStore persists through `@/lib/tauri`, which invokes Tauri commands.
// Stub the transport and keep the store real — what is under test is the
// localStorage round-trip, not the backend save.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { Workspace } from "@/types/workspace";

const ACTIVE_KEY = "packetbench:workspace-active-id";

function workspace(id: string, status: Workspace["status"] = "active"): Workspace {
  return {
    id,
    name: id,
    projectPath: `D:\\projects\\${id}`,
    panes: [],
    agents: [],
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("workspace selection survives a restart", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
  });

  it("writes the selected workspace id to localStorage", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1"), workspace("ws-2")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-2");

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-2");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("ws-2");
  });

  it("clears the stored id when the selection is cleared", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("ws-1");

    useWorkspaceStore.getState().setActiveWorkspace(null);
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("drops a stored id whose workspace no longer exists", async () => {
    // A workspace deleted since the last run must not point the view at a
    // ghost — the restore validates against the hydrated list rather than
    // trusting the stored id.
    localStorage.setItem(ACTIVE_KEY, "ws-gone");
    const { readActiveWorkspaceIdForTest } = await import("@/stores/workspaceStore");
    expect(readActiveWorkspaceIdForTest([workspace("ws-1")])).toBeNull();
  });

  it("drops a stored id whose workspace has been archived", async () => {
    localStorage.setItem(ACTIVE_KEY, "ws-old");
    const { readActiveWorkspaceIdForTest } = await import("@/stores/workspaceStore");
    expect(readActiveWorkspaceIdForTest([workspace("ws-old", "archived")])).toBeNull();
  });

  it("restores a stored id that still resolves to a live workspace", async () => {
    localStorage.setItem(ACTIVE_KEY, "ws-2");
    const { readActiveWorkspaceIdForTest } = await import("@/stores/workspaceStore");
    expect(readActiveWorkspaceIdForTest([workspace("ws-1"), workspace("ws-2")])).toBe("ws-2");
  });

  it("clears the stored id when the active workspace is deleted", () => {
    useWorkspaceStore.setState({ workspaces: [workspace("ws-1")] });
    useWorkspaceStore.getState().setActiveWorkspace("ws-1");

    useWorkspaceStore.getState().deleteWorkspace("ws-1");

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });
});
