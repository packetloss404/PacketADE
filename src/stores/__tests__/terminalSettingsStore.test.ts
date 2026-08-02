import { beforeEach, describe, expect, it } from "vitest";
import { storageKey } from "@/lib/brand";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";

describe("terminalSettingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useTerminalSettingsStore.setState({ defaultShell: { profile: "auto" } });
  });

  it("defaults to Auto and persists an explicit profile", () => {
    expect(useTerminalSettingsStore.getState().defaultShell).toEqual({ profile: "auto" });

    useTerminalSettingsStore.getState().setDefaultShell({
      profile: "wsl",
      executable: "wsl.exe",
      wslDistro: "Ubuntu",
    });

    expect(useTerminalSettingsStore.getState().defaultShell).toMatchObject({
      profile: "wsl",
      wslDistro: "Ubuntu",
    });
    expect(
      JSON.parse(localStorage.getItem(storageKey("terminal-default-shell")) ?? "{}"),
    ).toMatchObject({ profile: "wsl", wslDistro: "Ubuntu" });
  });

  it("reset restores the zero-configuration Auto contract", () => {
    useTerminalSettingsStore.getState().setDefaultShell({ profile: "command-prompt" });
    useTerminalSettingsStore.getState().resetDefaultShell();
    expect(useTerminalSettingsStore.getState().defaultShell).toEqual({ profile: "auto" });
  });
});
