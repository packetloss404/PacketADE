import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("Syndicate integration preference", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    vi.resetModules();
  });

  it("defaults safely to enabled when persisted data is absent or malformed", async () => {
    let integration = await import("@/lib/syndicateIntegration");
    expect(integration.loadSyndicateIntegrationEnabled()).toBe(true);

    localStorage.setItem(storageKey("syndicate-integration-enabled-v1"), "not-json");
    vi.resetModules();
    integration = await import("@/lib/syndicateIntegration");
    expect(integration.loadSyndicateIntegrationEnabled()).toBe(true);
  });

  it("blocks direct controller wrappers while disabled", async () => {
    const integration = await import("@/lib/syndicateIntegration");
    integration.persistSyndicateIntegrationEnabled(false);
    const { syndicateMachineSnapshot } = await import("@/lib/tauri");

    await expect(
      syndicateMachineSnapshot({
        machineId: "machine-1",
        deviceId: "device-1",
        serverConfigId: "server-1",
        localPort: 4317,
      }),
    ).rejects.toThrow("Syndicate integration is disabled in Settings");
    expect(invoke).not.toHaveBeenCalled();
  });
});
