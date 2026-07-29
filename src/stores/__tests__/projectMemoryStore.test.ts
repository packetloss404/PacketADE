import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";
import type { ProjectMemorySnapshot } from "@/types/project-memory";

const tauri = vi.hoisted(() => ({
  archiveProjectMemory: vi.fn(),
  createProjectMemory: vi.fn(),
  listProjectMemory: vi.fn(),
  updateProjectMemory: vi.fn(),
  watchProjectMemory: vi.fn(),
}));

vi.mock("@/lib/tauri", () => tauri);

function snapshot(revision: string): ProjectMemorySnapshot {
  return {
    schemaVersion: 1,
    directory: ".agents/memory",
    notes: [],
    warnings: [],
    revision,
  };
}

describe("projectMemoryStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.watchProjectMemory.mockResolvedValue(undefined);
    tauri.listProjectMemory.mockResolvedValue(snapshot("r1"));
    useProjectMemoryStore.setState({
      projectPath: null,
      snapshot: snapshot(""),
      loading: false,
      error: null,
      changedExternally: false,
      ownWriteUntil: 0,
    });
  });

  it("suppresses its own coalesced watcher event but surfaces later external edits", async () => {
    useProjectMemoryStore.setState({ ownWriteUntil: Date.now() + 5_000 });
    await useProjectMemoryStore.getState().load("D:\\repo", true);
    expect(useProjectMemoryStore.getState().changedExternally).toBe(false);

    useProjectMemoryStore.setState({ ownWriteUntil: 0 });
    await useProjectMemoryStore.getState().load("D:\\repo", true);
    expect(useProjectMemoryStore.getState().changedExternally).toBe(true);
  });

  it("keeps optimistic revision conflicts visible instead of overwriting", async () => {
    await useProjectMemoryStore.getState().load("D:\\repo");
    tauri.updateProjectMemory.mockRejectedValue(
      new Error("revision conflict: note changed outside PacketADE"),
    );

    const result = await useProjectMemoryStore.getState().updateNote({
      id: "note-1",
      expectedRevision: "old",
      title: "Title",
      body: "Body",
    });

    expect(result).toBeNull();
    expect(useProjectMemoryStore.getState().error).toMatch(/revision conflict/i);
    expect(tauri.listProjectMemory).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale load after the active project changes", async () => {
    let resolveFirst: ((value: ProjectMemorySnapshot) => void) | undefined;
    tauri.listProjectMemory
      .mockImplementationOnce(
        () =>
          new Promise<ProjectMemorySnapshot>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot("repo-b"));

    const first = useProjectMemoryStore.getState().load("D:\\repo-a");
    const second = useProjectMemoryStore.getState().load("D:\\repo-b");
    await second;
    resolveFirst?.(snapshot("repo-a"));
    await first;

    expect(useProjectMemoryStore.getState().projectPath).toBe("D:\\repo-b");
    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("repo-b");
  });
});
