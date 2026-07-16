import { describe, expect, it } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import {
  deriveMode,
  flagsForMode,
  MODE_ORDER,
  modesForApprovals,
  nextMode,
  nextModeIn,
  SANDBOX_MODE_ORDER,
  SANDBOX_POSTURE_LABEL,
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

// P1-S4 (Codex honesty): capability-filtered posture set.
describe("capability-filtered mode set", () => {
  it("returns the full MODE_ORDER for approval-capable providers", () => {
    expect(modesForApprovals(true)).toEqual(MODE_ORDER);
  });

  it("returns only the three honorable sandbox postures when approvals are unsupported", () => {
    expect(modesForApprovals(false)).toEqual(SANDBOX_MODE_ORDER);
    expect(modesForApprovals(false)).toEqual(["plan", "default", "yolo"]);
  });

  it("excludes the approval-implying manual and deny postures for Codex", () => {
    expect(modesForApprovals(false)).not.toContain("manual");
    expect(modesForApprovals(false)).not.toContain("deny");
  });

  it("relabels every honorable posture in sandbox vocabulary", () => {
    expect(SANDBOX_POSTURE_LABEL.plan).toBe("Read-only");
    expect(SANDBOX_POSTURE_LABEL.default).toBe("Workspace-write");
    expect(SANDBOX_POSTURE_LABEL.yolo).toBe("Full access");
  });

  it("cycles only through the filtered order and wraps around", () => {
    const order = modesForApprovals(false);
    expect(nextModeIn("plan", order)).toBe("default");
    expect(nextModeIn("default", order)).toBe("yolo");
    expect(nextModeIn("yolo", order)).toBe("plan");
  });

  it("snaps a now-filtered posture (persisted manual/deny) to the first honorable one", () => {
    const order = modesForApprovals(false);
    expect(nextModeIn("manual", order)).toBe("plan");
    expect(nextModeIn("deny", order)).toBe("plan");
  });

  it("leaves the unfiltered cycle behavior identical to nextMode", () => {
    for (const mode of MODE_ORDER) {
      expect(nextModeIn(mode, MODE_ORDER)).toBe(nextMode(mode));
    }
  });
});
