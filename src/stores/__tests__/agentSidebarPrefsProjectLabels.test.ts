import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

/**
 * Tile program (P4-S2): `projectLabels` moved from `agentTaskStore` to the
 * shared `agentSidebarPrefsStore` so both the FleetSidebar and the legacy
 * AgentSidebar rename project groups through ONE source of truth. Coverage
 * relocated verbatim from the old `agentTaskStoreProjectLabels.test.ts` —
 * legacy-key migration + branded-only writes are preserved.
 */
const PROJECT_LABELS_KEY = storageKey("project-labels");
// Immediately-prior product prefix (PacketADE); the store migrates it forward
// to the current branded prefix on hydrate.
const LEGACY_PROJECT_LABELS_KEY = "packetade:project-labels";

describe("agentSidebarPrefsStore project label storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
  });

  it("migrates legacy project labels to the branded storage key", async () => {
    localStorage.setItem(
      LEGACY_PROJECT_LABELS_KEY,
      JSON.stringify({ "D:/projects/old": "Legacy Label" }),
    );

    const { useAgentSidebarPrefsStore } = await import(
      "@/stores/agentSidebarPrefsStore"
    );

    expect(useAgentSidebarPrefsStore.getState().projectLabels).toEqual({
      "D:/projects/old": "Legacy Label",
    });
    expect(JSON.parse(localStorage.getItem(PROJECT_LABELS_KEY)!)).toEqual({
      "D:/projects/old": "Legacy Label",
    });
  });

  it("writes project labels only to the branded storage key", async () => {
    const { useAgentSidebarPrefsStore } = await import(
      "@/stores/agentSidebarPrefsStore"
    );

    useAgentSidebarPrefsStore
      .getState()
      .setProjectLabel("D:/projects/packetbench", "PacketBench");

    expect(JSON.parse(localStorage.getItem(PROJECT_LABELS_KEY)!)).toEqual({
      "D:/projects/packetbench": "PacketBench",
    });
    expect(localStorage.getItem(LEGACY_PROJECT_LABELS_KEY)).toBeNull();
  });

  it("clears a label when set to blank", async () => {
    const { useAgentSidebarPrefsStore } = await import(
      "@/stores/agentSidebarPrefsStore"
    );
    const store = useAgentSidebarPrefsStore.getState();
    store.setProjectLabel("D:/projects/packetbench", "PacketBench");
    store.setProjectLabel("D:/projects/packetbench", "   ");
    expect(useAgentSidebarPrefsStore.getState().projectLabels).toEqual({});
  });
});
