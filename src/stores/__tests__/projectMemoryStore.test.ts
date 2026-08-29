import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      watchError: null,
      changedExternally: false,
      ownWriteUntil: 0,
      loadSequence: 0,
      reloadQueued: false,
      inFlight: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

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
      new Error("revision conflict: note changed outside PacketBench"),
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

  // FAULT: `load` only checked that the project path still matched, so two
  // overlapping listings of the SAME project could land out of order and the
  // older one would overwrite the newer snapshot - the pane rolling back to
  // pre-edit content. A watcher storm makes overlapping listings routine.
  it("discards a superseded listing of the same project", async () => {
    const slow = deferred<ProjectMemorySnapshot>();
    tauri.listProjectMemory
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(snapshot("newest"));

    const first = useProjectMemoryStore.getState().load("D:\\repo");
    const second = useProjectMemoryStore.getState().load("D:\\repo");
    await second;
    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("newest");

    slow.resolve(snapshot("stale"));
    await first;

    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("newest");
  });

  // FAULT: every watcher event started its own full directory listing. One
  // editor save emits several events and a bulk checkout emits hundreds, so a
  // 2,000-note directory was re-read once per event. Events arriving during an
  // in-flight listing now fold into a single trailing re-read.
  it("coalesces a watcher storm into one trailing re-read", async () => {
    const slow = deferred<ProjectMemorySnapshot>();
    tauri.listProjectMemory
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValue(snapshot("settled"));

    const initial = useProjectMemoryStore.getState().load("D:\\repo");
    for (let index = 0; index < 12; index += 1) {
      await useProjectMemoryStore.getState().load("D:\\repo", true);
    }
    expect(tauri.listProjectMemory).toHaveBeenCalledTimes(1);

    slow.resolve(snapshot("first"));
    await initial;

    // One listing for the initial load, one trailing listing for the burst.
    expect(tauri.listProjectMemory).toHaveBeenCalledTimes(2);
    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("settled");
    expect(useProjectMemoryStore.getState().reloadQueued).toBe(false);
    expect(useProjectMemoryStore.getState().inFlight).toBe(false);
  });

  // FAULT: `loading` was set on every reload, so a background refresh blanked
  // the note list. An editor autosaving while the user reads made the pane
  // flicker between the notes and the spinner.
  it("keeps the loaded notes visible during a background refresh", async () => {
    await useProjectMemoryStore.getState().load("D:\\repo");
    const slow = deferred<ProjectMemorySnapshot>();
    tauri.listProjectMemory.mockImplementationOnce(() => slow.promise);

    const refresh = useProjectMemoryStore.getState().load("D:\\repo", true);
    expect(useProjectMemoryStore.getState().loading).toBe(false);
    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("r1");
    expect(useProjectMemoryStore.getState().inFlight).toBe(true);

    slow.resolve(snapshot("r2"));
    await refresh;
    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("r2");
  });

  // FAULT: `load` cleared `error` unconditionally, so a watcher event fired by
  // an unrelated file wiped the save-conflict banner the user still had to act
  // on. Only a user- or write-initiated load clears it now.
  it("does not let an external refresh swallow a conflict the user must act on", async () => {
    await useProjectMemoryStore.getState().load("D:\\repo");
    tauri.updateProjectMemory.mockRejectedValue(
      new Error("Project-memory conflict: the note changed outside PacketBench."),
    );
    await useProjectMemoryStore.getState().updateNote({
      id: "note-1",
      expectedRevision: "old",
      title: "Title",
      body: "Body",
    });
    expect(useProjectMemoryStore.getState().error).toMatch(/conflict/i);

    await useProjectMemoryStore.getState().load("D:\\repo", true);
    expect(useProjectMemoryStore.getState().error).toMatch(/conflict/i);

    await useProjectMemoryStore.getState().load("D:\\repo");
    expect(useProjectMemoryStore.getState().error).toBeNull();
  });

  // FAULT: the own-write window was armed only before the write. A write slower
  // than the window (large note, network share, antivirus scan) outlived it, so
  // the watcher echo of the user's own save was reported back to them as an
  // external edit.
  it("re-arms the own-write window after a slow write actually lands", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    tauri.createProjectMemory.mockImplementation(async () => {
      clock += 10_000;
      return { metadata: { id: "n1" } };
    });

    await useProjectMemoryStore.getState().load("D:\\repo");
    await useProjectMemoryStore.getState().createNote({
      title: "Slow",
      body: "Body",
    });

    expect(useProjectMemoryStore.getState().ownWriteUntil).toBeGreaterThan(clock);

    // ...and the echo that arrives afterwards is still recognised as our own.
    await useProjectMemoryStore.getState().load("D:\\repo", true);
    expect(useProjectMemoryStore.getState().changedExternally).toBe(false);
  });

  // FAULT: a watch failure was applied whenever the project path still matched,
  // so a rejection from a superseded load raised a watch error over a watcher
  // that had since been re-armed successfully.
  it("ignores a watch failure belonging to a superseded load", async () => {
    const staleWatch = deferred<void>();
    tauri.watchProjectMemory
      .mockImplementationOnce(() => staleWatch.promise)
      .mockResolvedValue(undefined);

    await useProjectMemoryStore.getState().load("D:\\repo");
    await useProjectMemoryStore.getState().load("D:\\repo");

    staleWatch.reject(new Error("inotify limit reached"));
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectMemoryStore.getState().watchError).toBeNull();
  });

  // A watch failure from the CURRENT load still degrades to manual refresh
  // without hiding the notes that listed successfully.
  it("surfaces a current watch failure while keeping the notes", async () => {
    tauri.watchProjectMemory.mockRejectedValue(new Error("watch unavailable"));

    await useProjectMemoryStore.getState().load("D:\\repo");
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectMemoryStore.getState().watchError).toMatch(/unavailable/);
    expect(useProjectMemoryStore.getState().snapshot.revision).toBe("r1");
  });
});
