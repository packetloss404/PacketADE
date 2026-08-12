import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

async function loadStore() {
  vi.resetModules();
  return import("@/stores/syndicateStore");
}

describe("syndicateStore integration setting", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
  });

  it("defaults to enabled for existing installations", async () => {
    const { useSyndicateStore } = await loadStore();
    expect(useSyndicateStore.getState().enabled).toBe(true);
  });

  it("persists disabled and closes PacketADE-managed tunnels", async () => {
    const { useSyndicateStore } = await loadStore();

    await useSyndicateStore.getState().setEnabled(false);

    expect(useSyndicateStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(storageKey("syndicate-integration-enabled-v1"))).toBe("false");
    expect(invoke).toHaveBeenCalledWith("syndicate_disable_integration");

    const { useSyndicateStore: reloaded } = await loadStore();
    expect(reloaded.getState().enabled).toBe(false);
  });

  it("rolls the preference back when native tunnel shutdown fails", async () => {
    invoke.mockRejectedValueOnce(new Error("tunnel registry unavailable"));
    const { useSyndicateStore } = await loadStore();

    await expect(useSyndicateStore.getState().setEnabled(false)).rejects.toThrow(
      "tunnel registry unavailable",
    );

    expect(useSyndicateStore.getState().enabled).toBe(true);
    expect(localStorage.getItem(storageKey("syndicate-integration-enabled-v1"))).toBe("true");
  });

  it("blocks controller operations without discarding paired machines", async () => {
    localStorage.setItem(storageKey("syndicate-integration-enabled-v1"), "false");
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
        {
          machineId: "machine-1",
          displayName: "Build host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["machine.read"],
          addedAt: 1,
        },
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    expect(useSyndicateStore.getState().machines).toHaveLength(1);
    await expect(useSyndicateStore.getState().refresh("machine-1")).rejects.toThrow(
      "disabled in Settings",
    );
    expect(invoke).not.toHaveBeenCalledWith("syndicate_machine_snapshot", expect.anything());
    expect(useSyndicateStore.getState().machines).toHaveLength(1);
  });
});
