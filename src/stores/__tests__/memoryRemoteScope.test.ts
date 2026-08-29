// Remote (SSH) memory: capture under a remote scope, retrieval under the
// matching scope, non-retrieval under any other scope, and the reversible
// adoption of memory recorded before remote scoping existed.
//
// The defect these guard: `computeContextItems` READ the `ssh:` scope keys, but
// nothing in production ever WROTE one — every writer stamped a plain path — so
// a correctly-scoped remote workspace showed nothing, permanently.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnedPattern, MemoryEvent } from "@/types/memory";
import type { MemoryBriefScope } from "@/stores/memoryStore";

const mocks = vi.hoisted(() => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  togglePinnedPattern: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: (...args: unknown[]) => mocks.saveMemorySlice(...args),
  summarizeSession: (...args: unknown[]) => mocks.summarizeSession(...args),
  extractPatterns: (...args: unknown[]) => mocks.extractPatterns(...args),
  readPtyTranscript: (...args: unknown[]) => mocks.readPtyTranscript(...args),
  togglePinnedPattern: (...args: unknown[]) => mocks.togglePinnedPattern(...args),
}));

async function loadStore() {
  vi.resetModules();
  return import("../memoryStore");
}

const REMOTE: MemoryBriefScope = {
  kind: "ssh",
  projectPath: "/srv/app",
  serverId: "srv-1",
  remotePath: "/srv/app",
  workspaceId: "ws-remote",
};

