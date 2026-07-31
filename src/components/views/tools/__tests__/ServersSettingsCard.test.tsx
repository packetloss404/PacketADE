/**
 * CRITICAL fix: deleting a live SSH host used to proceed with NO confirmation.
 *
 * The confirm the review found (`ServersView.tsx`) was dead code — nothing
 * ever routed to that view — so the surface users actually reach, this
 * Settings card, destroyed a `ServerConfig` straight from a 10px hover trash
 * icon. These tests pin the fix: an explicit styled confirm is required, Cancel
 * mutates nothing, and the modal names the work still riding on the host.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { ServersSettingsCard } from "@/components/views/tools/ServersSettingsCard";
import { useServerStore } from "@/stores/serverStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Attempt, Flight } from "@/types/flight";
import type { ServerConfig } from "@/types/server";
import type { Workspace } from "@/types/workspace";

const PROD: ServerConfig = {
  id: "srv-1",
  name: "prod-box",
  host: "10.0.0.4",
  port: 22,
  username: "deploy",
  authMethod: "key",
  installedAgents: [],
};

function seedServers(servers: ServerConfig[] = [PROD]) {
  useServerStore.setState({ servers, activeServerId: null, connectionStates: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  seedServers();
  useAgentTaskStore.setState({ conversations: [] });
  useFlightStore.setState({ flights: [] });
  useWorkspaceStore.setState({ workspaces: [] });
});

describe("ServersSettingsCard delete confirm", () => {
  it("does not delete on the trash click — it opens a named confirm", () => {
    render(<ServersSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));

    // Nothing destroyed yet.
    expect(useServerStore.getState().servers).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Delete remote host?" })).toBeInTheDocument();
    // The confirm identifies the exact host, not "this server".
    expect(screen.getByText(/prod-box \(deploy@10\.0\.0\.4:22\)/)).toBeInTheDocument();
  });

  it("cancelling performs no mutation", () => {
    render(<ServersSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useServerStore.getState().servers).toEqual([PROD]);
    expect(screen.queryByRole("heading", { name: "Delete remote host?" })).not.toBeInTheDocument();
    // Re-opening and pressing Escape is equally lossless.
    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useServerStore.getState().servers).toEqual([PROD]);
  });

  it("deletes only after the explicit confirm button", () => {
    render(<ServersSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete host" }));

    expect(useServerStore.getState().servers).toEqual([]);
  });

  it("purges the stored SSH password from the OS keyring", () => {
    render(<ServersSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete host" }));

    // Without this the `ssh-<id>` secret outlived its record forever with no
    // in-app path to remove it.
    expect(invoke).toHaveBeenCalledWith("delete_ssh_password", { serverId: "srv-1" });
  });

  it("still deletes the host when the credential store rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "delete_ssh_password") throw new Error("credential store locked");
      return undefined;
    });

    render(<ServersSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete host" }));

    // Keyring purge is best-effort: the record the user confirmed is gone.
    expect(useServerStore.getState().servers).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Delete remote host?" })).not.toBeInTheDocument();

    // Logged, not silently swallowed.
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("serverStore.deleteSshPassword"),
        expect.anything(),
      ),
    );
    warn.mockRestore();
  });

  it("tells the user the password is removed, not left behind", () => {
    render(<ServersSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));

    expect(
      screen.getByText(/stored SSH password is removed from the OS credential store/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing on the remote machine is deleted/)).toBeInTheDocument();
  });

  it("never reaches for the native dialog", () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    render(<ServersSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete host" }));

    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it("shows no in-use callout for an unused host", () => {
    render(<ServersSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns that the host is connected and carrying live work", () => {
    useServerStore.setState({
      connectionStates: { "srv-1": { status: "connected", steps: [] } },
    });
    useAgentTaskStore.setState({
      conversations: [
        {
          id: "c1",
          title: "Deploy audit",
          agent: "api-claude",
          projectPath: "/srv/app",
          status: "active",
          messages: [],
          sessionId: "s1",
          rawOutput: "",
          createdAt: 0,
          updatedAt: 0,
          mode: "api",
          sshTarget: {
            id: "srv-1",
            name: "prod-box",
            host: "10.0.0.4",
            user: "deploy",
            remotePath: "/srv/app",
          },
        } as AgentConversation,
      ],
    });
    useFlightStore.setState({
      flights: [
        {
          id: "f1",
          title: "Migrate",
          attempts: [
            {
              id: "a1",
              flightId: "f1",
              target: {
                kind: "ssh",
                serverId: "srv-1",
                basePath: "/srv/app",
                worktreePath: "/srv/wt",
              },
              agentConfigId: "claude",
              model: "m",
              provider: "anthropic",
              branch: "pkt/a1",
              baseBranch: "main",
              sessionId: "s2",
              status: "running",
              cost: 0,
              tokens: 0,
            } as Attempt,
          ],
        } as Flight,
      ],
    });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "prod app",
          agents: [],
          panes: [],
          projectPath: "/srv/app",
          createdAt: 0,
          updatedAt: 0,
          status: "active",
          serverId: "srv-1",
        } as Workspace,
      ],
    });

    render(<ServersSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This is in use right now");
    expect(alert).toHaveTextContent(/Connected right now/);
    expect(alert).toHaveTextContent(/1 conversation runs on this host \(1 mid-turn\)/);
    expect(alert).toHaveTextContent(/Deploy audit/);
    expect(alert).toHaveTextContent(/1 flight attempt still running on this host/);
    expect(alert).toHaveTextContent(/1 workspace bound to it: prod app/);
  });

  it("scopes the warning to the host being deleted", () => {
    const other: ServerConfig = { ...PROD, id: "srv-2", name: "staging-box" };
    seedServers([PROD, other]);
    useServerStore.setState({
      connectionStates: { "srv-2": { status: "connected", steps: [] } },
    });

    render(<ServersSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Delete prod-box" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
