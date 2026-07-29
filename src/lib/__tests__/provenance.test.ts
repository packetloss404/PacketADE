import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTurnEvidence,
  attachmentProvenance,
  assistantDerivativeProvenance,
  normalizeMessageProvenance,
  provenanceNeedsRiskGate,
  safeWebLocator,
  toolResultProvenance,
  userIntentProvenance,
} from "@/lib/provenance";
import {
  auditSourceChain,
  normalizeProvenanceAuditSnapshot,
  useProvenanceAuditStore,
} from "@/stores/provenanceAuditStore";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";

function conversation(messages: AgentMessage[]): AgentConversation {
  return {
    id: "conv-1",
    title: "test",
    agent: "api-openai",
    projectPath: "C:\\repo",
    status: "active",
    messages,
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
  };
}

describe("provenance v1", () => {
  it("classifies web evidence, strips URL secrets, and hashes without copying content", () => {
    const provenance = toolResultProvenance({
      toolId: "web-1",
      name: "web_fetch",
      input: JSON.stringify({
        url: "https://example.com/docs?token=secret#fragment",
      }),
      content: "[UNTRUSTED WEB CONTENT nonce=abc] evidence",
    });

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      origin: "web",
      authority: "evidence_only",
      identity: { locator: "https://example.com/docs" },
      integrity: {
        state: "unverified",
        hashAlgorithm: "fnv1a64",
      },
    });
    expect(provenance.integrity.transforms).toEqual(["extracted", "redacted"]);
    expect(JSON.stringify(provenance)).not.toContain("secret");
    expect(JSON.stringify(provenance)).not.toContain("[UNTRUSTED WEB CONTENT");
  });

  it("classifies local, remote, MCP, memory, agent, and unknown tool results", () => {
    const cases = [
      ["Read", false, "local_workspace"],
      ["Read", true, "remote_workspace"],
      ["mcp__github__search", false, "mcp"],
      ["memory_search", false, "memory"],
      ["spawn_subagent", false, "agent"],
      ["future_tool", false, "unknown"],
    ] as const;
    for (const [name, remote, expected] of cases) {
      expect(
        toolResultProvenance({ toolId: name, name, remote }).origin,
      ).toBe(expected);
    }
  });

  it("migrates old records to unknown without promoting authority", () => {
    const message = normalizeMessageProvenance({
      id: "legacy-message",
      role: "assistant",
      content: "old",
      timestamp: 100,
      toolCalls: [{ id: "legacy-tool", name: "Read", status: "done" }],
    });

    expect(message.provenance).toMatchObject({
      origin: "unknown",
      authority: "evidence_only",
      integrity: { state: "unknown" },
    });
    expect(message.toolCalls?.[0].provenance?.origin).toBe("unknown");
  });

  it("preserves tool lineage on generated derivatives", () => {
    const tool = toolResultProvenance({
      toolId: "mcp-1",
      name: "mcp__github__search",
      content: "result",
    });
    const message: AgentMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "summary",
      timestamp: 2,
      toolCalls: [
        {
          id: "mcp-1",
          name: "mcp__github__search",
          status: "done",
          provenance: tool,
        },
      ],
    };

    expect(assistantDerivativeProvenance(message).lineage.parentIds).toEqual([
      tool.id,
    ]);
  });

  it("keeps imported attachments evidence-only without persisting payloads", () => {
    const evidence = attachmentProvenance(
      "u1",
      [{ media_type: "image/png", data_base64: "secret-binary-canary" }],
      10,
    );
    const user: AgentMessage = {
      id: "u1",
      role: "user",
      content: "use this screenshot",
      timestamp: 10,
      provenance: userIntentProvenance("u1", 10),
      evidence,
    };
    const conv = conversation([user]);

    expect(evidence[0]).toMatchObject({
      origin: "imported_file",
      authority: "evidence_only",
      identity: { locator: "image/png" },
      integrity: { hashAlgorithm: "fnv1a64" },
    });
    expect(JSON.stringify(evidence)).not.toContain("secret-binary-canary");
    expect(provenanceNeedsRiskGate(conv, "edit_in_project")).toBe(true);
    expect(
      assistantDerivativeProvenance(
        {
          id: "a1",
          role: "assistant",
          content: "summary",
          timestamp: 11,
        },
        activeTurnEvidence(conv),
      ).lineage.parentIds,
    ).toEqual([evidence[0].id]);
  });

  it("gates risky follow-ons after external evidence but not local reads", () => {
    const user: AgentMessage = {
      id: "u1",
      role: "user",
      content: "inspect",
      timestamp: 1,
      provenance: userIntentProvenance("u1", 1),
    };
    const web = toolResultProvenance({
      toolId: "web",
      name: "web_fetch",
      content: "content",
    });
    const assistant: AgentMessage = {
      id: "a1",
      role: "assistant",
      content: "",
      timestamp: 2,
      toolCalls: [
        { id: "web", name: "web_fetch", status: "done", provenance: web },
      ],
    };
    const tainted = conversation([user, assistant]);

    expect(activeTurnEvidence(tainted)).toEqual([web]);
    expect(provenanceNeedsRiskGate(tainted, "read")).toBe(false);
    expect(provenanceNeedsRiskGate(tainted, "edit_in_project")).toBe(true);

    const local = toolResultProvenance({
      toolId: "read",
      name: "Read",
      content: "local",
    });
    const localConversation = conversation([
      user,
      {
        ...assistant,
        toolCalls: [
          { id: "read", name: "Read", status: "done", provenance: local },
        ],
      },
    ]);
    expect(provenanceNeedsRiskGate(localConversation, "edit_in_project")).toBe(
      false,
    );
  });

  it("removes query and fragment data from safe web locators", () => {
    expect(safeWebLocator("https://example.com/a?api_key=canary#x")).toBe(
      "https://example.com/a",
    );
  });
});

