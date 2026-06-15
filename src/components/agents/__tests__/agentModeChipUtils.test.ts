import { describe, expect, it } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import { deriveMode, flagsForMode } from "../agentModeChipUtils";

function conversation(overrides: Partial<AgentConversation>): AgentConversation {
  return {
    id: "conv-1",
    title: "Conversation",
    agent: "api-openai-codex",
    projectPath: "/repo",
    status: "idle",
    messages: [],
    sessionId: "session-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

describe("agent mode chip flags", () => {
  it("maps manual mode to ask-for-risky without auto-approving writes", () => {
    expect(flagsForMode("manual")).toEqual({
      planMode: false,
      permissionMode: "ask_for_risky",
      approveWrites: false,
    });
  });

  it("derives manual mode from ask-for-risky permission posture", () => {
    expect(
      deriveMode(
        conversation({
          planMode: false,
          permissionMode: "ask_for_risky",
          approveWrites: false,
        }),
      ),
    ).toBe("manual");
  });
});
