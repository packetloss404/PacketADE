import { describe, expect, it } from "vitest";
import {
  buildPacketAgentPackage,
  buildWorkerPackage,
  summarizeConversationTranscript,
  validatePacketAgentPackageLocally,
} from "@/lib/packetAgentPackage";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt, Flight } from "@/types/flight";
import type { PacketAgentWorkerArtifactReference } from "@/types/packet-agent";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Ship the widget",
    objective: "Deliver a working widget",
    status: "active",
    priority: "medium",
    projectPath: "D:/projects/widget",
    workspaceId: "workspace-1",
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_123_456,
    totalCost: 0,
    totalTokens: 0,
    prompt: "Build the widget end to end.",
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    flightId: "flight-1",
    target: {
      kind: "local",
      basePath: "D:/projects/widget",
      worktreePath: "D:/projects/widget/.pkt-worktrees/attempt-1",
    },
    agentConfigId: "agent",
    model: "model",
    provider: "anthropic",
    branch: "pkt/attempt-1",
    baseBranch: "main",
    sessionId: "session-1",
    status: "running",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Fix the parser",
    agent: "api-claude" as AgentConversation["agent"],
    projectPath: "D:/projects/widget",
    status: "idle",
    messages: [
      { id: "m1", role: "user", content: "Please fix the parser bug", timestamp: 1 },
      { id: "m2", role: "assistant", content: "Investigating the tokenizer", timestamp: 2 },
    ],
    sessionId: null,
    rawOutput: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_999_999,
    mode: "api",
    ...overrides,
  };
}

describe("buildWorkerPackage — flight kind (frozen path)", () => {
  it("is byte-identical to the historical buildPacketAgentPackage output", async () => {
    const flight = makeFlight({ planningConversationId: "conv-9" });
    const legacy = await buildPacketAgentPackage(flight);
    const rebuilt = await buildWorkerPackage({ kind: "flight", flight });
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(legacy));
    expect(rebuilt.integrity.digest).toBe(legacy.integrity.digest);
  });

  it("only gains repository/revision when git context is explicitly passed", async () => {
    const flight = makeFlight();
    const plain = await buildWorkerPackage({ kind: "flight", flight });
    expect(plain.source.repository).toBeUndefined();
    expect(plain.source.revision).toBeUndefined();
    const enriched = await buildWorkerPackage(
      { kind: "flight", flight },
      { repository: "git@github.com:o/widget.git", revision: "main" },
    );
    expect(enriched.source.repository).toBe("git@github.com:o/widget.git");
    expect(enriched.source.revision).toBe("main");
    expect(enriched.integrity.digest).not.toBe(plain.integrity.digest);
  });
});

describe("buildWorkerPackage — attempt kind", () => {
  it("packages a local attempt with branch as revision and basePath fallback repository", async () => {
    const flight = makeFlight();
    const attempt = makeAttempt();
    const pkg = await buildWorkerPackage({ kind: "attempt", flight, attempt });
    expect(pkg.packageId).toBe("packetade:flight-1:attempt:attempt-1:worker");
    expect(pkg.source.sourceId).toBe("attempt-1");
    expect(pkg.source.flightId).toBe("flight-1");
    expect(pkg.source.revision).toBe("pkt/attempt-1");
    expect(pkg.source.repository).toBe("D:/projects/widget");
    expect(pkg.worker.content.notificationRoutes[0].reference).toBe("attempt:attempt-1");
    expect(validatePacketAgentPackageLocally(pkg)).toEqual([]);
  });

  it("packages an SSH attempt and prefers explicit git enrichment", async () => {
    const flight = makeFlight();
    const attempt = makeAttempt({
      target: {
        kind: "ssh",
        serverId: "server-1",
        basePath: "/srv/widget",
        worktreePath: "/srv/widget/.pkt-worktrees/attempt-1",
      },
      draftPrNumber: 42,
    });
    const pkg = await buildWorkerPackage(
      { kind: "attempt", flight, attempt },
      { repository: "git@github.com:o/widget.git" },
    );
    expect(pkg.source.repository).toBe("git@github.com:o/widget.git");
    expect(pkg.source.revision).toBe("pkt/attempt-1");
    expect(pkg.worker.content.instructions).toContain("Draft PR #42");
  });

  it("rejects an attempt whose worktree has no resolvable revision", async () => {
    const flight = makeFlight();
    const attempt = makeAttempt({ branch: "  " });
    await expect(buildWorkerPackage({ kind: "attempt", flight, attempt })).rejects.toThrow(
      /revision/i,
    );
  });
});

