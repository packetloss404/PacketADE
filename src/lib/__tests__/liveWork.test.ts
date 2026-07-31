/**
 * UX-09: what a window close would actually destroy. The counts drive the
 * confirmation, and an empty summary is what lets the app close silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listPtySessions = vi.fn();
let workspaces: { panes: { sessionId: string | null }[] }[] = [];
let conversations: { status: string }[] = [];
let flights: { attempts?: { status: string }[] }[] = [];

vi.mock("@/lib/tauri", () => ({
  listPtySessions: (...args: unknown[]) => listPtySessions(...args),
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ workspaces }) },
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: { getState: () => ({ conversations }) },
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: { getState: () => ({ flights }) },
}));

import { collectLiveWork, describeLiveWork } from "@/lib/liveWork";

function pty(id: string, alive: boolean) {
  return { id, project_path: "/p", pid: 1, alive };
}

describe("collectLiveWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaces = [];
    conversations = [];
    flights = [];
    listPtySessions.mockResolvedValue([]);
  });

  it("reports zero when nothing is running", async () => {
    conversations = [{ status: "idle" }, { status: "done" }, { status: "failed" }];
    flights = [{ attempts: [{ status: "completed" }, { status: "reviewing" }] }];
    await expect(collectLiveWork()).resolves.toEqual({
      ptySessions: 0,
      conversations: 0,
      attempts: 0,
      total: 0,
    });
  });

  it("counts only alive PTY children", async () => {
    listPtySessions.mockResolvedValue([pty("a", true), pty("b", false), pty("c", true)]);
    const summary = await collectLiveWork();
    expect(summary.ptySessions).toBe(2);
    expect(summary.total).toBe(2);
  });

  it("counts mid-turn conversations and pre-terminal attempts", async () => {
    conversations = [{ status: "active" }, { status: "idle" }, { status: "active" }];
    flights = [
      { attempts: [{ status: "running" }, { status: "queued" }, { status: "completed" }] },
      { attempts: [{ status: "provisioning" }] },
      {},
    ];
    const summary = await collectLiveWork();
    expect(summary).toEqual({ ptySessions: 0, conversations: 2, attempts: 3, total: 5 });
  });

  it("falls back to pane session ids when the PTY listing fails", async () => {
    listPtySessions.mockRejectedValue(new Error("no backend"));
    workspaces = [
      { panes: [{ sessionId: "s1" }, { sessionId: null }] },
      { panes: [{ sessionId: "s2" }] },
    ];
    const summary = await collectLiveWork();
    expect(summary.ptySessions).toBe(2);
  });
});

describe("describeLiveWork", () => {
  it("names each non-empty kind with correct pluralization", () => {
    expect(
      describeLiveWork({ ptySessions: 1, conversations: 2, attempts: 0, total: 3 }),
    ).toEqual([
      "1 terminal session will be killed",
      "2 agent conversations mid-turn will be cut off",
    ]);
  });

  it("returns nothing for an empty summary", () => {
    expect(describeLiveWork({ ptySessions: 0, conversations: 0, attempts: 0, total: 0 })).toEqual(
      [],
    );
  });

  it("describes running attempts", () => {
    expect(describeLiveWork({ ptySessions: 0, conversations: 0, attempts: 1, total: 1 })).toEqual([
      "1 flight attempt still running will be abandoned",
    ]);
  });
});
