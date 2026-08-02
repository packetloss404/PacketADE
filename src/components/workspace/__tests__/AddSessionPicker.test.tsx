import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddSessionPicker } from "@/components/workspace/AddSessionPicker";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";
import type { Workspace } from "@/types/workspace";

const addPane = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const terminalSettingsState = vi.hoisted(() => ({ defaultShell: { profile: "auto" as const } }));
const agentState = vi.hoisted(() => ({
  agents: [
    { id: "claude-code", installed: true },
    { id: "codex", installed: true },
    { id: "opencode", installed: false },
    { id: "packetcode", installed: true },
  ],
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { addPane: typeof addPane }) => unknown) =>
    selector({ addPane }),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (state: { openSettings: typeof openSettings }) => unknown) =>
    selector({ openSettings }),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: (selector: (state: typeof agentState) => unknown) => selector(agentState),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: (selector: (state: { servers: unknown[] }) => unknown) =>
    selector({ servers: [] }),
}));

vi.mock("@/stores/terminalSettingsStore", () => ({
  useTerminalSettingsStore: (selector: (state: typeof terminalSettingsState) => unknown) =>
    selector(terminalSettingsState),
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
        version: "5",
      },
      wsl: { profile: "wsl", available: true, path: "wsl.exe", version: "2" },
      bash: { profile: "bash", available: true, path: "/bin/bash", version: "5" },
      zsh: { profile: "zsh", available: false, path: null, version: null },
    },
    wslDistributions: ["Ubuntu"],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const localWorkspace: Workspace = {
  id: "ws-local",
  name: "Local",
  agents: [],
  panes: [],
  projectPath: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
};

/**
 * Multi-account CLI support: the real `cliAccountStore` is used with
 * `setState` (which bypasses its backend sync), so these tests exercise the
 * same resolution path the app does.
 */
function account(id: string, label: string, cli: CliAccount["cli"]): CliAccount {
  return { id, label, cli, configDir: `C:\\cfg\\${id}`, createdAt: 1 };
}

describe("AddSessionPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCliAccountStore.setState({ accounts: [], stickyDefaults: {} });
    agentState.agents = [
      { id: "claude-code", installed: true },
      { id: "codex", installed: true },
      { id: "opencode", installed: false },
      { id: "packetcode", installed: true },
    ];
  });

  function openPopover() {
    render(<AddSessionPicker workspace={localWorkspace} variant="popover" />);
    fireEvent.click(screen.getByRole("button", { name: /add session/i }));
  }

  it("offers CLI sessions only and recommends detected PacketCode first", () => {
    openPopover();

    expect(screen.queryByText("Chat agents")).toBeNull();
    expect(screen.queryByText("Claude API")).toBeNull();
    expect(screen.getByText("CLI sessions")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();

    const buttons = screen.getAllByRole("button");
    const packetCodeIndex = buttons.findIndex((button) =>
      button.textContent?.includes("PacketCode"),
    );
    const claudeIndex = buttons.findIndex((button) => button.textContent?.includes("Claude Code"));
    expect(packetCodeIndex).toBeGreaterThanOrEqual(0);
    expect(packetCodeIndex).toBeLessThan(claudeIndex);
  });

  it("adds a detected PacketCode PTY pane directly", () => {
    openPopover();

    fireEvent.click(screen.getByRole("button", { name: /PacketCode/ }));

    // Multi-account: an untouched row passes NO account option at all, so
    // `addPane` resolves the sticky per-project default itself.
    expect(addPane).toHaveBeenCalledWith("ws-local", "packetcode", undefined);
  });

  it("keeps the Terminal row on the inherited Auto path until a shell is chosen", () => {
    openPopover();

    expect(screen.getByRole("combobox", { name: "Shell for new Terminal session" })).toHaveValue(
      "inherit",
    );
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    expect(addPane).toHaveBeenCalledWith("ws-local", "terminal", undefined);
  });

  it("stores a one-session shell override on the new Terminal pane", () => {
    openPopover();

    fireEvent.change(screen.getByRole("combobox", { name: "Shell for new Terminal session" }), {
      target: { value: "command-prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    expect(addPane).toHaveBeenCalledWith("ws-local", "terminal", {
      terminalShell: {
        profile: "command-prompt",
        executable: "cmd",
      },
    });
  });

  it("routes missing PacketCode to its Settings recovery panel", () => {
    agentState.agents = agentState.agents.map((agent) =>
      agent.id === "packetcode" ? { ...agent, installed: false } : agent,
    );
    openPopover();

    fireEvent.click(screen.getAllByRole("button", { name: /set up/i })[0]);

    expect(openSettings).toHaveBeenCalledWith({
      section: "cli-clients",
      cliId: "packetcode",
    });
    expect(addPane).not.toHaveBeenCalled();
  });

  it("searches CLI sessions without surfacing API providers", () => {
    openPopover();

    fireEvent.change(screen.getByPlaceholderText("Search CLI sessions…"), {
      target: { value: "cla" },
    });

    expect(screen.getByRole("button", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.queryByText("PacketCode")).toBeNull();
    expect(screen.queryByText("Claude API")).toBeNull();
  });

  describe("account affordance", () => {
    it("shows no account chip when the user has registered no accounts", () => {
      openPopover();

      expect(screen.queryByText("Default login")).toBeNull();
      // The one-click path is untouched on a zero-config install.
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", undefined);
    });

    it("shows the resolved sticky default on the claude-code and codex rows only", () => {
      useCliAccountStore.setState({
        accounts: [
          account("acct-personal", "Personal", "claude-code"),
          account("acct-client", "Client work", "claude-code"),
          account("acct-codex", "Codex login", "codex"),
        ],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();

      // claude-code resolves the sticky default; codex has an account but no
      // sticky entry, so it shows the ambient caption.
      expect(screen.getByText("Client work")).toBeInTheDocument();
      expect(screen.getByText("Default login")).toBeInTheDocument();
      // terminal / opencode / packetcode are unaffected — one chip per
      // account-aware row and no more.
      expect(screen.getAllByTitle(/click to switch before adding/i)).toHaveLength(2);
    });

    it("keeps the one-click fast path: clicking the row adds with the resolved default", () => {
      useCliAccountStore.setState({
        accounts: [account("acct-client", "Client work", "claude-code")],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

      // No explicit option: `addPane` re-resolves the very default the chip
      // displayed, so the common case stays a single click.
      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", undefined);
    });

    it("lets the user switch account before adding, and passes it as an explicit choice", () => {
      useCliAccountStore.setState({
        accounts: [
          account("acct-personal", "Personal", "claude-code"),
          account("acct-client", "Client work", "claude-code"),
        ],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();

      // Opening the chip must NOT add a pane.
      fireEvent.click(screen.getAllByTitle(/click to switch before adding/i)[0]);
      expect(addPane).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("option", { name: /Personal/ }));
      expect(addPane).not.toHaveBeenCalled();
      expect(screen.getByText("Personal")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", {
        accountId: "acct-personal",
      });
    });

    it("switching to the ambient login travels as an explicit null", () => {
      useCliAccountStore.setState({
        accounts: [account("acct-client", "Client work", "claude-code")],
        stickyDefaults: { "/tmp/project": { "claude-code": "acct-client" } },
      });

      openPopover();
      fireEvent.click(screen.getAllByTitle(/click to switch before adding/i)[0]);
      fireEvent.click(screen.getByRole("option", { name: /Default login/ }));
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

      expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code", {
        accountId: null,
      });
    });
  });
});
