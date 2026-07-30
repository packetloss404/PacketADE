/** WA1 view ownership: Agents is a first-class same-window route. */
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeView, useAppStore, type AppView } from "@/stores/appStore";

beforeEach(() => {
  useAppStore.setState({ activeView: "welcome", settingsTarget: null });
});

describe("appStore view normalization", () => {
  it("preserves a persisted Agents view", () => {
    expect(normalizeView("agents")).toBe("agents");
  });

  it("passes valid views through untouched", () => {
    expect(normalizeView("memory")).toBe("memory");
    expect(normalizeView("workspace")).toBe("workspace");
    expect(normalizeView("mod:git" as AppView)).toBe("mod:git");
  });

  it("setActiveView opens Agents directly", () => {
    useAppStore.getState().setActiveView("agents");
    expect(useAppStore.getState().activeView).toBe("agents");
  });

  it("setActiveView still honors real view changes", () => {
    useAppStore.getState().setActiveView("flights");
    expect(useAppStore.getState().activeView).toBe("flights");
  });

  it("opens a typed Settings recovery target", () => {
    useAppStore.getState().openSettings({
      section: "agents",
      cliId: "packetcode",
    });

    expect(useAppStore.getState()).toMatchObject({
      activeView: "tools",
      settingsTarget: { section: "agents", cliId: "packetcode" },
    });

    useAppStore.getState().clearSettingsTarget();
    expect(useAppStore.getState().settingsTarget).toBeNull();
  });
});
