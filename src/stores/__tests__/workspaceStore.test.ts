import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useServerStore } from "@/stores/serverStore";
import { useLayoutStore } from "@/stores/layoutStore";

describe("workspaceStore.createWorkspace", () => {
  beforeEach(() => {
    // Reset workspaceStore between tests.
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      keepTerminalsAlive: false,
      zoomedPaneId: null,
    });
    // Reset relevant slices that createWorkspace touches.
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      connectionStates: {},
      knownHostsPath: null,
    });
    useLayoutStore.setState({ projectPath: "" });
  });

  it("creates a local workspace with no server metadata", () => {
    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Local WS", ["claude-code"], "C:\\projects\\demo", {
        prompt: "Hi",
      });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
    expect(ws).toBeDefined();
    expect(ws!.serverId).toBeUndefined();
    expect(ws!.remoteProjectPath).toBeUndefined();
    expect(ws!.projectPath).toBe("C:\\projects\\demo");
    expect(ws!.panes).toHaveLength(1);
    expect(ws!.panes[0].agentId).toBe("claude-code");
    expect(ws!.prompt).toBe("Hi");
  });

  it("creates a remote workspace when serverId + remoteProjectPath are provided", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: ["claude-code"],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Remote WS", ["claude-code"], "ignored-local", {
        serverId: "srv-1",
        remoteProjectPath: "/srv/app",
      });

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
    expect(ws).toBeDefined();
    expect(ws!.serverId).toBe("srv-1");
    expect(ws!.remoteProjectPath).toBe("/srv/app");
    // For remote workspaces the stored projectPath is the remote path so
    // legacy code reading `workspace.projectPath` still gets a label.
    expect(ws!.projectPath).toBe("/srv/app");
  });

  it("throws if serverId refers to an unknown server", () => {
    expect(() =>
      useWorkspaceStore
        .getState()
        .createWorkspace("Bad WS", ["claude-code"], "/srv/app", {
          serverId: "srv-missing",
          remoteProjectPath: "/srv/app",
        }),
    ).toThrow(/does not match any registered server/i);

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("throws if serverId is provided without remoteProjectPath", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: [],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });

    expect(() =>
      useWorkspaceStore
        .getState()
        .createWorkspace("Missing path", ["claude-code"], "ignored-local", {
          serverId: "srv-1",
        }),
    ).toThrow(/remoteProjectPath is required/i);
  });

  it("does not push the remote workspace path into layoutStore.projectPath", () => {
    useServerStore.setState({
      servers: [
        {
          id: "srv-1",
          name: "Demo",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: [],
          hostFingerprint: "SHA256:dummy",
        },
      ],
    });
    useLayoutStore.setState({ projectPath: "C:\\original\\local" });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Remote WS", ["claude-code"], "ignored-local", {
        serverId: "srv-1",
        remoteProjectPath: "/srv/app",
      });

    useWorkspaceStore.getState().setActiveWorkspace(id);

    // layoutStore.projectPath should be untouched — local-only state must
    // not be hijacked by a remote workspace.
    expect(useLayoutStore.getState().projectPath).toBe("C:\\original\\local");
  });

  it("syncs layoutStore.projectPath when activating a local workspace", () => {
    useLayoutStore.setState({ projectPath: "C:\\old" });

    const id = useWorkspaceStore
      .getState()
      .createWorkspace("Local WS", ["claude-code"], "C:\\new\\proj");

    useWorkspaceStore.getState().setActiveWorkspace(id);

    expect(useLayoutStore.getState().projectPath).toBe("C:\\new\\proj");
  });
});