describe("buildWorkerPackage — conversation kind", () => {
  it("packages a worktree conversation without a flightId", async () => {
    const conversation = makeConversation({
      worktree: {
        basePath: "D:/projects/widget",
        worktreePath: "D:/projects/widget/.pkt-worktrees/conv-1",
        branch: "pkt/conv-1",
        createdAt: 1,
        state: "active",
      },
    });
    const pkg = await buildWorkerPackage({ kind: "conversation", conversation });
    expect(pkg.packageId).toBe("packetade:conversation:conv-1:worker");
    expect(pkg.source.flightId).toBeUndefined();
    expect(pkg.source.conversationId).toBe("conv-1");
    expect(pkg.source.sourceId).toBe("conv-1");
    expect(pkg.source.revision).toBe("pkt/conv-1");
    expect(pkg.source.repository).toBe("D:/projects/widget");
    expect(pkg.worker.content.instructions).toContain("User: Please fix the parser bug");
    expect(pkg.worker.content.notificationRoutes[0].reference).toBe("conversation:conv-1");
    expect(validatePacketAgentPackageLocally(pkg)).toEqual([]);
  });

  it("uses the first user turn as objective when there is no title", async () => {
    const conversation = makeConversation({ title: "" });
    const pkg = await buildWorkerPackage({ kind: "conversation", conversation });
    expect(pkg.worker.content.objective).toBe("Please fix the parser bug");
  });

  it("rejects a worktree conversation with no resolvable revision", async () => {
    const conversation = makeConversation({
      worktree: {
        basePath: "D:/projects/widget",
        worktreePath: "D:/projects/widget/.pkt-worktrees/conv-1",
        branch: "  ",
        createdAt: 1,
        state: "active",
      },
    });
    await expect(buildWorkerPackage({ kind: "conversation", conversation })).rejects.toThrow(
      /revision/i,
    );
  });

  it("rejects a conversation with no project path at all", async () => {
    const conversation = makeConversation({ projectPath: " " });
    await expect(buildWorkerPackage({ kind: "conversation", conversation })).rejects.toThrow(
      /project path|repository/i,
    );
  });

  it("bounds the transcript summary", () => {
    const conversation = makeConversation({
      messages: Array.from({ length: 100 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: "x".repeat(500),
        timestamp: index,
      })),
    });
    const summary = summarizeConversationTranscript(conversation);
    expect(summary.length).toBeLessThanOrEqual(7_000);
    expect(summary).toContain("…");
  });
});

describe("validatePacketAgentPackageLocally — artifact references", () => {
  it("flags duplicate artifact references", async () => {
    const flight = makeFlight();
    const pkg = await buildWorkerPackage({ kind: "flight", flight });
    const artifact: PacketAgentWorkerArtifactReference = {
      reference: "artifact://one",
      mediaType: "text/plain",
      byteLength: 4,
      contentDigest: "sha256:" + "a".repeat(64),
      role: "input",
      classification: "internal",
    };
    pkg.artifacts = [artifact, { ...artifact }];
    const issues = validatePacketAgentPackageLocally(pkg);
    expect(issues.some((issue) => issue.includes("Duplicate artifact reference"))).toBe(true);
  });
});
