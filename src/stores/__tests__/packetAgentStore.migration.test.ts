import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKET_AGENT_ENDPOINT,
  migratePacketAgentPersistedState,
} from "@/stores/packetAgentStore";

describe("packetAgentStore persisted-state migration", () => {
  it("rewrites the stale 8787 default endpoint on version-0 state", () => {
    const migrated = migratePacketAgentPersistedState(
      { endpoint: "http://127.0.0.1:8787", workspaceId: "ws", deployments: {} },
      0,
    );
    expect(migrated.endpoint).toBe(DEFAULT_PACKET_AGENT_ENDPOINT);
    expect(migrated.workspaceId).toBe("ws");
  });

  it("leaves a user-configured endpoint alone", () => {
    const migrated = migratePacketAgentPersistedState(
      { endpoint: "https://agent.example.test", workspaceId: "", deployments: {} },
      0,
    );
    expect(migrated.endpoint).toBe("https://agent.example.test");
  });

  it("does not touch already-migrated state", () => {
    const migrated = migratePacketAgentPersistedState(
      { endpoint: "http://127.0.0.1:8787", workspaceId: "", deployments: {} },
      1,
    );
    expect(migrated.endpoint).toBe("http://127.0.0.1:8787");
  });
});
