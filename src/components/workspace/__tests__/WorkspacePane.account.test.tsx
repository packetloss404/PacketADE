/**
 * Multi-account RUNTIME + VISIBILITY tests for WorkspacePane:
 *   - the account env reaches BOTH spawn paths (local `env=` and SSH args)
 *   - an unready account BLOCKS the launch and never falls back to ambient
 *   - ambient panes are bit-for-bit unchanged: no probe, no chip, no gate
 *   - the header chip renders with a stable, account-derived color
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import type { Workspace, WorkspacePane as WorkspacePaneType } from "@/types/workspace";
import type { ServerConfig } from "@/types/server";

// ── Tauri seams ────────────────────────────────────────────────────────────
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const getProviderAuthStatusForDir = vi.fn();
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    writePty: vi.fn(),
    getProviderAuthStatusForDir: (...args: unknown[]) =>
      getProviderAuthStatusForDir(...args),
  };
});

// ── TerminalPane stand-in that records the props it was spawned with ───────
interface CapturedTerminalPaneProps {
  cliCommand: string;
  cliArgs?: string[];
  env?: Record<string, string>;
  autoStart?: boolean;
  renderHeader?: (state: TerminalHeaderRenderState) => React.ReactNode;
}
let terminalPaneProps: CapturedTerminalPaneProps | null = null;

vi.mock("@/components/session/TerminalPane", () => ({
  TerminalPane: (props: CapturedTerminalPaneProps) => {
    terminalPaneProps = props;
    return (
      <div data-testid="terminal-pane">
        {props.renderHeader
          ? props.renderHeader({
              alive: true,
              error: null,
              showApproval: false,
              cliCommand: props.cliCommand,
              lastExit: null,
              onRestart: vi.fn(),
              onKill: vi.fn(),
            })
          : null}
      </div>
    );
  },
}));

import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import { CLAUDE_CODE_CONFIG } from "@/agents/claude-code";
import { getAccountColor } from "@/lib/accountColors";

const CLIENT_ACCOUNT = {
  id: "acct-client",
  label: "Client work",
  cli: "claude-code" as const,
  configDir: "/srv/accts/client",
  createdAt: 1,
};

const SERVER: ServerConfig = {
  id: "srv-1",
  name: "box",
  host: "example.test",
  port: 22,
  username: "ian",
  authMethod: "agent",
  installedAgents: [],
  hostFingerprint: "SHA256:abc",
};

function makeWorkspace(panes: WorkspacePaneType[], extra: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: "ws-1",
    name: "Accounts",
    agents: ["claude-code"],
    panes,
    projectPath: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...extra,
  };
}

function mount(pane: WorkspacePaneType) {
  return render(<WorkspacePane pane={pane} workspaceId="ws-1" />);
}

describe("WorkspacePane — multi-account runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalPaneProps = null;
    getProviderAuthStatusForDir.mockResolvedValue({ status: "ready", hint: "" });
    useAgentStore.setState({ agents: [{ ...CLAUDE_CODE_CONFIG, installed: true }], detecting: false });
    useServerStore.setState({ servers: [SERVER], knownHostsPath: "/known_hosts" });
    useCliAccountStore.setState({ accounts: [CLIENT_ACCOUNT] });
  });

  // ── Ambient panes: today's behaviour, untouched ──────────────────────────
  describe("ambient panes (no accountId)", () => {
    const ambientPane: WorkspacePaneType = {
      id: "pane-a",
      agentId: "claude-code",
      sessionId: null,
    };

    beforeEach(() => {
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace([ambientPane])],
        activeWorkspaceId: "ws-1",
        zoomedPaneId: null,
      });
    });

    it("never probes the auth status", async () => {
      mount(ambientPane);
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());
      expect(getProviderAuthStatusForDir).not.toHaveBeenCalled();
    });

    it("mounts the terminal immediately — no gate, no blocking body", () => {
      mount(ambientPane);
      expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
      expect(screen.queryByTestId("account-gate-blocked")).not.toBeInTheDocument();
      expect(screen.queryByTestId("account-gate-probing")).not.toBeInTheDocument();
    });

    it("renders no account chip", () => {
      mount(ambientPane);
      expect(screen.queryByTestId("account-chip")).not.toBeInTheDocument();
    });

    it("passes no env (undefined), exactly as before", () => {
      mount(ambientPane);
      expect(terminalPaneProps?.env).toBeUndefined();
    });
  });

  // ── ENV INJECTION ───────────────────────────────────────────────────────
  describe("env injection", () => {
    const boundPane: WorkspacePaneType = {
      id: "pane-b",
      agentId: "claude-code",
      sessionId: null,
      accountId: CLIENT_ACCOUNT.id,
    };

    it("reaches the LOCAL spawn path as TerminalPane's env prop", async () => {
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace([boundPane])],
        activeWorkspaceId: "ws-1",
        zoomedPaneId: null,
      });
      mount(boundPane);
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());
      expect(terminalPaneProps?.env).toEqual({
        CLAUDE_CONFIG_DIR: CLIENT_ACCOUNT.configDir,
      });
    });

    it("reaches the SSH spawn path inside the remote command's env prefix", async () => {
      useWorkspaceStore.setState({
        workspaces: [
          makeWorkspace([boundPane], { serverId: "srv-1", remoteProjectPath: "/home/ian/p" }),
        ],
        activeWorkspaceId: "ws-1",
        zoomedPaneId: null,
      });
      mount(boundPane);
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());

      expect(terminalPaneProps?.cliCommand).toBe("ssh");
      const sshArgs = terminalPaneProps?.cliArgs ?? [];
      const remoteCmd = sshArgs[sshArgs.length - 1] ?? "";
      expect(remoteCmd).toContain(`export CLAUDE_CONFIG_DIR='${CLIENT_ACCOUNT.configDir}';`);
      // Local `env=` stays undefined for SSH — the binding travels in the args.
      expect(terminalPaneProps?.env).toBeUndefined();
    });

    it("uses CODEX_HOME for the codex slot", async () => {
      const codexAccount = {
        id: "acct-codex",
        label: "Codex client",
        cli: "codex" as const,
        configDir: "/srv/accts/codex",
        createdAt: 1,
      };
      useCliAccountStore.setState({ accounts: [codexAccount] });
      const codexPane: WorkspacePaneType = {
        id: "pane-c",
        agentId: "codex",
        sessionId: null,
        accountId: codexAccount.id,
      };
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace([codexPane])],
        activeWorkspaceId: "ws-1",
        zoomedPaneId: null,
      });
      mount(codexPane);
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());
      expect(terminalPaneProps?.env).toEqual({ CODEX_HOME: codexAccount.configDir });
    });
  });

  // ── REFUSE TO LAUNCH ────────────────────────────────────────────────────
  describe("refuse-to-launch", () => {
    const boundPane: WorkspacePaneType = {
      id: "pane-b",
      agentId: "claude-code",
      sessionId: null,
      accountId: CLIENT_ACCOUNT.id,
    };

    beforeEach(() => {
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace([boundPane])],
        activeWorkspaceId: "ws-1",
        zoomedPaneId: null,
      });
    });

    it("blocks and names the account when the probe says login_required", async () => {
      getProviderAuthStatusForDir.mockResolvedValue({
        status: "login_required",
        hint: "Run claude login",
      });
      mount(boundPane);

      await waitFor(() => expect(screen.getByTestId("account-gate-blocked")).toBeInTheDocument());
      expect(screen.getByText(/Not signed in to/)).toBeInTheDocument();
      expect(screen.getAllByText(CLIENT_ACCOUNT.label).length).toBeGreaterThan(0);
      expect(screen.getByText(`Log in to ${CLIENT_ACCOUNT.label}`)).toBeInTheDocument();
      // The decisive assertion: no terminal was ever mounted, so no PTY could
      // be spawned — with the account env OR with a silent ambient fallback.
      expect(screen.queryByTestId("terminal-pane")).not.toBeInTheDocument();
      expect(terminalPaneProps).toBeNull();
    });

    it("probes with the account's own config dir, not the ambient one", async () => {
      mount(boundPane);
      await waitFor(() => expect(getProviderAuthStatusForDir).toHaveBeenCalled());
      expect(getProviderAuthStatusForDir).toHaveBeenCalledWith(
        "claude-oauth",
        CLIENT_ACCOUNT.configDir,
      );
    });

    it("holds the launch while the probe is in flight", async () => {
      let resolve: (v: unknown) => void = () => {};
      getProviderAuthStatusForDir.mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      );
      mount(boundPane);
      expect(screen.getByTestId("account-gate-probing")).toBeInTheDocument();
      expect(terminalPaneProps).toBeNull();

      resolve({ status: "ready", hint: "" });
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());
    });

    it("fails CLOSED when the probe itself errors — no ambient fallback", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getProviderAuthStatusForDir.mockRejectedValue(new Error("ipc down"));
      mount(boundPane);
      await waitFor(() => expect(screen.getByTestId("account-gate-blocked")).toBeInTheDocument());
      expect(terminalPaneProps).toBeNull();
      warn.mockRestore();
    });

    it("blocks when the bound account record no longer exists", async () => {
      useCliAccountStore.setState({ accounts: [] });
      mount(boundPane);
      await waitFor(() => expect(screen.getByTestId("account-gate-blocked")).toBeInTheDocument());
      expect(getProviderAuthStatusForDir).not.toHaveBeenCalled();
      expect(terminalPaneProps).toBeNull();
    });

    it("does NOT block on the indeterminate macOS `unknown` status", async () => {
      // The probe's own contract: `unknown` means "could not prove either
      // way" (macOS Keychain), and must not block. The account env is still
      // injected, so this is unverifiable — never an ambient fallback.
      getProviderAuthStatusForDir.mockResolvedValue({
        status: "unknown",
        hint: "Credentials may live in the macOS Keychain",
      });
      mount(boundPane);
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());
      expect(terminalPaneProps?.env).toEqual({
        CLAUDE_CONFIG_DIR: CLIENT_ACCOUNT.configDir,
      });
      expect(screen.getByTestId("account-chip").getAttribute("title")).toContain(
        "Credentials may live in the macOS Keychain",
      );
    });

    it("launches when the probe says ready (covers refreshable expired tokens)", async () => {
      // The Rust probe already reports `ready` for an expired access token with
      // a live refresh token; the per-dir variant reuses that parsing verbatim.
      getProviderAuthStatusForDir.mockResolvedValue({
        status: "ready",
        hint: "Session will auto-refresh on next use",
      });
      mount(boundPane);
      await waitFor(() => expect(screen.getByTestId("terminal-pane")).toBeInTheDocument());
      expect(terminalPaneProps?.env).toEqual({
        CLAUDE_CONFIG_DIR: CLIENT_ACCOUNT.configDir,
      });
    });
  });

  // ── VISIBILITY ──────────────────────────────────────────────────────────
  describe("header account chip", () => {
    it("renders next to the agent identity with the account's stable color", async () => {
      const boundPane: WorkspacePaneType = {
        id: "pane-b",
        agentId: "claude-code",
        sessionId: null,
        accountId: CLIENT_ACCOUNT.id,
      };
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace([boundPane])],
        activeWorkspaceId: "ws-1",
        zoomedPaneId: null,
      });
      mount(boundPane);

      await waitFor(() => expect(screen.getByTestId("account-chip")).toBeInTheDocument());
      const chip = screen.getByTestId("account-chip");
      expect(chip).toHaveTextContent(CLIENT_ACCOUNT.label);
      expect(chip.className).toContain(getAccountColor(CLIENT_ACCOUNT.id).text);
      expect(chip.getAttribute("data-account-id")).toBe(CLIENT_ACCOUNT.id);
    });
  });
});