const OTHER_SERVER: MemoryBriefScope = { ...REMOTE, serverId: "srv-2", workspaceId: "ws-other" };
const OTHER_PATH: MemoryBriefScope = {
  ...REMOTE,
  projectPath: "/srv/other",
  remotePath: "/srv/other",
};
const LOCAL: MemoryBriefScope = {
  kind: "local",
  projectPath: "D:/projects/app",
  workspaceId: "ws-local",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("memoryWriteKey (the write choke point)", () => {
  it("keys a remote scope by server + path and leaves a local scope as its path", async () => {
    const { memoryWriteKey, remoteMemoryProjectKey } = await loadStore();
    expect(memoryWriteKey(REMOTE)).toBe(remoteMemoryProjectKey("srv-1", "/srv/app"));
    expect(memoryWriteKey(LOCAL)).toBe("D:/projects/app");
    expect(memoryWriteKey("D:/projects/app")).toBe("D:/projects/app");
  });

  it("never stamps a workspace key for a local scope", async () => {
    // `workspaceMemoryProjectKey` is matched on read but must not be written:
    // doing so would sever every local record from its path and break both
    // parent matching and every path-shaped display.
    const { memoryWriteKey } = await loadStore();
    expect(memoryWriteKey(LOCAL)).not.toContain("workspace:");
  });

  it("prefers remotePath over the mirrored projectPath", async () => {
    const { memoryWriteKey, remoteMemoryProjectKey } = await loadStore();
    expect(
      memoryWriteKey({ ...REMOTE, projectPath: "D:/stale/local", remotePath: "/srv/app" }),
    ).toBe(remoteMemoryProjectKey("srv-1", "/srv/app"));
  });
});

describe("capture under a remote scope", () => {
  it("stamps a manual note with the remote scope key", async () => {
    const { useMemoryStore, remoteMemoryProjectKey } = await loadStore();
    const event = useMemoryStore.getState().captureManually({
      scope: REMOTE,
      source: "manual",
      summary: "Restart the unit after deploying",
      body: "systemctl restart app",
    });
    expect(event.projectPath).toBe(remoteMemoryProjectKey("srv-1", "/srv/app"));
  });

  it("stamps a session and a flight retrospective with the same key", async () => {
    const { useMemoryStore, remoteMemoryProjectKey } = await loadStore();
    const key = remoteMemoryProjectKey("srv-1", "/srv/app");

    useMemoryStore.getState().captureFlightCompleted(
      {
        flightId: "fl-1",
        flightTitle: "Deploy",
        summary: "shipped",
        whatWorked: [],
        whatFailed: [],
        lessonsLearned: ["Drain the queue before restarting"],
        suggestedImprovements: [],
        tags: [],
      },
      REMOTE,
    );
    await useMemoryStore.getState().learnFromSession("s-1", "claude", REMOTE, 30_000);

    expect(useMemoryStore.getState().events.map((e) => e.projectPath)).toEqual([key, key]);
  });

  it("hands the aux-LLM command the scope label, not a stale local path", async () => {
    const { useMemoryStore, remoteMemoryProjectKey } = await loadStore();
    mocks.readPtyTranscript.mockResolvedValue({ data: "some transcript output" });
    mocks.summarizeSession.mockResolvedValue(
      JSON.stringify({ summary: "did a thing", keyDecisions: [], filesModified: [] }),
    );

    await useMemoryStore.getState().learnFromSession("s-1", "claude", REMOTE, 30_000);

    expect(mocks.summarizeSession).toHaveBeenCalledWith(
      remoteMemoryProjectKey("srv-1", "/srv/app"),
      "some transcript output",
    );
  });
});

describe("retrieval isolation", () => {
  async function seed() {
    const store = await loadStore();
    const { useMemoryStore, remoteMemoryProjectKey } = store;
    useMemoryStore.getState().captureManually({
      scope: REMOTE,
      source: "manual",
      summary: "remote-only-secret",
      body: "remote-only-secret",
    });
    useMemoryStore.getState().captureManually({
      scope: LOCAL,
      source: "manual",
      summary: "local-only-secret",
      body: "local-only-secret",
    });
    useMemoryStore.setState({
      patterns: [
        {
          id: "pat-remote",
          pattern: "remote-pattern-text",
          category: "convention",
          confidence: 0.95,
          extractedAt: Date.now(),
          projectPath: remoteMemoryProjectKey("srv-1", "/srv/app"),
        },
        {
          id: "pat-local",
          pattern: "local-pattern-text",
          category: "convention",
          confidence: 0.95,
          extractedAt: Date.now(),
          projectPath: "D:/projects/app",
        },
      ] as LearnedPattern[],
    });
    return store;
  }

  it("retrieves what was captured, under the matching remote scope", async () => {
    const { useMemoryStore } = await seed();
    const brief = useMemoryStore.getState().composeMemoryBrief(REMOTE);
    expect(brief.text).toContain("remote-pattern-text");
    // Manual notes are not a brief source; the pattern proves the key matched.
    expect(brief.items.map((i) => i.id)).toContain("pat-remote");
  });

  it("does not retrieve it on a different server at the same path", async () => {
    const { useMemoryStore } = await seed();
    const brief = useMemoryStore.getState().composeMemoryBrief(OTHER_SERVER);
    expect(brief.text).not.toContain("remote-pattern-text");
  });

  it("does not retrieve it at a different path on the same server", async () => {
    const { useMemoryStore } = await seed();
    const brief = useMemoryStore.getState().composeMemoryBrief(OTHER_PATH);
    expect(brief.text).not.toContain("remote-pattern-text");
  });

  it("keeps remote memory out of a local project's brief, and vice versa", async () => {
    const { useMemoryStore } = await seed();
    const localBrief = useMemoryStore.getState().composeMemoryBrief(LOCAL);
    expect(localBrief.text).toContain("local-pattern-text");
    expect(localBrief.text).not.toContain("remote-pattern-text");

    const remoteBrief = useMemoryStore.getState().composeMemoryBrief(REMOTE);
    expect(remoteBrief.text).not.toContain("local-pattern-text");
  });

  it("keeps remote memory out of a local brief even under 'global' path matching", async () => {
    // `global` is the loosest local matching mode there is. It must still not
    // reach across into an ssh scope.
    const { useMemoryStore } = await seed();
    const { useMemorySettingsStore } = await import("../memorySettingsStore");
    useMemorySettingsStore.getState().setProjectPathMatching("global");
    const localBrief = useMemoryStore.getState().composeMemoryBrief(LOCAL);
    expect(localBrief.text).toContain("local-pattern-text");
    expect(localBrief.text).not.toContain("remote-pattern-text");
  });

  it("keeps another workspace's remote memory out of Ask, even with 'All projects' on", async () => {
    // Ask's "All projects" toggle forces `global` matching. It widens across
    // LOCAL projects; it must not reach into a remote workspace's memory.
    const { useMemoryStore } = await seed();
    const { askMemory } = await import("@/lib/memorySearch");
    const { events, patterns } = useMemoryStore.getState();
    const found = askMemory("secret pattern text", events, patterns, [], LOCAL, {
      includeAllProjects: true,
    });
    const text = found.results.map((r) => r.text).join("\n");
    expect(text).toContain("local-pattern-text");
    expect(text).not.toContain("remote-pattern-text");
  });
});

describe("pattern extraction under a remote scope", () => {
  it("mines the remote corpus and stamps the new patterns with the remote key", async () => {
    const { useMemoryStore, remoteMemoryProjectKey } = await loadStore();
    const key = remoteMemoryProjectKey("srv-1", "/srv/app");
    useMemoryStore.getState().captureManually({
      scope: REMOTE,
      source: "manual",
      summary: "Drain the queue first",
      body: "Drain the queue first",
    });
    mocks.extractPatterns.mockResolvedValue(
      JSON.stringify([{ pattern: "Drain before restart", category: "convention", confidence: 0.9 }]),
    );

    await useMemoryStore.getState().refreshPatterns(REMOTE);

    expect(mocks.extractPatterns).toHaveBeenCalledWith(key, expect.stringContaining("Drain"));
    expect(useMemoryStore.getState().patterns.map((p) => p.projectPath)).toEqual([key]);
  });
});

describe("export / import round-trip", () => {
  it("preserves remote scope keys through JSON export and import", async () => {
    const { useMemoryStore, serializeMemoryExport, remoteMemoryProjectKey } = await loadStore();
    const key = remoteMemoryProjectKey("srv-1", "/srv/app");
    useMemoryStore.getState().captureManually({
      scope: REMOTE,
      source: "manual",
      summary: "remote-only-secret",
      body: "remote-only-secret",
    });
    const json = serializeMemoryExport(
      useMemoryStore.getState().events,
      useMemoryStore.getState().patterns,
    );

    // Import into a fresh store, exactly as a second machine would.
    const fresh = await loadStore();
    const result = fresh.useMemoryStore.getState().importMemory(json);
    expect(result?.addedEvents).toBe(1);
    expect(fresh.useMemoryStore.getState().events[0].projectPath).toBe(key);

    // And it is still retrievable under the same remote scope after the trip.
    fresh.useMemoryStore.setState({
      patterns: [
        {
          id: "pat-imported",
          pattern: "imported-remote-pattern",
          category: "convention",
          confidence: 0.9,
          extractedAt: Date.now(),
          projectPath: key,
        },
      ] as LearnedPattern[],
    });
    expect(fresh.useMemoryStore.getState().composeMemoryBrief(REMOTE).text).toContain(
      "imported-remote-pattern",
    );
  });

  it("labels remote scopes in the Markdown digest instead of printing raw keys", async () => {
    const { serializeMemoryMarkdown, remoteMemoryProjectKey } = await loadStore();
    const { memoryProjectLabel } = await import("@/lib/memoryProjectLabel");
    const key = remoteMemoryProjectKey("srv-1", "/srv/app");
    const events = [
      { id: "e1", type: "manual_note", timestamp: 1, projectPath: key, payload: {} },
    ] as unknown as MemoryEvent[];

    const md = serializeMemoryMarkdown(events, [], {
      labelScope: (k) => memoryProjectLabel(k, { serverName: () => "build-box" }).title,
    });

    expect(md).toContain("build-box");
    expect(md).not.toContain("ssh:srv-1");
  });
});

describe("legacy remote memory — opt-in, reversible adoption", () => {
  async function seedLegacy() {
    const store = await loadStore();
    store.useMemoryStore.setState({
      events: [
        {
          id: "plain",
          type: "manual_note",
          timestamp: 1,
          projectPath: "/srv/app",
          payload: { source: "manual", summary: "written-before-scoping", body: "b", tags: [] },
        },
        {
          id: "elsewhere",
          type: "manual_note",
          timestamp: 2,
          projectPath: "/srv/other",
          payload: { source: "manual", summary: "different-path", body: "b", tags: [] },
        },
        {
          id: "already-scoped",
          type: "manual_note",
          timestamp: 3,
          projectPath: store.remoteMemoryProjectKey("srv-1", "/srv/app"),
          payload: { source: "manual", summary: "already", body: "b", tags: [] },
        },
      ] as unknown as MemoryEvent[],
      patterns: [
        {
          id: "pat-plain",
          pattern: "legacy-remote-pattern",
          category: "convention",
          confidence: 0.9,
          extractedAt: 1,
          projectPath: "/srv/app",
        },
      ] as LearnedPattern[],
    });
    return store;
  }

  it("finds only the plain-path records at this scope's path", async () => {
    const { findLegacyRemoteMemory, useMemoryStore } = await seedLegacy();
    const { events, patterns } = useMemoryStore.getState();
    const found = findLegacyRemoteMemory(events, patterns, REMOTE);
    expect(found.eventIds).toEqual(["plain"]);
    expect(found.patternIds).toEqual(["pat-plain"]);
  });

  it("finds nothing for a local scope — adoption is a remote-only affordance", async () => {
    const { findLegacyRemoteMemory, useMemoryStore } = await seedLegacy();
    const { events, patterns } = useMemoryStore.getState();
    expect(findLegacyRemoteMemory(events, patterns, LOCAL)).toEqual({
      eventIds: [],
      patternIds: [],
    });
  });

  it("does not rewrite anything until the user asks", async () => {
    // Nothing on the read path may migrate data as a side effect.
    const { useMemoryStore } = await seedLegacy();
    useMemoryStore.getState().composeMemoryBrief(REMOTE);
    expect(useMemoryStore.getState().events.find((e) => e.id === "plain")?.projectPath).toBe(
      "/srv/app",
    );
  });

  it("adopts on request, making the records retrievable, and records the original path", async () => {
    const { useMemoryStore, remoteMemoryProjectKey } = await seedLegacy();
    const key = remoteMemoryProjectKey("srv-1", "/srv/app");

    expect(useMemoryStore.getState().composeMemoryBrief(REMOTE).text).not.toContain(
      "legacy-remote-pattern",
    );

    const moved = useMemoryStore.getState().adoptLegacyRemoteMemory(REMOTE);
    expect(moved).toBe(2);

    const adopted = useMemoryStore.getState().events.find((e) => e.id === "plain");
    expect(adopted?.projectPath).toBe(key);
    expect(adopted?.legacyProjectPath).toBe("/srv/app");
    expect(useMemoryStore.getState().composeMemoryBrief(REMOTE).text).toContain(
      "legacy-remote-pattern",
    );
    // An unrelated path is untouched.
    expect(useMemoryStore.getState().events.find((e) => e.id === "elsewhere")?.projectPath).toBe(
      "/srv/other",
    );
  });

  it("reverts cleanly, restoring the exact original path and dropping the marker", async () => {
    const { useMemoryStore } = await seedLegacy();
    useMemoryStore.getState().adoptLegacyRemoteMemory(REMOTE);
    const restored = useMemoryStore.getState().revertAdoptedRemoteMemory(REMOTE);
    expect(restored).toBe(2);

    const back = useMemoryStore.getState().events.find((e) => e.id === "plain");
    expect(back?.projectPath).toBe("/srv/app");
    expect(back?.legacyProjectPath).toBeUndefined();
    expect(useMemoryStore.getState().patterns[0].projectPath).toBe("/srv/app");
    expect(useMemoryStore.getState().composeMemoryBrief(REMOTE).text).not.toContain(
      "legacy-remote-pattern",
    );
  });

  it("never adopts records that were already correctly scoped", async () => {
    const { useMemoryStore } = await seedLegacy();
    useMemoryStore.getState().adoptLegacyRemoteMemory(REMOTE);
    expect(
      useMemoryStore.getState().events.find((e) => e.id === "already-scoped")?.legacyProjectPath,
    ).toBeUndefined();
    // So a revert leaves them where they are.
    useMemoryStore.getState().revertAdoptedRemoteMemory(REMOTE);
    expect(
      useMemoryStore.getState().events.find((e) => e.id === "already-scoped")?.projectPath,
    ).toBe("ssh:srv-1:/srv/app");
  });
});
