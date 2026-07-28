import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flight, Task } from "@/types/flight";

const mocks = vi.hoisted(() => ({
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
  loadPersistedState: vi.fn(),
  writePty: vi.fn().mockResolvedValue(undefined),
}));

const agentStore = vi.hoisted(() => {
  const state = {
    conversations: [] as Array<Record<string, unknown>>,
    selectedConversationId: null as string | null,
    sendMessage: vi.fn(),
  };
  return {
    state,
    getState: () => state,
    setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
  };
});

vi.mock("@/lib/tauri", () => mocks);
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: agentStore.getState,
    setState: agentStore.setState,
  },
}));

import { useFlightStore } from "@/stores/flightStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  acknowledgeCoordinationMessage,
  archiveCoordinationMessage,
  expandCoordinationRecipients,
  INBOX_MAX_BODY,
  postCoordinationMessage,
  retryCoordinationMessage,
  validateCoordinationMessageInput,
} from "@/stores/coordinationInboxStore";

function task(id: string, role: Task["role"]): Task {
  return {
    id,
    milestoneId: "milestone-1",
    flightId: "flight-1",
    title: id,
    description: id,
    order: 0,
    status: "pending",
    type: "implementation",
    role,
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    dependsOn: [],
    sessionId: null,
    createdAt: 1,
    cost: 0,
    tokens: 0,
  };
}

function flight(): Flight {
  return {
    id: "flight-1",
    title: "Inbox",
    objective: "Coordinate",
    status: "active",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [
      {
        id: "milestone-1",
        flightId: "flight-1",
        title: "M",
        description: "M",
        order: 0,
        status: "active",
        tasks: [task("builder-1", "builder"), task("builder-2", "builder")],
        validationCriteria: [],
      },
    ],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    attempts: [
      {
        id: "attempt-1",
        flightId: "flight-1",
        target: { kind: "local", basePath: "/repo", worktreePath: "/attempt" },
        agentConfigId: "api-claude",
        model: "claude-sonnet-4-6",
        provider: "claude",
        branch: "pkt/attempt-1",
        baseBranch: "main",
        sessionId: "session-1",
        status: "running",
        cost: 0,
        tokens: 0,
      },
    ],
  };
}

describe("coordination inbox domain", () => {
  beforeEach(() => {
    useFlightStore.setState({ flights: [flight()], activeFlightId: "flight-1" });
    useAgentTaskStore.setState({
      conversations: [],
      selectedConversationId: null,
      sendMessage: vi.fn(),
    });
    vi.clearAllMocks();
  });

  it("expands role recipients into bounded, deduped task deliveries", () => {
    const recipients = expandCoordinationRecipients(flight(), [
      { kind: "role", id: "builder" },
      { kind: "task", id: "builder-1" },
    ]);
    expect(recipients).toEqual([
      { kind: "task", id: "builder-1", label: "builder-1" },
      { kind: "task", id: "builder-2", label: "builder-2" },
    ]);
  });

  it("rejects empty, oversized, invalid, and recipient-less messages", () => {
    const value = flight();
    const base = {
      flightId: value.id,
      kind: "instruction" as const,
      sender: { kind: "user" as const, id: "user", displayName: "You" },
      recipients: [{ kind: "flight" as const, id: value.id }],
      body: "Do it",
    };
    expect(() => validateCoordinationMessageInput(value, { ...base, body: "" })).toThrow(
      "required",
    );
    expect(() =>
      validateCoordinationMessageInput(value, {
        ...base,
        body: "x".repeat(INBOX_MAX_BODY + 1),
      }),
    ).toThrow("exceeds");
    expect(() => validateCoordinationMessageInput(value, { ...base, recipients: [] })).toThrow(
      "no destinations",
    );
  });

  it("posts immutable per-recipient deliveries and dedupes retries", async () => {
    const input = {
      flightId: "flight-1",
      kind: "question" as const,
      sender: { kind: "agent" as const, id: "agent-1", displayName: "Agent" },
      recipients: [{ kind: "role" as const, id: "builder" }],
      body: "Which API should I use?",
      dedupeKey: "same-turn",
    };
    const first = await postCoordinationMessage(input);
    const second = await postCoordinationMessage(input);
    expect(first).toHaveLength(2);
    expect(second.map((message) => message.id)).toEqual(first.map((message) => message.id));
    expect(useFlightStore.getState().flights[0].coordinationInbox).toHaveLength(2);
  });

  it("queues API sends through the existing conversation action at a safe boundary", async () => {
    const sendMessage = vi.fn();
    useAgentTaskStore.setState({
      conversations: [
        {
          id: "session-1",
          title: "Agent",
          agent: "api-claude",
          projectPath: "/repo",
          status: "active",
          messages: [],
          sessionId: "session-1",
          rawOutput: "",
          createdAt: 1,
          updatedAt: 1,
          mode: "api",
        },
      ],
      sendMessage,
    });
    const [message] = await postCoordinationMessage({
      flightId: "flight-1",
      kind: "instruction",
      sender: { kind: "user", id: "user", displayName: "You" },
      recipients: [{ kind: "attempt", id: "attempt-1", label: "attempt" }],
      body: "Pause after the current tool call.",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining("Pause after the current tool call."),
    );
    expect(
      useFlightStore
        .getState()
        .flights[0].coordinationInbox?.find((candidate) => candidate.id === message.id)?.status,
    ).toBe("delivered");
  });

  it("acknowledges once, retries failed messages, and archives without deletion", async () => {
    const [message] = await postCoordinationMessage({
      flightId: "flight-1",
      kind: "blocker",
      sender: { kind: "agent", id: "agent-1", displayName: "Agent" },
      recipients: [{ kind: "flight", id: "flight-1" }],
      body: "Need a decision.",
    });
    acknowledgeCoordinationMessage(
      "flight-1",
      message.id,
      { kind: "user", id: "user", displayName: "You" },
      "Seen",
    );
    acknowledgeCoordinationMessage(
      "flight-1",
      message.id,
      { kind: "user", id: "user", displayName: "You" },
      "Duplicate",
    );
    let stored = useFlightStore
      .getState()
      .flights[0].coordinationInbox?.find((candidate) => candidate.id === message.id);
    expect(stored?.acknowledgements).toHaveLength(1);
    useFlightStore.getState().updateFlight("flight-1", {
      coordinationInbox: [{ ...stored!, status: "failed", errorMessage: "offline" }],
    });
    await retryCoordinationMessage("flight-1", message.id);
    stored = useFlightStore
      .getState()
      .flights[0].coordinationInbox?.find((candidate) => candidate.id === message.id);
    expect(stored?.status).toBe("queued");
    archiveCoordinationMessage("flight-1", message.id);
    expect(useFlightStore.getState().flights[0].coordinationInbox?.[0].status).toBe("archived");
  });
});
