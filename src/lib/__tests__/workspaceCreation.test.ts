/**
 * The unified workspace-creation front door.
 *
 * Covers the two HIGH findings from the creation-flows review:
 *   - the instant paths (Ctrl+N, the Fleet sidebar CTA) used to pass
 *     `layoutStore.projectPath ?? ""` straight into `createWorkspace`, creating
 *     exactly the path-less workspace the creation modal blocks;
 *   - they hard-coded the name "New Session", so repeated presses produced
 *     indistinguishable rows under a noun the rest of the app doesn't use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const openDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined) };
});

import {
  createInstantWorkspace,
  nextWorkspaceName,
  openWorkspaceCreationModal,
  WORKSPACE_NAME_BASE,
} from "@/lib/workspaceCreation";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

function reset(projectPath: string) {
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    creationRequest: null,
  });
  useLayoutStore.setState({ projectPath, fallbackProjectPath: projectPath });
  useAppStore.setState({ activeView: "agents" });
}

describe("nextWorkspaceName", () => {
  it("uses the bare base name when it is free", () => {
    expect(nextWorkspaceName([])).toBe(WORKSPACE_NAME_BASE);
  });

  it("suffixes a counter instead of repeating a name", () => {
    expect(nextWorkspaceName(["Workspace"])).toBe("Workspace 2");
    expect(nextWorkspaceName(["Workspace", "Workspace 2"])).toBe("Workspace 3");
  });

  it("fills the first gap and ignores unrelated names", () => {
    expect(nextWorkspaceName(["Workspace", "Workspace 3", "PacketADE"])).toBe("Workspace 2");
  });
});

describe("createInstantWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset("C:\\projects\\demo");
  });

  it("creates a uniquely auto-named workspace on the known project path", async () => {
    await createInstantWorkspace();
    await createInstantWorkspace();

    const names = useWorkspaceStore.getState().workspaces.map((w) => w.name);
    expect(names).toEqual(["Workspace", "Workspace 2"]);
    expect(new Set(names).size).toBe(names.length);
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("never creates a path-less workspace — it asks for a folder first", async () => {
    reset("");
    openDialog.mockResolvedValue("D:\\picked\\repo");

    const id = await createInstantWorkspace();

    expect(openDialog).toHaveBeenCalledTimes(1);
    const created = useWorkspaceStore.getState().workspaces;
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(id);
    expect(created[0].projectPath).toBe("D:\\picked\\repo");
  });

  it("creates nothing when the folder picker is cancelled", async () => {
    reset("");
    openDialog.mockResolvedValue(null);

    const id = await createInstantWorkspace();

    expect(id).toBeNull();
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("lands the user on the Workspace surface", async () => {
    await createInstantWorkspace();
    expect(useAppStore.getState().activeView).toBe("workspace");
  });
});

describe("openWorkspaceCreationModal", () => {
  beforeEach(() => reset("C:\\projects\\demo"));

  it("publishes a creation request and activates the Workspace surface", () => {
    openWorkspaceCreationModal();

    expect(useAppStore.getState().activeView).toBe("workspace");
    expect(useWorkspaceStore.getState().creationRequest).not.toBeNull();
  });

  it("issues a distinct token per request so a second ask is not swallowed", () => {
    openWorkspaceCreationModal();
    const first = useWorkspaceStore.getState().creationRequest;
    openWorkspaceCreationModal();

    expect(useWorkspaceStore.getState().creationRequest).not.toBe(first);
  });
});
