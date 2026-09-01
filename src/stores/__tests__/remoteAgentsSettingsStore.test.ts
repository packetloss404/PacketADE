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
    expect(useRemoteAgentsSettingsStore.getState().remoteAgents).toEqual({ enabled: false });
  });

  it("persists the remoteAgents.enabled contract", async () => {
    const { REMOTE_AGENTS_SETTINGS_KEY, useRemoteAgentsSettingsStore } = await loadStore();
    useRemoteAgentsSettingsStore.getState().setEnabled(true);

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
    expect(reloaded.useRemoteAgentsSettingsStore.getState().remoteAgents.enabled).toBe(false);
  });
});
