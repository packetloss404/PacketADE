import { describe, expect, it } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import {
  deriveMode,
  flagsForMode,
  MODE_ORDER,
  nextMode,
} from "../agentModeChipUtils";

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

  // Regression: deriveMode had no deny_all branch, so a "Deny risky" session
  // displayed as full-tools default — a safety-posture misrepresentation.
  it("derives deny mode from deny_all instead of misreporting full tools", () => {
    expect(
      deriveMode(
        conversation({
          planMode: false,
          permissionMode: "deny_all",
          approveWrites: false,
        }),
      ),
    ).toBe("deny");
  });

  it("maps deny mode back to deny_all", () => {
    expect(flagsForMode("deny")).toEqual({
      planMode: false,
      permissionMode: "deny_all",
      approveWrites: false,
    });
  });

  // Regression: flagsForMode hardcoded approveWrites:false in every branch,
  // so any chip cycle silently destroyed the approveWrites setting.
  it("preserves approveWrites through every mode instead of clobbering it", () => {
    for (const mode of MODE_ORDER) {
      expect(flagsForMode(mode, true).approveWrites).toBe(true);
      expect(flagsForMode(mode, false).approveWrites).toBe(false);
    }
  });

  it("round-trips every mode through flagsForMode and deriveMode", () => {
    for (const mode of MODE_ORDER) {
      for (const approveWrites of [true, false]) {
        const flags = flagsForMode(mode, approveWrites);
        const conv = conversation(flags);
        expect(deriveMode(conv)).toBe(mode);
        expect(conv.approveWrites).toBe(approveWrites);
      }
    }
  });

  it("cycles through all modes, including deny, and wraps around", () => {
    const seen = new Set<string>();
    let mode = MODE_ORDER[0];
    for (let i = 0; i < MODE_ORDER.length; i++) {
      seen.add(mode);
      mode = nextMode(mode);
    }
    expect(mode).toBe(MODE_ORDER[0]);
    expect(seen).toEqual(new Set(MODE_ORDER));
  });

  it("treats a conversation with unset flags as default mode", () => {
    expect(deriveMode(conversation({}))).toBe("default");
  });
});
