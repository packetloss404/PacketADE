import { describe, expect, it } from "vitest";
import { parseContractSummary } from "@/lib/packetAgentContract";
import { WORKER_PACKAGE_SCHEMA_VERSION } from "@/types/packet-agent";

describe("parseContractSummary", () => {
  it("reports a match when the server speaks this app's schema", () => {
    const summary = parseContractSummary({
      schemaVersion: WORKER_PACKAGE_SCHEMA_VERSION,
      operations: ["deployment.inspect", "deployment.deploy"],
      credential: {
        displayName: "PacketADE handoff",
        allowedOperations: ["deployment.deploy"],
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
    expect(summary.schemaMatches).toBe(true);
    expect(summary.schemaVersion).toBe(WORKER_PACKAGE_SCHEMA_VERSION);
    expect(summary.operations).toEqual(["deployment.inspect", "deployment.deploy"]);
    expect(summary.allowedOperations).toEqual(["deployment.deploy"]);
    expect(summary.credentialDisplayName).toBe("PacketADE handoff");
    expect(summary.credentialExpiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("flags a schema mismatch as a warning-shaped summary, not a throw", () => {
    const summary = parseContractSummary({ schemaVersion: "packetagent.worker-package/v2" });
    expect(summary.schemaMatches).toBe(false);
    expect(summary.schemaVersion).toBe("packetagent.worker-package/v2");
  });

  it("tolerates a malformed body", () => {
    for (const body of [null, undefined, "nope", 42, [], {}]) {
      const summary = parseContractSummary(body);
      expect(summary.schemaMatches).toBe(false);
      expect(summary.operations).toEqual([]);
      expect(summary.allowedOperations).toEqual([]);
    }
  });
});
