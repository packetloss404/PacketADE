import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();
  return import("../remoteAgentsSettingsStore");
}

describe("remoteAgentsSettingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults the unfinished feature off", async () => {
    const { useRemoteAgentsSettingsStore } = await loadStore();
    expect(useRemoteAgentsSettingsStore.getState().requested).toEqual({ enabled: false });
  });

  // The persisted JSON keeps its original `{ remoteAgents: { enabled } }` shape.
  // Only the in-memory field was renamed to `requested`, so no migration is
  // needed and an install written before the rename still loads.
  it("persists the remoteAgents.enabled contract", async () => {
    const { REMOTE_AGENTS_SETTINGS_KEY, useRemoteAgentsSettingsStore } = await loadStore();
    useRemoteAgentsSettingsStore.getState().setRequestedEnabled(true);

    expect(JSON.parse(localStorage.getItem(REMOTE_AGENTS_SETTINGS_KEY) ?? "{}")).toEqual({
      remoteAgents: { enabled: true },
    });
  });

  it("ignores malformed persisted values", async () => {
    const first = await loadStore();
    localStorage.setItem(
      first.REMOTE_AGENTS_SETTINGS_KEY,
      JSON.stringify({ remoteAgents: { enabled: 1 } }),
    );

    const reloaded = await loadStore();
    expect(reloaded.useRemoteAgentsSettingsStore.getState().requested.enabled).toBe(false);
  });
});
