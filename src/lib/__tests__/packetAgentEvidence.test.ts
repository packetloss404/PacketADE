import { describe, expect, it } from "vitest";
import {
  buildPacketAgentEvidenceLanding,
  packetAgentTerminalVerdict,
  parsePacketAgentEvidence,
} from "@/lib/packetAgentEvidence";
import type { PacketAgentDeploymentProjection } from "@/types/packet-agent";

const GOOD_DIGEST = `sha256:${"a".repeat(64)}`;

const VALID_ENTRY = {
  id: "ev-1",
  sequence: 2,
  summary: "Ran the acceptance suite",
  classification: "acceptance",
  sourceEventId: "evt_10",
  workerRunId: "run-1",
  traceId: "trace-1",
  artifactManifestIds: ["man-1"],
  evidenceDigest: GOOD_DIGEST,
  createdAt: "2026-08-01T00:00:00.000Z",
};

function projection(
  overrides: Partial<PacketAgentDeploymentProjection>,
): PacketAgentDeploymentProjection {
  return {
    flightId: "f",
    packageId: "p",
    packageVersion: 1,
    packageDigest: GOOD_DIGEST,
    deploymentId: "dep-1",
    revision: 1,
    status: "active",
    attentionCount: 0,
    evidenceEventIds: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe("parsePacketAgentEvidence", () => {
  it("parses a valid envelope with entries and artifacts, ordered by sequence", () => {
    const result = parsePacketAgentEvidence({
      evidence: [{ ...VALID_ENTRY, id: "ev-2", sequence: 5 }, VALID_ENTRY],
      artifacts: [
        {
          reference: "packetagent://artifacts/one",
          name: "diff.patch",
          mediaType: "text/x-patch",
          byteLength: 512,
          contentDigest: GOOD_DIGEST,
          producerKind: "worker",
          role: "output",
        },
      ],
    });
    expect(result.evidence.map((entry) => entry.id)).toEqual(["ev-1", "ev-2"]);
    expect(result.evidence[0].artifactManifestIds).toEqual(["man-1"]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].name).toBe("diff.patch");
    expect(result.codes).toEqual([]);
    expect(result.integrityErrors).toEqual([]);
  });

  it("surfaces server typed codes verbatim for missing evidence", () => {
    expect(parsePacketAgentEvidence({ code: "worker_evidence_missing" }).codes).toEqual([
      "worker_evidence_missing",
    ]);
    expect(
      parsePacketAgentEvidence({ codes: ["evidence_pruned"], evidence: [] }).codes,
    ).toEqual(["evidence_pruned"]);
    expect(
      parsePacketAgentEvidence({ error: { code: "worker_evidence_unavailable" } }).codes,
    ).toEqual(["worker_evidence_unavailable"]);
  });

  it("flags malformed digests as integrity errors", () => {
    const result = parsePacketAgentEvidence({
      evidence: [{ ...VALID_ENTRY, evidenceDigest: "sha256:nope" }],
      artifacts: [
        {
          reference: "packetagent://artifacts/bad",
          mediaType: "text/plain",
          byteLength: 1,
          contentDigest: "md5:123",
          producerKind: "worker",
        },
      ],
    });
    expect(result.integrityErrors).toHaveLength(2);
    expect(result.integrityErrors[0]).toMatch(/malformed digest/i);
    expect(result.integrityErrors[1]).toMatch(/malformed content digest/i);
  });

  it("tolerates garbage bodies", () => {
    for (const body of [null, undefined, 12, "x", [], {}]) {
      const result = parsePacketAgentEvidence(body);
      expect(result.evidence).toEqual([]);
      expect(result.artifacts).toEqual([]);
    }
  });
});

describe("buildPacketAgentEvidenceLanding", () => {
  it("produces a provenance-stamped artifact-kind inbox message with a stable dedupe key", () => {
    const result = parsePacketAgentEvidence({
      evidence: [VALID_ENTRY],
      artifacts: [
        {
          reference: "packetagent://artifacts/one",
          mediaType: "text/x-patch",
          byteLength: 512,
          contentDigest: GOOD_DIGEST,
          producerKind: "worker",
        },
      ],
    });
    const input = buildPacketAgentEvidenceLanding({
      flightId: "flight-1",
      deploymentId: "dep-1",
      eventId: "evt_10",
      result,
    });
    expect(input.kind).toBe("artifact");
    expect(input.dedupeKey).toBe("packetagent:evidence:evt_10");
    expect(input.sender.kind).toBe("system");
    expect(input.recipients).toEqual([{ kind: "flight" }]);
    expect(input.artifacts).toHaveLength(2);
    for (const artifact of input.artifacts ?? []) {
      expect(artifact.provenance?.origin).toBe("generated_derivative");
      expect(artifact.provenance?.authority).toBe("evidence_only");
    }
    // References only — nothing resembling checked-out content.
    expect(input.artifacts?.[0].uri).toContain("packetagent://");
  });

  it("caps landed references at the inbox artifact limit and says so", () => {
    const result = parsePacketAgentEvidence({
      evidence: Array.from({ length: 12 }, (_, index) => ({
        ...VALID_ENTRY,
        id: `ev-${index}`,
        sequence: index,
      })),
    });
    const input = buildPacketAgentEvidenceLanding({
      flightId: "flight-1",
      deploymentId: "dep-1",
      eventId: "evt_11",
      result,
    });
    expect(input.artifacts).toHaveLength(8);
    expect(input.body).toContain("not attached");
  });
});

describe("packetAgentTerminalVerdict", () => {
  it("treats completed-without-evidence as a warning, never success", () => {
    const verdict = packetAgentTerminalVerdict(
      projection({ status: "completed", evidenceEventIds: [] }),
    );
    expect(verdict).toEqual({ tone: "warning", label: "completed — evidence unavailable" });
  });

  it("treats completed-with-evidence as success", () => {
    const verdict = packetAgentTerminalVerdict(
      projection({ status: "completed", evidenceEventIds: ["evt_1"] }),
    );
    expect(verdict?.tone).toBe("success");
  });

  it("maps the other terminal states to error tones", () => {
    expect(packetAgentTerminalVerdict(projection({ status: "failed" }))?.tone).toBe("error");
    expect(packetAgentTerminalVerdict(projection({ status: "budget_exhausted" }))?.label).toBe(
      "budget exhausted",
    );
    expect(packetAgentTerminalVerdict(projection({ status: "cancelled" }))?.tone).toBe("error");
  });

  it("returns nothing for non-terminal states", () => {
    expect(packetAgentTerminalVerdict(projection({ status: "active" }))).toBeUndefined();
    expect(packetAgentTerminalVerdict(projection({ status: "paused" }))).toBeUndefined();
  });
});