describe("bounded redacted provenance audit", () => {
  beforeEach(() => {
    localStorage.clear();
    useProvenanceAuditStore.setState({
      entries: [],
      settings: { retentionDays: 7, showSourceChips: true },
    });
  });

  it("redacts secret canaries and exports metadata only", () => {
    const source = toolResultProvenance({
      toolId: "web",
      name: "web_fetch",
      input: JSON.stringify({ url: "https://example.com/a?token=hidden" }),
    });
    useProvenanceAuditStore.getState().record({
      conversationId: "conv",
      toolId: "tool",
      action: "bash",
      target: "https://example.com?a=1&token=ghp_secretcanary123",
      decision: "prompted",
      effectivePolicy: "default + evidence boundary",
      sourceChain: auditSourceChain([source]),
    });

    const exported = useProvenanceAuditStore.getState().exportJson();
    expect(exported).toContain("[REDACTED]");
    expect(exported).not.toContain("ghp_secretcanary123");
    expect(exported).not.toContain("hidden");
  });

  it("bounds history and safely migrates absent or invalid settings", () => {
    for (let index = 0; index < 205; index += 1) {
      useProvenanceAuditStore.getState().record({
        conversationId: "conv",
        toolId: `tool-${index}`,
        action: "Read",
        decision: "auto_allowed",
        effectivePolicy: "default",
        sourceChain: [],
      });
    }
    expect(useProvenanceAuditStore.getState().entries).toHaveLength(200);
    expect(useProvenanceAuditStore.getState().entries[0].toolId).toBe("tool-5");

    expect(normalizeProvenanceAuditSnapshot({}).settings).toEqual({
      retentionDays: 7,
      showSourceChips: true,
    });
    expect(
      normalizeProvenanceAuditSnapshot({
        settings: { retentionDays: 30, showSourceChips: false },
      }).settings,
    ).toEqual({
      retentionDays: 30,
      showSourceChips: false,
    });
  });
});
