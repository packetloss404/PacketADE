import { describe, expect, it } from "vitest";
import {
  buildCoordinationMemoryInput,
  buildTranscriptMemoryInput,
  conversationMemoryScope,
} from "@/lib/memoryCapture";
import { memoryWriteKey, remoteMemoryProjectKey } from "@/stores/memoryStore";
import type { CoordinationEvent, Flight } from "@/types/flight";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

const flight = { id: "f1", title: "Ship the thing", projectPath: "/proj" } as Flight;

const coordEvent = (over: Partial<CoordinationEvent> = {}): CoordinationEvent => ({
  id: "e1",
  flightId: "f1",
  type: "handoff",
  summary: "handed off review to codex",
  timestamp: 1000,
  ...over,
});

describe("buildCoordinationMemoryInput (M4)", () => {
  it("carries the flight project path, a flight-scoped source, and typed tags", () => {
    const input = buildCoordinationMemoryInput(coordEvent({ agentId: "claude" }), flight);
    expect(memoryWriteKey(input.scope)).toBe("/proj");
    expect(input.source).toBe("flight-coordination");
    expect(input.summary).toBe("Ship the thing: handed off review to codex");
    expect(input.tags).toEqual(["flight-coordination", "handoff", "flight-f1"]);
    expect(input.body).toContain("Actor: claude");
    expect(input.body).toContain("handed off review to codex");
  });

  it("falls back to a 'system' actor when the event has no agent", () => {
    const input = buildCoordinationMemoryInput(coordEvent(), flight);
    expect(input.body).toContain("Actor: system");
  });

  it("truncates an overlong summary line", () => {
    const long = "x".repeat(300);
    const input = buildCoordinationMemoryInput(coordEvent({ summary: long }), flight);
    expect(input.summary.length).toBeLessThanOrEqual(120);
    expect(input.summary.endsWith("…")).toBe(true);
  });
});

const conversation = {
  id: "c1",
  title: "Debug session",
  agent: "api-claude",
  projectPath: "/proj",
} as AgentConversation;

const msg = (content: string): AgentMessage => ({
  id: "m1",
  role: "assistant",
  content,
  timestamp: 1000,
});

describe("buildTranscriptMemoryInput (M4)", () => {
  it("uses the first non-blank line as the summary and keeps the full body", () => {
    const input = buildTranscriptMemoryInput(
      msg("\n\nThe root cause was a race in persistState.\nMore detail here."),
      conversation,
    );
    expect(input.summary).toBe("The root cause was a race in persistState.");
    expect(input.body).toContain("More detail here.");
    expect(input.source).toBe("agent-transcript");
    expect(memoryWriteKey(input.scope)).toBe("/proj");
    expect(input.tags).toEqual(["agent-transcript", "api-claude"]);
  });

  it("falls back to the conversation title when the message is blank", () => {
    const input = buildTranscriptMemoryInput(msg("   "), conversation);
    expect(input.summary).toBe("Debug session");
  });

  it("keys a capture from a remote conversation to that server, not the bare path", () => {
    // The pre-existing defect this closes: a manual capture from a remote
    // agent transcript was stamped with the plain remote path, which no ssh
    // brief scope will ever match — written, then immediately unreachable.
    const remote = {
      ...conversation,
      sshTarget: {
        id: "srv-1",
        name: "build-box",
        host: "h",
        user: "u",
        remotePath: "/srv/app",
      },
    } as AgentConversation;
    const input = buildTranscriptMemoryInput(msg("Remote finding"), remote);
    expect(memoryWriteKey(input.scope)).toBe(remoteMemoryProjectKey("srv-1", "/srv/app"));
    expect(memoryWriteKey(input.scope)).not.toBe("/proj");
  });
});

describe("conversationMemoryScope", () => {
  it("is local when the conversation has no ssh target", () => {
    expect(conversationMemoryScope(conversation)).toEqual({
      kind: "local",
      projectPath: "/proj",
      workspaceId: null,
    });
  });

  it("falls back to the conversation path when the ssh target carries no remote path", () => {
    const remote = {
      ...conversation,
      sshTarget: { id: "srv-1", name: "build-box", host: "h", user: "u", remotePath: "" },
    } as AgentConversation;
    const scope = conversationMemoryScope(remote);
    expect(scope.kind).toBe("ssh");
    expect(scope.remotePath).toBe("/proj");
  });
});
