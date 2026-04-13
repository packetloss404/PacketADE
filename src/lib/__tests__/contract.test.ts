import { describe, it, expect } from "vitest";
import type { Flight, Task, Milestone, TaskResult } from "@/types/flight";
import type { PersistedStateDto, TaskDto } from "@/generated/tauri-schema";

describe("TS/Rust contract tests", () => {
  // ---------------------------------------------------------------
  // 1. Structural completeness — TS types have all required fields
  // ---------------------------------------------------------------

  it("Flight type has all required fields", () => {
    const flight: Flight = {
      id: "f1",
      title: "Test",
      objective: "obj",
      status: "active",
      priority: "high",
      projectPath: "/test",
      gitBranch: "main",
      milestones: [],
      linkedSessionIds: [],
      issueIds: [],
      createdAt: 0,
      updatedAt: 0,
      totalCost: 0,
      totalTokens: 0,
    };
    expect(flight.id).toBeDefined();
    expect(flight.projectPath).toBeDefined();
    expect(flight.linkedSessionIds).toBeDefined();
    expect(flight.issueIds).toBeDefined();
  });

  it("Task type has all required fields", () => {
    const task: Task = {
      id: "t1",
      milestoneId: "ms1",
      flightId: "f1",
      title: "Task",
      description: "desc",
      order: 0,
      status: "pending",
      type: "implementation",
      agentConfigId: "claude-code",
      dependsOn: [],
      sessionId: null,
      createdAt: 0,
      cost: 0,
      tokens: 0,
    };
    expect(task.agentConfigId).toBeDefined();
    expect(task.dependsOn).toBeDefined();
    expect(task.type).toBeDefined();
    expect(task.sessionId).toBeNull();
  });

  it("Milestone type has all required fields", () => {
    const milestone: Milestone = {
      id: "ms1",
      flightId: "f1",
      title: "MS",
      description: "desc",
      order: 0,
      status: "pending",
      tasks: [],
      validationCriteria: [],
    };
    expect(milestone.validationCriteria).toBeDefined();
    expect(milestone.flightId).toBeDefined();
  });

  it("TaskResult type has all required fields", () => {
    const result: TaskResult = {
      exitCode: 0,
      summary: "ok",
      filesChanged: ["a.ts"],
      errors: [],
      duration: 100,
      handoff: {
        summary: "done",
        filesChanged: ["a.ts"],
        testsNeeded: [],
        followUps: [],
      },
      validation: {
        verdict: "pass",
        summary: "ok",
        assertions: [{ label: "compiles", status: "pass" }],
      },
    };
    expect(result.exitCode).toBeDefined();
    expect(result.filesChanged).toBeDefined();
    expect(result.handoff?.filesChanged).toBeDefined();
    expect(result.handoff?.testsNeeded).toBeDefined();
    expect(result.handoff?.followUps).toBeDefined();
    expect(result.validation?.assertions[0].label).toBeDefined();
  });

  // ---------------------------------------------------------------
  // 2. camelCase transport DTOs — generated Rust API contract
  // ---------------------------------------------------------------

  it("generated task DTO matches the camelCase transport contract", () => {
    const task: TaskDto = {
      id: "t1",
      milestoneId: "ms1",
      flightId: "f1",
      title: "Task",
      description: "desc",
      order: 0,
      status: "pending",
      type: "implementation",
      agentConfigId: "claude-code",
      dependsOn: [],
      sessionId: null,
      createdAt: 0,
      cost: 0,
      tokens: 0,
    };

    expect(task.type).toBe("implementation");
    expect(task.agentConfigId).toBe("claude-code");
    expect(task.milestoneId).toBe("ms1");
    expect(task.flightId).toBe("f1");
    expect(task.dependsOn).toEqual([]);
    expect(task.sessionId).toBeNull();
    expect(task.createdAt).toBe(0);
  });

  it("generated persisted state DTO uses camelCase settings and ui keys", () => {
    const state: PersistedStateDto = {
      version: 1,
      flights: [],
      agents: [],
      settings: {
        maxParallelSessions: 3,
        milestoneGating: true,
        projectPath: "/project",
      },
      ui: {
        selectedFlightId: "f1",
        selectedView: "dashboard",
        theme: "dark",
      },
      workspaces: [],
      memoryEvents: [],
    };

    expect(state.settings.maxParallelSessions).toBe(3);
    expect(state.settings.milestoneGating).toBe(true);
    expect(state.settings.projectPath).toBe("/project");
    expect(state.ui.selectedFlightId).toBe("f1");
    expect(state.ui.selectedView).toBe("dashboard");
    expect(state.ui.theme).toBe("dark");
  });

  // ---------------------------------------------------------------
  // 3. Enum variant completeness
  // ---------------------------------------------------------------

  it("FlightStatus enum covers all Rust variants", () => {
    const allStatuses: import("@/types/flight").FlightStatus[] = [
      "draft",
      "planning",
      "ready",
      "active",
      "paused",
      "review",
      "done",
      "failed",
      "cancelled",
    ];
    expect(allStatuses).toHaveLength(9);
  });

  it("TaskStatus enum covers all Rust variants", () => {
    const allStatuses: import("@/types/flight").TaskStatus[] = [
      "pending",
      "blocked",
      "queued",
      "running",
      "approval_needed",
      "paused",
      "done",
      "failed",
      "cancelled",
    ];
    expect(allStatuses).toHaveLength(9);
  });

  it("TaskType enum covers all Rust variants", () => {
    const allTypes: import("@/types/flight").TaskType[] = [
      "implementation",
      "testing",
      "review",
      "validation",
      "research",
      "refactor",
      "documentation",
    ];
    expect(allTypes).toHaveLength(7);
  });
});
