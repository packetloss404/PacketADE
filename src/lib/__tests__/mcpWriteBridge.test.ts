import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyMcpWrite, type McpWriteIntent } from "@/lib/mcpWriteBridge";

const appendCoordinationEvent = vi.fn();

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({ appendCoordinationEvent }),
  },
}));

function intent(over: Partial<McpWriteIntent> = {}): McpWriteIntent {
  return {
    op: "append_coordination_event",
    flightId: "f1",
    event: { type: "handoff", summary: "did the thing", agentId: "claude" },
    ...over,
  };
}

describe("applyMcpWrite", () => {
  beforeEach(() => appendCoordinationEvent.mockReset());

  it("appends a coordination event with a namespaced actor", () => {
    applyMcpWrite(intent());
    expect(appendCoordinationEvent).toHaveBeenCalledWith("f1", {
      type: "handoff",
      summary: "did the thing",
      agentId: "mcp:claude", // namespaced — can't impersonate "you"/"system"
      metadata: { source: "mcp" },
    });
  });

  it("uses 'mcp' as the actor when no agentId is given", () => {
    applyMcpWrite(intent({ event: { type: "handoff", summary: "hi" } }));
    expect(appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ agentId: "mcp" }),
    );
  });

  it("ignores unknown ops", () => {
    applyMcpWrite(intent({ op: "delete_everything" }));
    expect(appendCoordinationEvent).not.toHaveBeenCalled();
  });

  it("ignores intents missing flightId or summary", () => {
    applyMcpWrite(intent({ flightId: "" }));
    applyMcpWrite(intent({ event: { type: "handoff", summary: "" } }));
    expect(appendCoordinationEvent).not.toHaveBeenCalled();
  });

  it("falls back to 'handoff' for an unknown event type", () => {
    applyMcpWrite(intent({ event: { type: "bogus", summary: "hi" } }));
    expect(appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ type: "handoff", summary: "hi" }),
    );
  });

  it("passes through a known event type and maps a null agentId to 'mcp'", () => {
    applyMcpWrite(intent({ event: { type: "escalation", summary: "stuck", agentId: null } }));
    expect(appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ type: "escalation", agentId: "mcp" }),
    );
  });
});
