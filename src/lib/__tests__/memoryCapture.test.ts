import { describe, expect, it } from "vitest";
import {
  buildCoordinationMemoryInput,
  buildTranscriptMemoryInput,
} from "@/lib/memoryCapture";
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
    expect(input.projectPath).toBe("/proj");
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
    expect(input.projectPath).toBe("/proj");
    expect(input.tags).toEqual(["agent-transcript", "api-claude"]);
  });

  it("falls back to the conversation title when the message is blank", () => {
    const input = buildTranscriptMemoryInput(msg("   "), conversation);
    expect(input.summary).toBe("Debug session");
  });
});
