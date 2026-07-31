/** WA1 view ownership: Agents is a first-class same-window route. */
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeView, resolveStartupView, useAppStore, type AppView } from "@/stores/appStore";

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

describe("resolveStartupView", () => {
  const allEnabled = () => true;
  const noneEnabled = () => false;

  it("restores a persisted core view", () => {
    expect(resolveStartupView("flights", allEnabled)).toBe("flights");
    expect(resolveStartupView("agents", allEnabled)).toBe("agents");
    expect(resolveStartupView("tools", allEnabled)).toBe("tools");
  });

  it("lands on Welcome on a first run with nothing persisted", () => {
    expect(resolveStartupView(null, allEnabled)).toBe("welcome");
    expect(resolveStartupView(undefined, allEnabled)).toBe("welcome");
    expect(resolveStartupView("", allEnabled)).toBe("welcome");
    expect(resolveStartupView("   ", allEnabled)).toBe("welcome");
  });

  it("falls back to Welcome for a view the route registry no longer knows", () => {
    // "dashboard" is a real retired route id still present in old state files.
    expect(resolveStartupView("dashboard", allEnabled)).toBe("welcome");
    expect(resolveStartupView("orchestrator", allEnabled)).toBe("welcome");
    expect(resolveStartupView("{}", allEnabled)).toBe("welcome");
  });

  it("collapses a module alias to its canonical route", () => {
    expect(resolveStartupView("mod:dictation", allEnabled)).toBe("dictation");
  });

  it("falls back to Welcome when the backing module is disabled", () => {
    const dictationOff = (id: string) => id !== "dictation";
    expect(resolveStartupView("dictation", dictationOff)).toBe("welcome");
    expect(resolveStartupView("mod:dictation", dictationOff)).toBe("welcome");
    // Non-module routes are unaffected by module state.
    expect(resolveStartupView("flights", noneEnabled)).toBe("flights");
  });

  it("restores a plain module view only while that module is enabled", () => {
    expect(resolveStartupView("mod:quality", allEnabled)).toBe("mod:quality");
    expect(resolveStartupView("mod:quality", noneEnabled)).toBe("welcome");
    // A module that has since been removed from the registry answers false.
    expect(resolveStartupView("mod:retired", (id) => id === "quality")).toBe("welcome");
  });
});
