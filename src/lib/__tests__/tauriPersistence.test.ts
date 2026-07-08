import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PersistedStateDto } from "@/generated/tauri-schema";
import type { Flight } from "@/types/flight";
import type { Workspace } from "@/types/workspace";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

import {
  loadPersistedState,
  saveFlightsSlice,
  saveUiSlice,
  saveWorkspacesSlice,
} from "@/lib/tauri";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Flight",
    objective: "Objective",
    status: "active",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 2,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makePersistedStateDto(overrides: Partial<PersistedStateDto> = {}): PersistedStateDto {
  return {
    version: 1,
    flights: [],
    agents: [],
    issues: [],
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: "/repo",
      autoCommitTrailerEnabled: true,
      autoCommitTrailerFormat: "Run-By: PacketADE flight F-{flightId} attempt A-{attemptId}",
    },
    ui: {},
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
    ...overrides,
  };
}

describe("Tauri persistence DTO mapping", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("round-trips flight workspace and planner fields to the backend DTO", async () => {
    await saveFlightsSlice([
      makeFlight({
        workspaceId: "workspace-1",
        plannerSessionId: "planner-session-1",
        plannerStatus: "quota_paused",
        plannerCost: 1.25,
        plannerTokens: 42,
        plannerProvider: "claude-oauth",
      }),
    ]);

    expect(mockInvoke).toHaveBeenCalledWith("save_flights_slice", {
      flights: [
        expect.objectContaining({
          workspaceId: "workspace-1",
          plannerSessionId: "planner-session-1",
          plannerStatus: "quota_paused",
          plannerCost: 1.25,
          plannerTokens: 42,
          plannerProvider: "claude-oauth",
        }),
      ],
    });
  });

  it("hydrates flight planner fields and server host fingerprints from DTOs", async () => {
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        flights: [
          {
            ...makeFlight({
              workspaceId: "workspace-1",
              plannerSessionId: "planner-session-1",
              plannerStatus: "awake",
              plannerCost: 2.5,
              plannerTokens: 123,
              plannerProvider: "api-claude",
            }),
            attempts: [],
            publishAttemptsAsPrs: false,
          } as unknown as PersistedStateDto["flights"][number],
        ],
        servers: [
          {
            id: "server-1",
            name: "Server",
            host: "example.com",
            port: 22,
            username: "ian",
            authMethod: "key",
            keyPath: null,
            remotePath: null,
            lastConnectedAt: BigInt(5),
            installedAgents: [],
            hostFingerprint: "SHA256:test",
          },
        ],
      }),
    );

    const state = await loadPersistedState();

    expect(state.flights[0]).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        plannerSessionId: "planner-session-1",
        plannerStatus: "awake",
        plannerCost: 2.5,
        plannerTokens: 123,
        plannerProvider: "api-claude",
      }),
    );
    expect(state.servers[0].hostFingerprint).toBe("SHA256:test");
  });

  it("passes through workspace pane pinnedCommands and githubRepo when present", async () => {
    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      agents: ["codex"],
      panes: [
        {
          id: "pane-1",
          agentId: "codex",
          sessionId: "session-1",
          gridPosition: { row: 0, col: 0 },
          pinnedCommands: ["pnpm test"],
        },
      ],
      projectPath: "/repo",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
      githubRepo: { owner: "openai", repo: "packetade" },
    };

    await saveWorkspacesSlice([workspace]);

    expect(mockInvoke).toHaveBeenCalledWith("save_workspaces_slice", {
      workspaces: [
        expect.objectContaining({
          githubRepo: { owner: "openai", repo: "packetade" },
          panes: [
            expect.objectContaining({
              pinnedCommands: ["pnpm test"],
            }),
          ],
        }),
      ],
    });

    // Legacy/backend-owned pane metadata (taskId, flightId, agentConfigId,
    // initialPrompt, overrideCommand, overrideArgs) from the retired
    // tick-loop scheduler may still be echoed back by an unmigrated
    // backend this wave — hydration must silently ignore it rather than
    // crash or resurrect it onto the frontend Workspace type.
    mockInvoke.mockResolvedValue(
      makePersistedStateDto({
        workspaces: [
          {
            id: "workspace-1",
            name: "Workspace",
            agents: ["codex"],
            panes: [
              {
                id: "pane-1",
                agentId: "codex",
                sessionId: "session-1",
                gridPosition: { row: 0, col: 0 },
                pinnedCommands: ["pnpm test"],
                taskId: "task-1",
                flightId: "flight-1",
                agentConfigId: "codex",
                initialPrompt: "Start here",
                overrideCommand: "codex",
                overrideArgs: ["--ask-for-approval", "never"],
              },
            ],
            projectPath: "/repo",
            createdAt: 1,
            updatedAt: 2,
            status: "active",
            githubRepo: { owner: "openai", repo: "packetade" },
          } as unknown as PersistedStateDto["workspaces"][number],
        ],
      }),
    );

    const state = await loadPersistedState();
    expect(state.workspaces[0].githubRepo).toEqual({ owner: "openai", repo: "packetade" });
    expect(state.workspaces[0].panes[0]).toEqual(
      expect.objectContaining({
        pinnedCommands: ["pnpm test"],
      }),
    );
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("taskId");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("flightId");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("initialPrompt");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("overrideCommand");
    expect(state.workspaces[0].panes[0]).not.toHaveProperty("overrideArgs");
  });

  it("omits undefined ui fields for partial ui slice saves", async () => {
    await saveUiSlice({ selectedView: "flights", theme: "dark" });

    expect(mockInvoke).toHaveBeenCalledWith("save_ui_slice", {
      ui: {
        selectedView: "flights",
        theme: "dark",
      },
    });
  });

  it("encodes explicit null ui fields so partial saves can clear them", async () => {
    await saveUiSlice({ selectedFlightId: null });

    expect(mockInvoke).toHaveBeenCalledWith("save_ui_slice", {
      ui: {
        selectedFlightId: "",
      },
    });
  });

  it("omits null theme values because the backend theme dto is an enum", async () => {
    await saveUiSlice({ selectedView: "flights", theme: null });

    expect(mockInvoke).toHaveBeenCalledWith("save_ui_slice", {
      ui: {
        selectedView: "flights",
      },
    });
  });
});
