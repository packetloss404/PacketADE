import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodebaseScanResult } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  scanCodebaseMemory: vi.fn(),
  togglePinnedPattern: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: (...args: unknown[]) => mocks.saveMemorySlice(...args),
  summarizeSession: (...args: unknown[]) => mocks.summarizeSession(...args),
  extractPatterns: (...args: unknown[]) => mocks.extractPatterns(...args),
  readPtyTranscript: (...args: unknown[]) => mocks.readPtyTranscript(...args),
  scanCodebaseMemory: (...args: unknown[]) => mocks.scanCodebaseMemory(...args),
  togglePinnedPattern: (...args: unknown[]) => mocks.togglePinnedPattern(...args),
}));

const PROJECT = "D:/projects/example";

function scanResult(overrides: Partial<CodebaseScanResult> = {}): CodebaseScanResult {
  return {
    response: JSON.stringify([
      { path: "src/main.ts", summary: "App entry point" },
      { path: "src-tauri/src/lib.rs", summary: "Tauri command registration" },
    ]),
    filesListed: 2,
    filesSeen: 2,
    excerptCount: 2,
    symlinksSkipped: 0,
    sensitiveSkipped: 0,
    truncated: false,
    timedOut: false,
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("../memoryStore");
}

describe("memoryStore.scanCodebase", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.saveMemorySlice.mockResolvedValue(undefined);
  });

  it("stores a successful scan as one codebase-scan note", async () => {
    const { useMemoryStore, CODEBASE_SCAN_SOURCE } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(scanResult());

    const wrote = await useMemoryStore.getState().scanCodebase(PROJECT);

    expect(wrote).toBe(true);
    expect(mocks.scanCodebaseMemory).toHaveBeenCalledWith(PROJECT);
    const events = useMemoryStore.getState().events;
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe("manual_note");
    if (event.type !== "manual_note") throw new Error("expected a manual_note");
    expect(event.projectPath).toBe(PROJECT);
    expect(event.payload.source).toBe(CODEBASE_SCAN_SOURCE);
    expect(event.payload.summary).toBe("Codebase index: 2 key files");
    expect(event.payload.body).toContain("src/main.ts — App entry point");
    expect(event.payload.body).toContain("src-tauri/src/lib.rs — Tauri command registration");
    expect(event.payload.tags).toEqual([CODEBASE_SCAN_SOURCE]);
    // A complete scan leaves no warning behind and stops the spinner.
    expect(useMemoryStore.getState().isLearning).toBe(false);
    expect(useMemoryStore.getState().learningStatus).toBeNull();
    expect(mocks.saveMemorySlice).toHaveBeenCalledTimes(1);
  });

  it("surfaces the no-provider error in the pane instead of swallowing it", async () => {
    const { useMemoryStore } = await loadStore();
    mocks.scanCodebaseMemory.mockRejectedValue(
      new Error(
        "No auxiliary LLM provider is configured. Add an API key in Settings > API Keys.",
      ),
    );

    const wrote = await useMemoryStore.getState().scanCodebase(PROJECT);

    expect(wrote).toBe(false);
    // Nothing recorded — a failed scan must not leave a half-note behind.
    expect(useMemoryStore.getState().events).toEqual([]);
    expect(mocks.saveMemorySlice).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().isLearning).toBe(false);
    expect(useMemoryStore.getState().learningStatus).toContain("Codebase scan failed");
    expect(useMemoryStore.getState().learningStatus).toContain("Settings > API Keys");
  });

  it("never presents a truncated walk as a complete index", async () => {
    const { useMemoryStore } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(
      scanResult({ filesListed: 400, filesSeen: 9000, truncated: true, symlinksSkipped: 3 }),
    );

    expect(await useMemoryStore.getState().scanCodebase(PROJECT)).toBe(true);

    const event = useMemoryStore.getState().events[0];
    if (event.type !== "manual_note") throw new Error("expected a manual_note");
    expect(event.payload.summary).toContain("(partial)");
    expect(event.payload.tags).toContain("partial");
    expect(event.payload.body).toContain("PARTIAL");
    expect(event.payload.body).toContain("400 of 9000");
    expect(event.payload.body).toContain("Skipped 3 symlink(s)");
    // The caveat stays on the header status chip rather than vanishing.
    expect(useMemoryStore.getState().learningStatus).toContain("partial view");
  });

  it("says the walk ran out of time when that is what happened", async () => {
    const { useMemoryStore } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(
      scanResult({ truncated: true, timedOut: true }),
    );

    expect(await useMemoryStore.getState().scanCodebase(PROJECT)).toBe(true);
    const event = useMemoryStore.getState().events[0];
    if (event.type !== "manual_note") throw new Error("expected a manual_note");
    expect(event.payload.body).toContain("ran out of time");
  });

  it("replaces the previous scan instead of accumulating near-duplicates", async () => {
    const { useMemoryStore, CODEBASE_SCAN_SOURCE, findCodebaseScanNote } = await loadStore();
    // An unrelated note that must survive the replace.
    useMemoryStore.getState().captureManually({
      scope: PROJECT,
      source: "manual",
      summary: "keep me",
      body: "hand-written",
    });

    mocks.scanCodebaseMemory.mockResolvedValue(scanResult());
    await useMemoryStore.getState().scanCodebase(PROJECT);
    const firstId = findCodebaseScanNote(useMemoryStore.getState().events, PROJECT)?.id;

    mocks.scanCodebaseMemory.mockResolvedValue(
      scanResult({
        response: JSON.stringify([{ path: "src/app.tsx", summary: "Root component" }]),
      }),
    );
    await useMemoryStore.getState().scanCodebase(PROJECT);

    const events = useMemoryStore.getState().events;
    const scans = events.filter(
      (e) => e.type === "manual_note" && e.payload.source === CODEBASE_SCAN_SOURCE,
    );
    expect(scans).toHaveLength(1);
    expect(scans[0].id).not.toBe(firstId);
    if (scans[0].type !== "manual_note") throw new Error("expected a manual_note");
    expect(scans[0].payload.body).toContain("src/app.tsx");
    expect(scans[0].payload.body).not.toContain("src/main.ts");
    // The user's own note is untouched.
    expect(events.filter((e) => e.type === "manual_note" && e.payload.source === "manual")).toHaveLength(1);
  });

  it("keeps a scan per project rather than replacing another project's", async () => {
    const { useMemoryStore, CODEBASE_SCAN_SOURCE } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(scanResult());

    await useMemoryStore.getState().scanCodebase(PROJECT);
    await useMemoryStore.getState().scanCodebase("D:/projects/other");

    const scans = useMemoryStore
      .getState()
      .events.filter((e) => e.type === "manual_note" && e.payload.source === CODEBASE_SCAN_SOURCE);
    expect(scans).toHaveLength(2);
    expect(scans.map((e) => e.projectPath).sort()).toEqual([
      "D:/projects/example",
      "D:/projects/other",
    ]);
  });

  it("writes nothing when the model returns no usable file list", async () => {
    const { useMemoryStore } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(
      scanResult({ response: "I could not identify any files." }),
    );

    expect(await useMemoryStore.getState().scanCodebase(PROJECT)).toBe(false);
    expect(useMemoryStore.getState().events).toEqual([]);
    expect(useMemoryStore.getState().learningStatus).toContain("no usable file list");
  });

  it("does not overwrite a good index with an empty one", async () => {
    const { useMemoryStore, findCodebaseScanNote } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(scanResult());
    await useMemoryStore.getState().scanCodebase(PROJECT);

    mocks.scanCodebaseMemory.mockResolvedValue(scanResult({ response: "[]" }));
    expect(await useMemoryStore.getState().scanCodebase(PROJECT)).toBe(false);

    const kept = findCodebaseScanNote(useMemoryStore.getState().events, PROJECT);
    expect(kept?.type).toBe("manual_note");
    if (kept?.type !== "manual_note") throw new Error("expected a manual_note");
    expect(kept.payload.body).toContain("src/main.ts");
  });

  it("refuses a remote scope without touching this machine's filesystem", async () => {
    const { useMemoryStore } = await loadStore();

    const wrote = await useMemoryStore.getState().scanCodebase({
      projectPath: "/srv/app",
      kind: "ssh",
      serverId: "server-1",
      remotePath: "/srv/app",
    });

    expect(wrote).toBe(false);
    expect(mocks.scanCodebaseMemory).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().learningStatus).toContain("local workspace");
  });

  it("refuses to start a second scan while one is running", async () => {
    const { useMemoryStore } = await loadStore();
    let release: (value: CodebaseScanResult) => void = () => {};
    mocks.scanCodebaseMemory.mockReturnValue(
      new Promise<CodebaseScanResult>((resolve) => {
        release = resolve;
      }),
    );

    const first = useMemoryStore.getState().scanCodebase(PROJECT);
    expect(useMemoryStore.getState().isLearning).toBe(true);
    expect(await useMemoryStore.getState().scanCodebase(PROJECT)).toBe(false);
    expect(mocks.scanCodebaseMemory).toHaveBeenCalledTimes(1);

    release(scanResult());
    expect(await first).toBe(true);
  });

  it("drops model entries that carry no path", async () => {
    const { useMemoryStore } = await loadStore();
    mocks.scanCodebaseMemory.mockResolvedValue(
      scanResult({
        response: JSON.stringify([
          { path: "src/main.ts", summary: "App entry point" },
          { summary: "no path at all" },
          { path: "   ", summary: "blank path" },
        ]),
      }),
    );

    expect(await useMemoryStore.getState().scanCodebase(PROJECT)).toBe(true);
    const event = useMemoryStore.getState().events[0];
    if (event.type !== "manual_note") throw new Error("expected a manual_note");
    expect(event.payload.summary).toBe("Codebase index: 1 key file");
    expect(event.payload.body).not.toContain("no path at all");
  });
});
