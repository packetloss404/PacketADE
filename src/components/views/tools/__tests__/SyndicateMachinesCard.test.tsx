import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyndicateMachinesCard } from "@/components/views/tools/SyndicateMachinesCard";
import { useSyndicateStore } from "@/stores/syndicateStore";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { forgetSyndicateTransport, recordSyndicateTransport } from "@/lib/syndicateTransportStatus";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("SyndicateMachinesCard integration toggle", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useSyndicateStore.setState({
      enabled: true,
      nativeReady: true,
      nativeSyncError: undefined,
      operationGeneration: 0,
      machines: [],
      connectionErrors: {},
      workspaceCache: {},
      catalogCache: {},
    });
    useServerStore.setState({ servers: [] });
    useWorkspaceStore.setState({ workspaces: [] });
    forgetSyndicateTransport("machine-1");
  });

  it("disables the integration without deleting paired configuration", async () => {
    useSyndicateStore.setState({
      machines: [
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
      ],
    });
    render(<SyndicateMachinesCard />);

    const toggle = screen.getByRole("switch", { name: "Syndicate integration" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(invoke).toHaveBeenCalledWith("syndicate_disable_integration");
    expect(screen.getByText("Build host")).toBeInTheDocument();
    expect(screen.getByText("paused by setting")).toBeInTheDocument();
    expect(screen.getByText("View machine status · View")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Build host" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke Build host" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Pair machine/i })).not.toBeInTheDocument();
    expect(useSyndicateStore.getState().machines).toHaveLength(1);
  });

  it("confirms the exact active Workspace, pane, and known-session impact before disabling", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "active",
          name: "Active host work",
          agents: ["terminal"],
          panes: [
            { id: "p1", agentId: "terminal", sessionId: null, syndicateSessionId: "session-1" },
            { id: "p2", agentId: "terminal", sessionId: null, syndicateSessionId: "session-2" },
          ],
          projectPath: "/srv/repo",
          createdAt: 1,
          updatedAt: 1,
          status: "active",
          executionTarget: {
            kind: "syndicate",
            machineId: "machine-1",
            workspaceId: "host-ws",
            serverConfigId: "server-1",
          },
        },
        {
          id: "archived",
          name: "Archived host work",
          agents: ["terminal"],
          panes: [
            { id: "p3", agentId: "terminal", sessionId: null, syndicateSessionId: "session-3" },
          ],
          projectPath: "/srv/old",
          createdAt: 1,
          updatedAt: 1,
          status: "archived",
          executionTarget: {
            kind: "syndicate",
            machineId: "machine-1",
            workspaceId: "old-ws",
            serverConfigId: "server-1",
          },
        },
      ],
    });
    render(<SyndicateMachinesCard />);

    fireEvent.click(screen.getByRole("switch", { name: "Syndicate integration" }));
    expect(
      screen.getByRole("dialog", { name: "Disable Syndicate integration?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 active Syndicate Workspace will become read-only."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 remote terminal panes will pause.")).toBeInTheDocument();
    expect(
      screen.getByText("3 known Host sessions may continue running on the server."),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("syndicate_disable_integration");

    fireEvent.click(screen.getByRole("button", { name: "Keep enabled" }));
    expect(useSyndicateStore.getState().enabled).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Syndicate integration" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable integration" }));
    await waitFor(() => expect(useSyndicateStore.getState().enabled).toBe(false));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("separates configured transport, last successful path, and code-execution authority", () => {
    useSyndicateStore.setState({
      machines: [
        {
          machineId: "machine-1",
          displayName: "Build host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          relayEndpoint: "wss://relay.example/v1/product-route",
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["terminal.input", "future.control"],
          addedAt: 1,
        },
      ],
    });
    recordSyndicateTransport("machine-1", "device-1", "ssh-forward", Date.now());
    recordSyndicateTransport("machine-1", "device-old", "packet-relay", Date.now() + 1);
    render(<SyndicateMachinesCard />);

    expect(screen.getByText("PacketRelay + managed SSH bootstrap")).toBeInTheDocument();
    expect(screen.getByText(/Managed SSH forward ·/)).toBeInTheDocument();
    expect(screen.getByText("Custom authority")).toBeInTheDocument();
    expect(screen.getByText(/Terminal input is granted.*execute code/)).toBeInTheDocument();
    expect(screen.getByText("Unknown permission · future.control")).toBeInTheDocument();
  });

  it("shows revoked scopes only as historical authority", () => {
    useSyndicateStore.setState({
      machines: [
        {
          machineId: "machine-1",
          displayName: "Revoked host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "revoked",
          scopes: ["terminal.input"],
          addedAt: 1,
        },
      ],
    });

    render(<SyndicateMachinesCard />);

    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText("Historical authority")).toBeInTheDocument();
    expect(screen.getByText("Previously granted")).toBeInTheDocument();
    expect(screen.queryByText(/Terminal input is granted/)).not.toBeInTheDocument();
  });
});
