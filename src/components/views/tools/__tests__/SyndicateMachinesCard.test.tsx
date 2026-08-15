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
    // Revoking and local forget stay available: disabling the integration is
    // what a user does on suspicion, and it must not disarm the remedy.
    expect(screen.getByRole("button", { name: "Revoke Build host" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forget Build host locally" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Pair machine/i })).not.toBeInTheDocument();
    expect(useSyndicateStore.getState().machines).toHaveLength(1);
  });

  it("revokes a device while the integration is disabled", async () => {
    useSyndicateStore.setState({
      enabled: false,
      machines: [
        {
          machineId: "machine-1",
          displayName: "Build host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["terminal.input"],
          addedAt: 1,
        },
      ],
    });
    invoke.mockImplementation((command: string) =>
      command === "syndicate_revoke_self"
        ? Promise.resolve({ requestId: "request-1", transport: "ssh-forward", result: {} })
        : Promise.resolve(undefined),
    );
    render(<SyndicateMachinesCard />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Build host" }));
    expect(screen.getByText(/Revoking while disabled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke device" }));

    await waitFor(() => expect(useSyndicateStore.getState().machines).toHaveLength(0));
    expect(invoke).toHaveBeenCalledWith("syndicate_revoke_self", expect.anything());
  });

  it("confirms before restoring controller authority to a paired host", async () => {
    // Enabling is the authority-increasing direction. It used to be one
    // unconfirmed click that handed terminal.input — code execution as the
    // Syndicate OS user — back to every paired machine.
    useSyndicateStore.setState({
      enabled: false,
      machines: [
        {
          machineId: "machine-1",
          displayName: "Build host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["terminal.input"],
          addedAt: 1,
        },
      ],
    });
    render(<SyndicateMachinesCard />);

    const toggle = screen.getByRole("switch", { name: "Syndicate integration" });
    fireEvent.click(toggle);

    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText("This grants code execution")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable integration" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("syndicate_set_integration_enabled", { enabled: true }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("keeps the integration off and reports why when enabling fails natively", async () => {
    // The disable direction already had this covered; a failed *enable* left
    // the toggle claiming a state the native boundary never reached.
    useSyndicateStore.setState({ enabled: false, machines: [] });
    invoke.mockImplementation((command: string) =>
      command === "syndicate_set_integration_enabled"
        ? Promise.reject({ message: "Native Syndicate boundary is unavailable." })
        : Promise.resolve(undefined),
    );
    render(<SyndicateMachinesCard />);

    const toggle = screen.getByRole("switch", { name: "Syndicate integration" });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Native Syndicate boundary is unavailable.",
      ),
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(useSyndicateStore.getState().enabled).toBe(false);
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
