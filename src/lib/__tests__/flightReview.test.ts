import { describe, expect, it } from "vitest";
import {
  collectTaskReportedFiles,
  matchGitFilesToFlightTasks,
  selectFlightReviewFiles,
  summarizeFlightReview,
} from "@/lib/flightReview";
import type { Flight, Task } from "@/types/flight";

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    milestoneId: "ms-1",
    flightId: "flight-1",
    title: "Task one",
    description: "",
    order: 0,
    status: "done",
    type: "implementation",
    agentConfigId: "api-claude",
    dependsOn: [],
    sessionId: "conv-1",
    createdAt: 1,
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function flight(tasks: Task[]): Flight {
  return {
    id: "flight-1",
    title: "Flight",
    objective: "",
    status: "review",
    priority: "medium",
    projectPath: "D:/projects/example",
    workspaceId: "ws-1",
    milestones: [
      {
        id: "ms-1",
        flightId: "flight-1",
        title: "Milestone",
        description: "",
        order: 0,
        status: "done",
        tasks,
        validationCriteria: [],
      },
    ],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    attempts: [],
  };
}

describe("flightReview", () => {
  it("deduplicates files reported through result, handoff, and review packets", () => {
    const files = collectTaskReportedFiles(
      task({
        result: {
          exitCode: 0,
          summary: "",
          filesChanged: ["src/a.ts", "src/b.ts"],
          errors: [],
          duration: 1,
          handoff: {
            summary: "",
            filesChanged: ["src/a.ts", "src/c.ts"],
            testsNeeded: [],
            followUps: [],
          },
        },
        reviewPacket: {
          id: "rev-1",
          taskId: "task-1",
          flightId: "flight-1",
          milestoneId: "ms-1",
          requestedAt: 1,
          reviewType: "file_write",
          summary: "",
          filePaths: ["src/b.ts", "src/d.ts"],
        },
      }),
    );
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("matches changed files to reported files and owned path prefixes", () => {
    const f = flight([
      task({
        result: {
          exitCode: 0,
          summary: "",
          filesChanged: ["D:/projects/example/src/exact.ts"],
          errors: [],
          duration: 1,
        },
        ownedPaths: ["src/features/review"],
      }),
    ]);

    const match = matchGitFilesToFlightTasks(
      ["src/exact.ts", "src/features/review/panel.tsx", "src/unrelated.ts"],
      [f],
      { projectPath: "D:\\projects\\example" },
    );

    expect(match.linkedFileCount).toBe(2);
    expect(match.taskCount).toBe(1);
    expect(summarizeFlightReview(f).reportedFileCount).toBe(1);
    expect(summarizeFlightReview(f).ownedFileCount).toBe(1);
  });

  it("selects review files by task, conversation session, and attempt session", () => {
    const f = flight([
      task({
        id: "task-1",
        sessionId: "session-1",
        result: {
          exitCode: 0,
          summary: "",
          filesChanged: ["src/session.ts"],
          errors: [],
          duration: 1,
        },
        reviewPacket: {
          id: "rev-1",
          taskId: "task-1",
          flightId: "flight-1",
          milestoneId: "ms-1",
          requestedAt: 1,
          reviewType: "file_write",
          summary: "",
          filePaths: ["src/review.ts"],
          sessionId: "session-1",
        },
      }),
    ]);
    f.attempts = [
      {
        id: "att-1",
        flightId: "flight-1",
        target: {
          kind: "local",
          basePath: "D:/projects/example",
          worktreePath: "D:/projects/example/.pkt-worktrees/att-1",
        },
        agentConfigId: "api-claude",
        model: "claude",
        provider: "api-claude",
        branch: "pkt/att-1",
        baseBranch: "main",
        sessionId: "session-1",
        status: "reviewing",
        cost: 0,
        tokens: 0,
      },
    ];

    const byConversation = selectFlightReviewFiles([f], {
      conversationId: "session-1",
    });
    const byAttempt = selectFlightReviewFiles([f], { attemptId: "att-1" });
    const byTask = selectFlightReviewFiles([f], { taskId: "task-1" });

    expect(byConversation.files.map((ref) => ref.filePath)).toEqual([
      "src/session.ts",
      "src/review.ts",
    ]);
    expect(byAttempt.attemptIds).toEqual(["att-1"]);
    expect(byAttempt.files).toHaveLength(2);
    expect(byTask.taskIds).toEqual(["task-1"]);
    expect(byTask.files[0].reviewPacketId).toBe("rev-1");
  });

  it("reports when an attempt is known but no task file metadata exists", () => {
    const f = flight([]);
    f.attempts = [
      {
        id: "att-empty",
        flightId: "flight-1",
        target: {
          kind: "local",
          basePath: "D:/projects/example",
          worktreePath: "D:/projects/example/.pkt-worktrees/att-empty",
        },
        agentConfigId: "api-claude",
        model: "claude",
        provider: "api-claude",
        branch: "pkt/att-empty",
        baseBranch: "main",
        sessionId: "session-empty",
        status: "completed",
        cost: 0,
        tokens: 0,
      },
    ];

    const selected = selectFlightReviewFiles([f], { attemptId: "att-empty" });

    expect(selected.files).toEqual([]);
    expect(selected.flightIds).toEqual(["flight-1"]);
    expect(selected.attemptIds).toEqual(["att-empty"]);
    expect(selected.hasAttemptWithoutFileData).toBe(true);
  });
});
