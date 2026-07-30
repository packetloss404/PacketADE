import { beforeEach, describe, expect, it } from "vitest";
import { storageKey } from "@/lib/brand";
import {
  markWorkspaceAgentsAttentionStarted,
  recordCompatibilityPaneLoaded,
  recordConversationOpenedInAgents,
  recordWorkspaceAgentsEvent,
  serializeWorkspaceAgentsDogfoodEvidence,
  useWorkspaceAgentsDogfoodStore,
} from "@/stores/workspaceAgentsDogfoodStore";

const STORAGE_KEY = storageKey("workspace-agents-dogfood-v1");

describe("Workspace/Agents content-free dogfood evidence", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceAgentsDogfoodStore.getState().reset();
  });

  it("records only enumerated counters and aggregate measurements", () => {
    recordWorkspaceAgentsEvent("workspace_delegated_agents");
    recordWorkspaceAgentsEvent("workspace_delegated_agents");
    useWorkspaceAgentsDogfoodStore.getState().recordVisibleConversations(3);
    useWorkspaceAgentsDogfoodStore.getState().recordDisplayTopology(2);
    useWorkspaceAgentsDogfoodStore.getState().recordMigrationAudit({
      conversationPanes: 4,
      missingConversationReferences: 1,
      orphanConversationWrappers: 1,
    });

    expect(useWorkspaceAgentsDogfoodStore.getState().evidence).toMatchObject({
      counters: { workspace_delegated_agents: 2 },
      visibility: { maxSimultaneousConversations: 3 },
      displayTopology: {
        samples: 1,
        multiDisplaySamples: 1,
        maxDisplayCount: 2,
      },
      migration: {
        audits: 1,
        conversationPanes: 4,
        missingConversationReferences: 1,
        orphanConversationWrappers: 1,
      },
    });
  });

  it("aggregates attention response time without persisting conversation IDs", () => {
    markWorkspaceAgentsAttentionStarted("sensitive-conversation-id", 1_000);
    recordConversationOpenedInAgents("sensitive-conversation-id", 4_500);

    const evidence = useWorkspaceAgentsDogfoodStore.getState().evidence;
    expect(evidence.attention).toEqual({
      samples: 1,
      totalResponseMs: 3_500,
      maxResponseMs: 3_500,
    });
    expect(evidence.counters.conversation_opened_agents).toBe(1);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(
      "sensitive-conversation-id",
    );
  });

  it("deduplicates compatibility-pane observations in memory and persists no pane ID", () => {
    recordCompatibilityPaneLoaded("private-pane-id", true);
    recordCompatibilityPaneLoaded("private-pane-id", true);
    recordCompatibilityPaneLoaded("missing-pane-id", false);

    const evidence = useWorkspaceAgentsDogfoodStore.getState().evidence;
    expect(evidence.counters.compatibility_pane_loaded).toBe(1);
    expect(evidence.counters.compatibility_pane_load_failed).toBe(1);
    const serialized = serializeWorkspaceAgentsDogfoodEvidence();
    expect(serialized).not.toContain("private-pane-id");
    expect(serialized).not.toContain("missing-pane-id");
  });

  it("reset removes every accumulated decision signal", () => {
    recordWorkspaceAgentsEvent("agent_packetcode_handoff");
    useWorkspaceAgentsDogfoodStore.getState().recordVisibleConversations(2);

    useWorkspaceAgentsDogfoodStore.getState().reset();

    expect(
      useWorkspaceAgentsDogfoodStore.getState().evidence.counters
        .agent_packetcode_handoff,
    ).toBe(0);
    expect(
      useWorkspaceAgentsDogfoodStore.getState().evidence.visibility
        .maxSimultaneousConversations,
    ).toBe(0);
  });
});
