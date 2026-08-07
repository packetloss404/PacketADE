/**
 * File viewer tiles (`kind: "file"`).
 *
 * Proves the pane kind obeys the same invariants the conversation kind
 * established: `kind` is the sole discriminant, `agentId` stays the inert
 * carrier "terminal", the payload field is required, and a pane that lost its
 * payload self-heals to a terminal instead of mounting a broken tile.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore, normalizePanes } from "@/stores/workspaceStore";
import type { Workspace } from "@/types/workspace";

const PROJECT = "C:\\projects\\app";
const FILE = "C:\\projects\\app\\README.md";

function seedWorkspace(): string {
  const ws: Workspace = {
    id: "ws-1",
    name: "App",
    agents: [],
    panes: [],
    projectPath: PROJECT,
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  };
  useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: "ws-1" });
  return ws.id;
}

describe("workspaceStore.addFilePane", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      zoomedPaneId: null,
      focusPaneRequest: null,
    });
  });

  it("adds a file pane carrying the inert terminal agentId", () => {
    const wsId = seedWorkspace();
    const paneId = useWorkspaceStore.getState().addFilePane(wsId, FILE);

    expect(paneId).toBeTruthy();
    const pane = useWorkspaceStore.getState().workspaces[0].panes[0];
    expect(pane.kind).toBe("file");
    expect(pane.filePath).toBe(FILE);
    // A downgraded binary that ignores `kind` must render a harmless terminal.
    expect(pane.agentId).toBe("terminal");
    expect(pane.sessionId).toBeNull();
  });

  it("does NOT add the viewer to the workspace's CLI agent roster", () => {
    const wsId = seedWorkspace();
    useWorkspaceStore.getState().addFilePane(wsId, FILE);

    // `agents` drives the header CLI badges. A viewer launches no agent, so a
    // badge for it would claim a running session that does not exist.
    expect(useWorkspaceStore.getState().workspaces[0].agents).toEqual([]);
  });

  it("focuses the existing tile instead of stacking a duplicate for one path", () => {
    const wsId = seedWorkspace();
    const first = useWorkspaceStore.getState().addFilePane(wsId, FILE);
    const second = useWorkspaceStore.getState().addFilePane(wsId, FILE);

    expect(second).toBe(first);
    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(1);
    expect(useWorkspaceStore.getState().focusPaneRequest?.paneId).toBe(first);
  });

  it("applies an explicit initial view (the Markdown Viewer row) and omits it otherwise", () => {
    const wsId = seedWorkspace();
    useWorkspaceStore.getState().addFilePane(wsId, FILE, { view: "preview" });
    useWorkspaceStore.getState().addFilePane(wsId, `${PROJECT}\\notes.txt`);

    const [markdown, plain] = useWorkspaceStore.getState().workspaces[0].panes;
    expect(markdown.fileView).toBe("preview");
    expect(plain.fileView).toBeUndefined();
  });

  it("rejects a blank path and an unknown workspace", () => {
    const wsId = seedWorkspace();
    expect(useWorkspaceStore.getState().addFilePane(wsId, "   ")).toBeNull();
    expect(useWorkspaceStore.getState().addFilePane("ws-missing", FILE)).toBeNull();
    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(0);
  });

  it("removing a file pane leaves the CLI agent roster untouched", () => {
    const wsId = seedWorkspace();
    useWorkspaceStore.getState().addPane(wsId, "terminal");
    const filePaneId = useWorkspaceStore.getState().addFilePane(wsId, FILE);

    expect(useWorkspaceStore.getState().workspaces[0].agents).toEqual(["terminal"]);
    useWorkspaceStore.getState().removePane(wsId, filePaneId!);

    // The real terminal must NOT be spliced out because the viewer happens to
    // carry the same inert carrier id.
    expect(useWorkspaceStore.getState().workspaces[0].agents).toEqual(["terminal"]);
    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(1);
  });
});

describe("normalizePanes: file pane invariants", () => {
  it("round-trips a valid file pane", () => {
    const [ws] = normalizePanes([
      {
        id: "ws-1",
        name: "App",
        agents: [],
        projectPath: PROJECT,
        createdAt: 1,
        updatedAt: 1,
        status: "active",
        panes: [
          {
            id: "pane-file",
            agentId: "terminal",
            sessionId: null,
            kind: "file",
            filePath: FILE,
            fileView: "preview",
          },
        ],
      } as unknown as Workspace,
    ]);

    expect(ws.panes[0].kind).toBe("file");
    expect(ws.panes[0].filePath).toBe(FILE);
    expect(ws.panes[0].fileView).toBe("preview");
  });

  it("self-heals a file pane whose path was stripped by an old binary", () => {
    const [ws] = normalizePanes([
      {
        id: "ws-1",
        name: "App",
        agents: [],
        projectPath: PROJECT,
        createdAt: 1,
        updatedAt: 1,
        status: "active",
        panes: [{ id: "pane-file", agentId: "terminal", sessionId: null, kind: "file" }],
      } as unknown as Workspace,
    ]);

    expect(ws.panes[0].kind).toBe("terminal");
    expect(ws.panes[0].filePath).toBeUndefined();
  });

  it("drops a bogus fileView rather than handing it to the editor", () => {
    const [ws] = normalizePanes([
      {
        id: "ws-1",
        name: "App",
        agents: [],
        projectPath: PROJECT,
        createdAt: 1,
        updatedAt: 1,
        status: "active",
        panes: [
          {
            id: "pane-file",
            agentId: "terminal",
            sessionId: null,
            kind: "file",
            filePath: FILE,
            fileView: "hologram",
          },
        ],
      } as unknown as Workspace,
    ]);

    expect(ws.panes[0].kind).toBe("file");
    expect(ws.panes[0].fileView).toBeUndefined();
  });

  it("never leaves a stray filePath on a terminal pane", () => {
    const [ws] = normalizePanes([
      {
        id: "ws-1",
        name: "App",
        agents: [],
        projectPath: PROJECT,
        createdAt: 1,
        updatedAt: 1,
        status: "active",
        panes: [{ id: "pane-term", agentId: "claude-code", sessionId: null, filePath: FILE }],
      } as unknown as Workspace,
    ]);

    expect(ws.panes[0].kind).toBe("terminal");
    expect(ws.panes[0].filePath).toBeUndefined();
  });
});
