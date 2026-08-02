import { describe, expect, it } from "vitest";
import {
  isSupportedCustomShell,
  normalizeTerminalShellSelection,
  parseTerminalShellArgs,
  resolveTerminalShellLaunch,
} from "@/lib/terminalShells";

describe("terminal shell profiles", () => {
  it("keeps Auto byte-compatible with the prior platform command", () => {
    expect(resolveTerminalShellLaunch(undefined, "powershell")).toEqual({
      command: "powershell",
      args: [],
      label: "Windows PowerShell (Auto)",
    });
    expect(resolveTerminalShellLaunch({ profile: "auto" }, "bash")).toEqual({
      command: "bash",
      args: [],
      label: "Bash (Auto)",
    });
  });

  it("resolves Windows, Git Bash, and WSL profiles without shell interpolation", () => {
    expect(resolveTerminalShellLaunch({ profile: "powershell7" }, "powershell")).toMatchObject({
      command: "pwsh",
      args: [],
    });
    expect(
      resolveTerminalShellLaunch(
        { profile: "git-bash", executable: "C:\\Program Files\\Git\\bin\\bash.exe" },
        "powershell",
      ),
    ).toMatchObject({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
    });
    expect(
      resolveTerminalShellLaunch({ profile: "wsl", wslDistro: "Ubuntu-24.04" }, "powershell"),
    ).toMatchObject({ command: "wsl", args: ["--distribution", "Ubuntu-24.04"] });
  });

  it("accepts only known shell programs for a custom executable", () => {
    expect(isSupportedCustomShell("C:\\Tools\\pwsh.exe")).toBe(true);
    expect(isSupportedCustomShell("/opt/homebrew/bin/fish")).toBe(true);
    expect(isSupportedCustomShell("C:\\Windows\\System32\\calc.exe")).toBe(false);
    expect(
      resolveTerminalShellLaunch(
        { profile: "custom", executable: "C:\\Windows\\System32\\calc.exe" },
        "powershell",
      ),
    ).toMatchObject({ command: "powershell", label: "Windows PowerShell (Auto)" });
  });

  it("normalizes corrupted persistence and parses quoted startup args", () => {
    expect(normalizeTerminalShellSelection({ profile: "unknown" })).toEqual({ profile: "auto" });
    expect(parseTerminalShellArgs('--login --rcfile "C:/shell files/rc"')).toEqual([
      "--login",
      "--rcfile",
      "C:/shell files/rc",
    ]);
    expect(parseTerminalShellArgs("--rcfile C:\\Users\\Ian\\shell.rc")).toEqual([
      "--rcfile",
      "C:\\Users\\Ian\\shell.rc",
    ]);
  });
});
