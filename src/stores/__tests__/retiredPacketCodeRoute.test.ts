import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { normalizeView, useAppStore, type AppView } from "@/stores/appStore";
import { ROUTE_REGISTRY } from "@/lib/routeRegistry";

const RETIRED = "packetcode" as AppView;

describe("the retired PacketCode route", () => {
  it("is gone from the registry", () => {
    // It was a second Agents pane: the same AgentsView wrapped in the engine
    // gate and pinned to the ACP provider. PacketCode is now a provider you
    // select inside Agents.
    expect(Object.keys(ROUTE_REGISTRY)).not.toContain("packetcode");
  });

  it("normalizes to Agents rather than stranding the user", () => {
    // A persisted view, a saved hotkey or a stale palette entry can still say
    // `packetcode`. Landing on a dead route would render an empty shell.
    expect(normalizeView(RETIRED)).toBe("agents");
  });

  it("routes a setActiveView call through the same redirect", () => {
    useAppStore.getState().setActiveView(RETIRED);
    expect(useAppStore.getState().activeView).toBe("agents");
  });

  it("leaves every live route untouched", () => {
    for (const id of Object.keys(ROUTE_REGISTRY)) {
      expect(normalizeView(id as AppView)).toBe(id);
    }
  });
});
