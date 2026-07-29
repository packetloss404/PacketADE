import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyMcpWrite, type McpWriteIntent } from "@/lib/mcpWriteBridge";

const mocks = vi.hoisted(() => ({
  appendCoordinationEvent: vi.fn(),
  postCoordinationMessage: vi.fn().mockResolvedValue([]),
  acknowledgeCoordinationMessage: vi.fn(),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({ appendCoordinationEvent: mocks.appendCoordinationEvent }),
  },
}));

vi.mock("@/stores/coordinationInboxStore", () => ({
  postCoordinationMessage: mocks.postCoordinationMessage,
  acknowledgeCoordinationMessage: mocks.acknowledgeCoordinationMessage,
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
  beforeEach(() => {
    mocks.appendCoordinationEvent.mockReset();
    mocks.postCoordinationMessage.mockClear();
    mocks.acknowledgeCoordinationMessage.mockClear();
  });

  it("appends a coordination event with a namespaced actor", () => {
    applyMcpWrite(intent());
    expect(mocks.appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({
        type: "handoff",
        summary: "did the thing",
        agentId: "mcp:claude", // namespaced — can't impersonate "you"/"system"
        metadata: { source: "mcp" },
        provenance: expect.objectContaining({
          origin: "mcp",
          authority: "evidence_only",
        }),
      }),
    );
  });

  it("uses 'mcp' as the actor when no agentId is given", () => {
    applyMcpWrite(intent({ event: { type: "handoff", summary: "hi" } }));
    expect(mocks.appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ agentId: "mcp" }),
    );
  });

  it("ignores unknown ops", () => {
    applyMcpWrite(intent({ op: "delete_everything" }));
    expect(mocks.appendCoordinationEvent).not.toHaveBeenCalled();
  });

  it("ignores intents missing flightId or summary", () => {
    applyMcpWrite(intent({ flightId: "" }));
    applyMcpWrite(intent({ event: { type: "handoff", summary: "" } }));
    expect(mocks.appendCoordinationEvent).not.toHaveBeenCalled();
  });

  it("falls back to 'handoff' for an unknown event type", () => {
    applyMcpWrite(intent({ event: { type: "bogus", summary: "hi" } }));
    expect(mocks.appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ type: "handoff", summary: "hi" }),
    );
  });

  it("passes through a known event type and maps a null agentId to 'mcp'", () => {
    applyMcpWrite(intent({ event: { type: "escalation", summary: "stuck", agentId: null } }));
    expect(mocks.appendCoordinationEvent).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ type: "escalation", agentId: "mcp" }),
    );
  });

  it("routes validated MCP inbox posts as agent-origin messages without direct forwarding", () => {
    applyMcpWrite(
      intent({
        op: "post_coordination_message",
        event: {
          kind: "blocker",
          recipientKind: "flight",
          recipientId: "f1",
          body: "Need a decision",
          agentId: "claude",
          dedupeKey: "turn-1",
        },
      }),
    );
    expect(mocks.postCoordinationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        flightId: "f1",
        kind: "blocker",
        sender: { kind: "agent", id: "mcp:claude", displayName: "mcp:claude" },
        recipients: [{ kind: "flight", id: "f1", label: undefined }],
        body: "Need a decision",
        dedupeKey: "turn-1",
        provenance: [
          expect.objectContaining({
            origin: "mcp",
            authority: "evidence_only",
          }),
        ],
      }),
    );
  });

  it("routes MCP inbox acknowledgements with namespaced provenance", () => {
    applyMcpWrite(
      intent({
        op: "acknowledge_coordination_message",
        event: { messageId: "inbox-1", agentId: "codex", note: "Handled" },
      }),
    );
    expect(mocks.acknowledgeCoordinationMessage).toHaveBeenCalledWith(
      "f1",
      "inbox-1",
      { kind: "agent", id: "mcp:codex", displayName: "mcp:codex" },
      "Handled",
    );
  });
});
