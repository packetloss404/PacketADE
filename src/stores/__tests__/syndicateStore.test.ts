import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";
import { toSyndicateError } from "@/lib/syndicateErrors";
import { syndicateAuthoritySummary } from "@/lib/syndicateMachineStatus";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

async function loadStore() {
  vi.resetModules();
  return import("@/stores/syndicateStore");
}

describe("syndicateStore integration setting", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("defaults to enabled for existing installations", async () => {
    const { useSyndicateStore } = await loadStore();
    expect(useSyndicateStore.getState().enabled).toBe(true);
    expect(useSyndicateStore.getState().nativeReady).toBe(false);
    await useSyndicateStore.getState().syncNative();
    expect(useSyndicateStore.getState().nativeReady).toBe(true);
    expect(invoke).toHaveBeenCalledWith("syndicate_set_integration_enabled", { enabled: true });
  });

  it("persists disabled and closes PacketADE-managed tunnels", async () => {
    const { useSyndicateStore } = await loadStore();

    await useSyndicateStore.getState().setEnabled(false);

    expect(useSyndicateStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(storageKey("syndicate-integration-enabled-v1"))).toBe("false");
    expect(invoke).toHaveBeenCalledWith("syndicate_disable_integration");

    const { useSyndicateStore: reloaded } = await loadStore();
    expect(reloaded.getState().enabled).toBe(false);
  });

  it("fails closed when native tunnel shutdown reports degraded cleanup", async () => {
    invoke.mockRejectedValueOnce(new Error("tunnel registry unavailable"));
    const { useSyndicateStore } = await loadStore();

    await expect(useSyndicateStore.getState().setEnabled(false)).rejects.toThrow(
      "tunnel registry unavailable",
    );

    expect(useSyndicateStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(storageKey("syndicate-integration-enabled-v1"))).toBe("false");
  });

  it("blocks controller operations without discarding paired machines", async () => {
    localStorage.setItem(storageKey("syndicate-integration-enabled-v1"), "false");
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    expect(useSyndicateStore.getState().machines).toHaveLength(1);
    await expect(useSyndicateStore.getState().refresh("machine-1")).rejects.toThrow(
      "disabled in Settings",
    );
    expect(invoke).not.toHaveBeenCalledWith("syndicate_machine_snapshot", expect.anything());
    expect(useSyndicateStore.getState().machines).toHaveLength(1);
  });

  it("still revokes and forgets while the integration is disabled", async () => {
    // The kill switch must not disarm the remedy. A user who disables the
    // integration on suspicion of compromise still has to be able to kill the
    // grant on the Host, and local key deletion needs no transport at all.
    localStorage.setItem(storageKey("syndicate-integration-enabled-v1"), "false");
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
        {
          machineId: "machine-2",
          displayName: "Offline host",
          deviceId: "device-2",
          serverConfigId: "server-2",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint-2",
          grantStatus: "active",
          scopes: ["machine.read"],
          addedAt: 2,
        },
      ]),
    );
    invoke.mockImplementation((command: string) =>
      command === "syndicate_revoke_self"
        ? Promise.resolve({ requestId: "request-1", transport: "ssh-forward", result: {} })
        : Promise.resolve(undefined),
    );
    const { useSyndicateStore } = await loadStore();
    expect(useSyndicateStore.getState().enabled).toBe(false);

    await useSyndicateStore.getState().revoke("machine-1");
    expect(invoke).toHaveBeenCalledWith("syndicate_revoke_self", expect.anything());
    expect(invoke).toHaveBeenCalledWith("syndicate_forget_machine", { machineId: "machine-1" });

    await useSyndicateStore.getState().forgetOffline("machine-2");
    expect(invoke).toHaveBeenCalledWith("syndicate_forget_machine", { machineId: "machine-2" });
    expect(useSyndicateStore.getState().machines).toHaveLength(0);
  });

  it("ignores a late refresh snapshot after disabling", async () => {
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
      ]),
    );
    let resolveSnapshot!: (value: unknown) => void;
    const pendingSnapshot = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    invoke.mockImplementation((command: string) =>
      command === "syndicate_machine_snapshot" ? pendingSnapshot : Promise.resolve(undefined),
    );
    const { useSyndicateStore } = await loadStore();

    const refresh = useSyndicateStore.getState().refresh("machine-1");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("syndicate_machine_snapshot", expect.anything()),
    );
    await useSyndicateStore.getState().setEnabled(false);
    resolveSnapshot({
      requestId: "request-1",
      transport: "ssh-forward",
      result: {
        machine: {
          id: "machine-1",
          displayName: "Late host name",
          platform: {
            os: "linux",
            architecture: "x64",
            logicalCpuCount: 32,
            totalMemoryBytes: 1024,
          },
        },
        controller: {
          protocolVersion: 1,
          transport: "ssh-forward",
          device: { deviceId: "device-1", scopes: ["terminal.input"], revocationEpoch: 1 },
        },
        snapshotSequence: 2,
        capabilities: { terminal: { launchProfiles: [] }, agents: [] },
      },
    });
    await refresh;

    const machine = useSyndicateStore.getState().machines[0];
    expect(useSyndicateStore.getState().enabled).toBe(false);
    expect(machine.displayName).toBe("Build host");
    expect(machine.cachedSnapshot).toBeUndefined();
    expect(machine.scopes).toEqual(["machine.read"]);
    expect(localStorage.getItem(storageKey("syndicate-transport-status-v1"))).toBeNull();
  });

  it("serializes startup synchronization with a newer disable intent", async () => {
    let resolveEnable!: () => void;
    const enablePending = new Promise<void>((resolve) => {
      resolveEnable = resolve;
    });
    invoke.mockImplementation((command: string, args?: { enabled?: boolean }) => {
      if (command === "syndicate_set_integration_enabled" && args?.enabled === true) {
        return enablePending;
      }
      return Promise.resolve(undefined);
    });
    const { useSyndicateStore } = await loadStore();

    const startup = useSyndicateStore.getState().syncNative();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("syndicate_set_integration_enabled", { enabled: true }),
    );
    const disable = useSyndicateStore.getState().setEnabled(false);
    resolveEnable();
    await Promise.all([startup, disable]);

    expect(useSyndicateStore.getState().enabled).toBe(false);
    expect(useSyndicateStore.getState().nativeReady).toBe(true);
    expect(invoke.mock.calls[invoke.mock.calls.length - 1]?.[0]).toBe(
      "syndicate_disable_integration",
    );
  });

  it("classifies a relay revocation as historical authority", async () => {
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    // The native layer classifies a relay `routeRevoked` frame before the
    // message is prefixed, so the frontend sees the code rather than prose.
    useSyndicateStore
      .getState()
      .recordControllerFailure(
        "machine-1",
        "device-1",
        toSyndicateError({
          message:
            "PacketRelay request failed without an automatic retry over SSH: This PacketADE device was revoked by Syndicate.",
          code: "DEVICE_REVOKED",
          retryable: false,
        }),
      );

    expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("revoked");
  });

  it("marks an expired grant expired from the Host's own error code", async () => {
    // The day-30 cliff. A Host answers an expired grant with
    // DEVICE_UNAUTHORIZED and leaves `status` as "active", so a client that
    // reads the message instead of the code leaves the card advertising
    // "Full coding control" for a grant that can never succeed again.
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    useSyndicateStore.getState().recordControllerFailure(
      "machine-1",
      "device-1",
      toSyndicateError({
        message: "DEVICE_UNAUTHORIZED: Syndicate rejected the controller request",
        code: "DEVICE_UNAUTHORIZED",
        retryable: false,
        correlationId: "correlation-1",
      }),
    );

    expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("expired");
    expect(
      syndicateAuthoritySummary(
        useSyndicateStore.getState().machines[0].grantStatus,
        useSyndicateStore.getState().machines[0].scopes,
      ),
    ).toBe("Expired");
  });

  it("captures the Host's grant expiry so the cliff can be warned about", async () => {
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
      ]),
    );
    const expiresAt = "2026-09-11T00:00:00.000Z";
    invoke.mockImplementation((command: string) =>
      command === "syndicate_machine_snapshot"
        ? Promise.resolve({
            requestId: "request-1",
            transport: "ssh-forward",
            result: {
              machine: {
                id: "machine-1",
                displayName: "Build host",
                platform: {
                  os: "linux",
                  architecture: "x64",
                  logicalCpuCount: 8,
                  totalMemoryBytes: 1024,
                },
              },
              controller: {
                protocolVersion: 1,
                transport: "ssh-forward",
                device: {
                  deviceId: "device-1",
                  scopes: ["machine.read"],
                  revocationEpoch: 0,
                  relayGrant: { grant: { expiresAt } },
                },
              },
              snapshotSequence: 1,
              capabilities: { terminal: { launchProfiles: [] }, agents: [] },
            },
          })
        : Promise.resolve(undefined),
    );
    const { useSyndicateStore } = await loadStore();

    await useSyndicateStore.getState().refresh("machine-1");

    expect(useSyndicateStore.getState().machines[0].grantExpiresAt).toBe(Date.parse(expiresAt));
  });

  it("does not invent a grant state from an untyped failure", async () => {
    // No Host verdict means no verdict. Guessing from prose is what this
    // whole seam replaced.
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
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
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    useSyndicateStore
      .getState()
      .recordControllerFailure(
        "machine-1",
        "device-1",
        toSyndicateError({ message: "Cannot reach Syndicate on the loopback forward: timed out" }),
      );

    expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("active");
  });

  it("drops a persisted machine whose grant status is unrecognized", async () => {
    // Storage from an older build has no `grantStatus`, which read as
    // `undefined` and let a dead grant render as "Full coding control".
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
        {
          machineId: "machine-1",
          displayName: "Build host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          scopes: ["terminal.input"],
          addedAt: 1,
        },
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    expect(useSyndicateStore.getState().machines).toHaveLength(0);
  });

  it("ignores a stale authority failure from a replaced device", async () => {
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
        {
          machineId: "machine-1",
          displayName: "Replacement",
          deviceId: "device-new",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["terminal.input"],
          addedAt: 1,
        },
      ]),
    );
    const { useSyndicateStore } = await loadStore();

    useSyndicateStore
      .getState()
      .recordControllerFailure(
        "machine-1",
        "device-old",
        new Error("This PacketADE device was revoked by Syndicate."),
      );

    expect(useSyndicateStore.getState().machines[0].grantStatus).toBe("active");
  });

  it("does not apply an old device snapshot to a replacement pairing", async () => {
    localStorage.setItem(
      storageKey("syndicate-machines-v1"),
      JSON.stringify([
        {
          machineId: "machine-1",
          displayName: "Original host",
          deviceId: "device-old",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["machine.read"],
          addedAt: 1,
        },
      ]),
    );
    let resolveSnapshot!: (value: unknown) => void;
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const { useSyndicateStore } = await loadStore();
    const refresh = useSyndicateStore.getState().refresh("machine-1");
    await vi.waitFor(() => expect(resolveSnapshot).toBeTypeOf("function"));
    useSyndicateStore.setState((state) => ({
      machines: state.machines.map((machine) => ({
        ...machine,
        displayName: "Replacement host",
        deviceId: "device-new",
        scopes: ["workspace.read"],
      })),
    }));
    resolveSnapshot({
      requestId: "request-old",
      transport: "ssh-forward",
      result: {
        machine: {
          id: "machine-1",
          displayName: "Stale host",
          platform: {
            os: "linux",
            architecture: "x64",
            logicalCpuCount: 32,
            totalMemoryBytes: 1024,
          },
        },
        controller: {
          protocolVersion: 1,
          transport: "ssh-forward",
          device: { deviceId: "device-old", scopes: ["terminal.input"], revocationEpoch: 1 },
        },
        snapshotSequence: 3,
        capabilities: { terminal: { launchProfiles: [] }, agents: [] },
      },
    });
    await refresh;

    expect(useSyndicateStore.getState().machines[0]).toMatchObject({
      displayName: "Replacement host",
      deviceId: "device-new",
      scopes: ["workspace.read"],
    });
  });
});
