import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeTerminalShell = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  probeTerminalShell,
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useTerminalShellDetection", () => ({
  useTerminalShellDetection: () => ({
    shells: {
      auto: { profile: "auto", available: true, path: null, version: null },
      powershell7: { profile: "powershell7", available: true, path: "pwsh.exe", version: "7" },
      "windows-powershell": {
        profile: "windows-powershell",
        available: true,
        path: "powershell",
        version: null,
      },
      "command-prompt": {
        profile: "command-prompt",
        available: true,
        path: "cmd",
        version: null,
      },
      "git-bash": {
        profile: "git-bash",
        available: true,
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        version: "5.2",
      },
      wsl: { profile: "wsl", available: true, path: "wsl.exe", version: "2" },
    },
    wslDistributions: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { TerminalShellSettingsCard } from "@/components/views/tools/TerminalShellSettingsCard";
import { CUSTOM_SHELL_PROGRAMS, isSupportedCustomShell } from "@/lib/terminalShells";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { Workspace } from "@/types/workspace";

const workspace: Workspace = {
  id: "ws-1",
  name: "Demo",
  agents: [],
  panes: [],
  projectPath: "/repo",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
};

describe("TerminalShellSettingsCard", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useTerminalSettingsStore.setState({ defaultShell: { profile: "auto" } });
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "ws-1" });
    probeTerminalShell.mockResolvedValue({
      available: true,
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      version: "5.1.26100.4652",
      workingDirectory: "/repo",
      platform: "linux",
    });
  });

  it("starts at Auto and lets the active workspace inherit it", () => {
    render(<TerminalShellSettingsCard />);

    const selects = screen.getAllByRole("combobox");
    expect(selects[0]).toHaveValue("auto");
    expect(selects[1]).toHaveValue("inherit");
    expect(screen.getByText(/Auto preserves the existing behavior/)).toBeInTheDocument();
  });

  it("saves an app default and a separate workspace override", () => {
    render(<TerminalShellSettingsCard />);
    const selects = screen.getAllByRole("combobox");

    fireEvent.change(selects[0], { target: { value: "command-prompt" } });
    expect(useTerminalSettingsStore.getState().defaultShell).toEqual({
      profile: "command-prompt",
      executable: "cmd",
    });

    fireEvent.change(selects[1], { target: { value: "auto" } });
    expect(useWorkspaceStore.getState().workspaces[0].terminalShell).toEqual({ profile: "auto" });
  });

  it("tests the selected shell and reports its executable, version, and cwd", async () => {
    render(<TerminalShellSettingsCard />);

    fireEvent.click(screen.getAllByRole("button", { name: "Test shell" })[0]);

    await waitFor(() => expect(probeTerminalShell).toHaveBeenCalledWith("powershell", "/repo"));
    expect(screen.getByText(/5\.1\.26100/)).toHaveTextContent("powershell.exe");
    expect(screen.getByText(/5\.1\.26100/)).toHaveTextContent("cwd /repo");
  });

  /**
   * FAULT: the edit-time warning listed the accepted programs by hand and had
   * drifted from `CUSTOM_SHELL_PROGRAMS` — it omitted `sh` and `wsl`, so the
   * card told the user two programs were unsupported that the spawn path
   * accepts. `resolveTerminalShellLaunch`'s fallback message already renders
   * the real list; both now read from the same constant.
   */
  it("names exactly the programs the spawn path accepts", () => {
    useTerminalSettingsStore.setState({
      defaultShell: { profile: "custom", executable: "C:\\Tools\\nope.exe" },
    });
    render(<TerminalShellSettingsCard />);

    const warning = screen.getByText(/Choose a supported shell executable/);
    for (const program of CUSTOM_SHELL_PROGRAMS) {
      expect(warning).toHaveTextContent(program);
    }
    expect(warning).toHaveTextContent("Auto remains the effective launch");
  });

  it("accepts a program the old hand-written list wrongly rejected", () => {
    // `sh` and `wsl` are in CUSTOM_SHELL_PROGRAMS but were missing from the
    // warning's copy — proof the two sources are joined, not merely similar.
    expect(isSupportedCustomShell("/bin/sh")).toBe(true);
    expect(isSupportedCustomShell("C:\\Windows\\System32\\wsl.exe")).toBe(true);

    useTerminalSettingsStore.setState({
      defaultShell: { profile: "custom", executable: "/bin/sh" },
    });
    render(<TerminalShellSettingsCard />);
    expect(screen.queryByText(/Choose a supported shell executable/)).not.toBeInTheDocument();
  });
});
