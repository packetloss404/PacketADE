import { describe, expect, it } from "vitest";
import { pairingPackageRelayEndpoint, parseMachineSnapshot, parseSessionResult } from "@/types/syndicate";

describe("Syndicate controller v1 session DTOs", () => {
  it("projects the optional top-level Host relay endpoint without confusing invitation fields", () => {
    expect(pairingPackageRelayEndpoint({
      protocolVersion: 1,
      relayEndpoint: "wss://relay.example.test/v1/product-route",
      invitation: { machineId: "machine_1" },
    })).toBe("wss://relay.example.test/v1/product-route");
    expect(pairingPackageRelayEndpoint({ invitation: { relayEndpoint: "wss://evil.test/v1/product-route" } }))
      .toBeUndefined();
  });

  it("uses PacketHost sessionId and exact replay cursor fields", () => {
    expect(
      parseSessionResult({
        session: { sessionId: "session_1", state: "running" },
        replay: {
          chunks: [{ sequence: 4, dataBase64: "aGk" }],
          oldestAvailableSequence: 1,
          latestSequence: 4,
          nextAfterSequence: 4,
          hasMore: false,
          truncated: false,
        },
      }),
    ).toMatchObject({
      session: { sessionId: "session_1" },
      replay: { nextAfterSequence: 4 },
    });
  });

  it("rejects the obsolete session.id shape", () => {
    expect(() => parseSessionResult({ session: { id: "session_1" } })).toThrow(
      "missing a session id",
    );
  });

  it("requires the Host's string auth probe to report authenticated readiness", () => {
    const base = {
      machine: {
        id: "machine_1",
        platform: {
          os: "linux",
          architecture: "x64",
          logicalCpuCount: 32,
          totalMemoryBytes: 256 * 1024 ** 3,
        },
      },
      controller: {
        protocolVersion: 1,
        transport: "ssh-forward",
        device: { deviceId: "device_1", scopes: [], revocationEpoch: 0 },
      },
      snapshotSequence: 1,
      capabilities: {
        terminal: { launchProfiles: [{ id: "codex", available: true }] },
        agents: [{ id: "codex", displayName: "Codex", auth: "unauthenticated" }],
      },
    };
    expect(parseMachineSnapshot(base).agents[0]?.state).toBe("auth-required");
    expect(
      parseMachineSnapshot({
        ...base,
        capabilities: {
          ...base.capabilities,
          agents: [{ id: "codex", displayName: "Codex", auth: "authenticated" }],
        },
      }).agents[0]?.state,
    ).toBe("ready");
  });
});
