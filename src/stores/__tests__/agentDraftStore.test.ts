import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAgentDraftStore } from "../agentDraftStore";

const STORAGE_KEY = "packetade:agent-drafts";

const store = () => useAgentDraftStore.getState();

describe("agentDraftStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentDraftStore.setState({ drafts: {} });
  });

  it("keeps drafts per conversation — no bleed across ids", () => {
    store().setDraft("conv_a", "half-typed message for A");
    store().setDraft("conv_b", "different draft for B");

    expect(store().drafts.conv_a).toBe("half-typed message for A");
    expect(store().drafts.conv_b).toBe("different draft for B");

    // Updating one conversation's draft never touches the other.
    store().setDraft("conv_a", "edited A");
    expect(store().drafts.conv_a).toBe("edited A");
    expect(store().drafts.conv_b).toBe("different draft for B");
  });

  it("returns no draft for a conversation that never typed", () => {
    store().setDraft("conv_a", "text");
    expect(store().drafts.conv_other).toBeUndefined();
  });

  it("removes the entry when the draft empties (send clears it)", () => {
    store().setDraft("conv_a", "about to send");
    store().setDraft("conv_a", "");
    expect("conv_a" in store().drafts).toBe(false);
  });

  it("clearDraft drops the entry and its persisted copy", () => {
    store().setDraft("conv_a", "doomed");
    store().clearDraft("conv_a");
    expect("conv_a" in store().drafts).toBe(false);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect("conv_a" in persisted).toBe(false);
  });

  it("persists drafts to localStorage keyed by conversation id", () => {
    store().setDraft("conv_a", "survives a restart");
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted.conv_a).toBe("survives a restart");
  });

  it("ignores non-string / empty persisted entries on load", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ good: "keep me", bad: 42, empty: "" }),
    );
    // Re-import a fresh module instance so the store re-runs load().
    vi.resetModules();
    const { useAgentDraftStore: fresh } = await import("../agentDraftStore");
    expect(fresh.getState().drafts).toEqual({ good: "keep me" });
  });
});
