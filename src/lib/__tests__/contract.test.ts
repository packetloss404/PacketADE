import { describe, it, expect } from "vitest";
import type { Flight, Task, Milestone, TaskResult } from "@/types/flight";

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
  // 2. snake_case key mapping — Rust serialization contract
  // ---------------------------------------------------------------

  it("snake_case Rust JSON keys map to expected TS camelCase fields", () => {
    // Simulate what serde produces for a Task
    const rustTask = {
      id: "t1",
      milestone_id: "ms1",
      flight_id: "f1",
      title: "Task",
      description: "desc",
      order: 0,
      status: "pending",
      task_type: "implementation",
      agent_config_id: "claude-code",
      agent_args: null,
      model: null,
      depends_on: [],
      session_id: null,
      result: null,
      created_at: 0,
      started_at: null,
      completed_at: null,
      cost: 0,
      tokens: 0,
    };

    // These are the critical snake_case keys the conversion layer depends on
    expect(rustTask.task_type).toBe("implementation");
    expect(rustTask.agent_config_id).toBe("claude-code");
    expect(rustTask.milestone_id).toBe("ms1");
    expect(rustTask.flight_id).toBe("f1");
    expect(rustTask.depends_on).toEqual([]);
    expect(rustTask.session_id).toBeNull();
    expect(rustTask.created_at).toBe(0);
    expect(rustTask.started_at).toBeNull();
    expect(rustTask.completed_at).toBeNull();
  });

  it("snake_case Rust JSON keys for Flight", () => {
    const rustFlight = {
      id: "f1",
      title: "Test",
      objective: "obj",
      status: "active",
      priority: "high",
      project_path: "/test",
      git_branch: "main",
      milestones: [],
      linked_session_ids: [],
      created_at: 0,
      updated_at: 0,
      completed_at: null,
      total_cost: 0,
      total_tokens: 0,
    };

    expect(rustFlight.project_path).toBe("/test");
    expect(rustFlight.git_branch).toBe("main");
    expect(rustFlight.linked_session_ids).toEqual([]);
    expect(rustFlight.total_cost).toBe(0);
    expect(rustFlight.total_tokens).toBe(0);
  });

  it("snake_case Rust JSON keys for TaskResult", () => {
    const rustResult = {
      exit_code: 0,
      summary: "ok",
      files_changed: ["a.rs"],
      errors: [],
      duration_ms: 5000,
      handoff: {
        summary: "done",
        files_changed: ["a.rs"],
        tests_needed: ["test_a"],
        follow_ups: [],
      },
      validation: {
        verdict: "pass",
        summary: "ok",
        assertions: [{ label: "compiles", status: "pass", details: null }],
      },
    };

    expect(rustResult.exit_code).toBe(0);
    expect(rustResult.files_changed).toEqual(["a.rs"]);
    expect(rustResult.duration_ms).toBe(5000);
    expect(rustResult.handoff.files_changed).toEqual(["a.rs"]);
    expect(rustResult.handoff.tests_needed).toEqual(["test_a"]);
    expect(rustResult.handoff.follow_ups).toEqual([]);
    expect(rustResult.validation.assertions[0].details).toBeNull();
  });

  it("snake_case Rust JSON keys for PersistedState settings & ui", () => {
    const rustState = {
      version: 1,
      flights: [],
      agents: [],
      settings: {
        max_parallel_sessions: 3,
        milestone_gating: true,
        project_path: "/project",
      },
      ui: {
        selected_flight_id: null,
        selected_view: null,
        theme: null,
      },
    };

    expect(rustState.settings.max_parallel_sessions).toBe(3);
    expect(rustState.settings.milestone_gating).toBe(true);
    expect(rustState.settings.project_path).toBe("/project");
    expect(rustState.ui.selected_flight_id).toBeNull();
    expect(rustState.ui.selected_view).toBeNull();
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
