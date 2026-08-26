import { describe, expect, it } from "vitest";
import { summarizeFlightAttention } from "@/lib/flightReview";
import type { Flight } from "@/types/flight";
import type { PacketAgentDeploymentProjection } from "@/types/packet-agent";

function flight(): Flight {
  return {
    id: "flight-1",
    title: "F",
    objective: "O",
    status: "active",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
  };
}

function projection(
  overrides: Partial<PacketAgentDeploymentProjection>,
): PacketAgentDeploymentProjection {
  return {
    flightId: "flight-1",
    packageId: "p",
    packageVersion: 1,
    packageDigest: `sha256:${"a".repeat(64)}`,
    deploymentId: "dep-1",
    revision: 1,
    status: "active",
    attentionCount: 0,
    evidenceEventIds: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe("summarizeFlightAttention — PacketAgent contribution (PH9)", () => {
  it("stays silent without a projection or with a healthy one", () => {
    expect(summarizeFlightAttention(flight()).packetAgent).toBeUndefined();
    const healthy = summarizeFlightAttention(flight(), projection({ status: "active" }));
    expect(healthy.packetAgent).toBeUndefined();
    expect(healthy.total).toBe(0);
  });

  it("surfaces open attention events", () => {
    const summary = summarizeFlightAttention(flight(), projection({ attentionCount: 2 }));
    expect(summary.packetAgent).toEqual({
      attentionCount: 2,
      terminalFailure: false,
      deploymentId: "dep-1",
    });
    expect(summary.total).toBe(1);
  });

  it("surfaces terminal failures but not clean completion", () => {
    for (const status of ["failed", "budget_exhausted", "cancelled"]) {
      const summary = summarizeFlightAttention(flight(), projection({ status }));
      expect(summary.packetAgent?.terminalFailure).toBe(true);
      expect(summary.total).toBe(1);
    }
    const completed = summarizeFlightAttention(
      flight(),
      projection({ status: "completed", evidenceEventIds: ["evt_1"] }),
    );
    expect(completed.packetAgent).toBeUndefined();
  });
});
