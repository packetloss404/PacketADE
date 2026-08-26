import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyndicateTerminalPane } from "@/components/session/SyndicateTerminalPane";
import { useSyndicateStore } from "@/stores/syndicateStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { WorkspacePane } from "@/types/workspace";

const terminal = vi.hoisted(() => ({
  write: vi.fn(),
  open: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      return terminal;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

// Mocked at the Tauri boundary rather than at `@/lib/tauri`, so the real
// wrapper runs and the native error payload is rehydrated exactly as it is in
// production. That rehydration is the seam these tests are about.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/** The shape a native Syndicate command rejects with. */
function nativeRejection(detail: {
  message: string;
  code?: string;
  retryable?: boolean;
  correlationId?: string;
}) {
  return Promise.reject(detail);
}

const MACHINE = {
  machineId: "machine-1",
  displayName: "Build host",
  deviceId: "device-1",
  serverConfigId: "server-1",
  localPort: 4317,
  machineSigningFingerprint: "fingerprint",
  grantStatus: "active" as const,
  scopes: [
    "machine.read",
    "workspace.read",
    "workspace.create",
    "session.start",
    "terminal.view",
    "terminal.input",
    "terminal.resize",
    "terminal.stop",
  ],
  addedAt: 1,
};

const PANE: WorkspacePane = {
  id: "pane-1",
  agentId: "claude-code",
  sessionId: null,
  syndicatePaneId: "host-pane-1",
  syndicateTerminalSessionId: "host-terminal-1",
};

function setWorkspace(pane: WorkspacePane) {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "workspace-1",
        name: "Remote work",
        agents: ["claude-code"],
        panes: [pane],
        projectPath: "/srv/work",
        createdAt: 1,
        updatedAt: 1,
        status: "active",
      },
    ],
  });
}

function renderPane(pane: WorkspacePane = PANE, autoStart = true) {
  return render(
    <SyndicateTerminalPane
      pane={pane}
      workspaceId="workspace-1"
      machineId="machine-1"
      hostWorkspaceId="host-workspace-1"
      autoStart={autoStart}
      renderHeader={() => null}
    />,
  );
}

/** How many times the pane has asked the Host to attach. */
function attachCalls(): number {
  return invoke.mock.calls.filter(([command]) => command === "syndicate_session_attach").length;
}

describe("SyndicateTerminalPane reconnect behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    useSyndicateStore.setState({
      enabled: true,
      nativeReady: true,
      nativeSyncError: undefined,
      operationGeneration: 0,
      machines: [MACHINE],
      connectionErrors: {},
      workspaceCache: {},
      catalogCache: {},
    });
    setWorkspace(PANE);
  });

  it("stops attaching once the Host rejects an expired grant", async () => {
    // The day-30 cliff. Grants last 30 days with no renewal path, so every
    // paired device reaches this. `DEVICE_UNAUTHORIZED` was absent from the
    // old message-fragment stop condition, so the pane re-signed
    // session.attach every five seconds indefinitely against a grant the Host
    // would never honour again — while the machines card went on advertising
    // "Full coding control".
    invoke.mockImplementation((command: string) => {
      if (command === "syndicate_session_start") {
        return Promise.resolve({
          requestId: "request-1",
          transport: "ssh-forward",
          result: { session: { sessionId: "session-1", state: "running" } },
        });
      }
      if (command === "syndicate_session_attach") {
        return nativeRejection({
          message: "DEVICE_UNAUTHORIZED: Syndicate rejected the controller request",
          code: "DEVICE_UNAUTHORIZED",
          retryable: false,
          correlationId: "correlation-1",
        });
      }
      return Promise.resolve(undefined);
    });

    renderPane();

    await waitFor(() => expect(attachCalls()).toBeGreaterThan(0), { timeout: 3_000 });
    const settled = attachCalls();

    // Well past the 5s cap the old backoff settled into.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(attachCalls()).toBe(settled);
    expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("expired");
  });

  it("keeps reconnecting through a local transport fault", async () => {
    // A socket fault carries no Host verdict. Treating absence as "not
    // retryable" would break ordinary reconnect, which the fatal check must
    // preserve.
    invoke.mockImplementation((command: string) => {
      if (command === "syndicate_session_start") {
        return Promise.resolve({
          requestId: "request-1",
          transport: "ssh-forward",
          result: { session: { sessionId: "session-1", state: "running" } },
        });
      }
      if (command === "syndicate_session_attach") {
        return nativeRejection({
          message: "Cannot reach Syndicate on the loopback forward: timed out",
        });
      }
      return Promise.resolve(undefined);
    });

    renderPane();

    await waitFor(() => expect(attachCalls()).toBeGreaterThan(0), { timeout: 3_000 });
    const first = attachCalls();
    await waitFor(() => expect(attachCalls()).toBeGreaterThan(first), { timeout: 5_000 });
    // No verdict means no grant-state guess.
    expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("active");
  });

  it("stops on a revoked grant and records it as revoked", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "syndicate_session_start") {
        return Promise.resolve({
          requestId: "request-1",
          transport: "ssh-forward",
          result: { session: { sessionId: "session-1", state: "running" } },
        });
      }
      if (command === "syndicate_session_attach") {
        return nativeRejection({
          message:
            "PacketRelay request failed without an automatic retry over SSH: This PacketBench device was revoked by Syndicate.",
          code: "DEVICE_REVOKED",
          retryable: false,
        });
      }
      return Promise.resolve(undefined);
    });

    renderPane();

    await waitFor(
      () => expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("revoked"),
      { timeout: 5_000 },
    );
    const settled = attachCalls();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(attachCalls()).toBe(settled);
  });

  it("keeps a restored session's live state when auto-start is off", async () => {
    // A mount-time reset used to clobber the restored `alive` state, so a pane
    // holding a live Host session rendered "detached".
    invoke.mockResolvedValue(undefined);
    const restored: WorkspacePane = { ...PANE, syndicateSessionId: "session-restored" };
    setWorkspace(restored);

    const { getByText } = renderPane(restored, false);

    expect(getByText(/running/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("syndicate_session_start", expect.anything());
  });

  it("drops the previous device's session identities after a re-pair", async () => {
    // Reusing them made the new device attach the previous device's session,
    // and the Host answered SESSION_NOT_OWNED.
    invoke.mockResolvedValue(undefined);
    const restored: WorkspacePane = { ...PANE, syndicateSessionId: "session-restored" };
    setWorkspace(restored);
    const { rerender } = renderPane(restored, false);

    useSyndicateStore.setState({ machines: [{ ...MACHINE, deviceId: "device-2" }] });
    rerender(
      <SyndicateTerminalPane
        pane={restored}
        workspaceId="workspace-1"
        machineId="machine-1"
        hostWorkspaceId="host-workspace-1"
        autoStart={false}
        renderHeader={() => null}
      />,
    );

    await waitFor(() => {
      const pane = useWorkspaceStore.getState().workspaces[0].panes[0];
      expect(pane.syndicateSessionId).toBeUndefined();
      expect(pane.syndicatePaneId).toBeUndefined();
      expect(pane.syndicateTerminalSessionId).toBeUndefined();
    });
  });
});
