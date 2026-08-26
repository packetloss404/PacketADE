import { describe, expect, it } from "vitest";
import {
  buildPacketAgentCoordinationMessage,
  buildPacketAgentDeepLinkUri,
  parsePacketAgentDeepLink,
} from "@/lib/packetAgentCoordination";

const BASE = { flightId: "flight-1", deploymentId: "dep-1", workerRunId: "run-1" };

describe("PacketAgent deep links", () => {
  it("round-trips deployment, run, and attention ids", () => {
    const uri = buildPacketAgentDeepLinkUri({
      deploymentId: "dep-1",
      workerRunId: "run-1",
      attentionRequestId: "att-1",
    });
    expect(parsePacketAgentDeepLink(uri)).toEqual({
      deploymentId: "dep-1",
      workerRunId: "run-1",
      attentionRequestId: "att-1",
    });
  });

  it("round-trips a bare deployment id and rejects foreign uris", () => {
    const uri = buildPacketAgentDeepLinkUri({ deploymentId: "dep-2" });
    expect(parsePacketAgentDeepLink(uri)).toEqual({
      deploymentId: "dep-2",
      workerRunId: undefined,
      attentionRequestId: undefined,
    });
    expect(parsePacketAgentDeepLink("https://example.com/x")).toBeUndefined();
    expect(parsePacketAgentDeepLink(undefined)).toBeUndefined();
  });
});

describe("buildPacketAgentCoordinationMessage per-type mapping", () => {
  it("maps approval_required to a blocker with the attention id in the deep link", () => {
    const message = buildPacketAgentCoordinationMessage({
      ...BASE,
      event: {
        eventId: "evt_1",
        type: "worker.run.approval_required",
        data: { attentionRequestId: "att-9", summary: "Wants to push" },
      },
    });
    expect(message?.kind).toBe("blocker");
    expect(message?.dedupeKey).toBe("packetagent:evt_1");
    expect(message?.sender.kind).toBe("system");
    expect(message?.body).toContain("Wants to push");
    const link = parsePacketAgentDeepLink(message?.artifacts?.[0]?.uri);
    expect(link).toEqual({
      deploymentId: "dep-1",
      workerRunId: "run-1",
      attentionRequestId: "att-9",
    });
  });

  it("maps completion to a finding and failures to blockers", () => {
    const completed = buildPacketAgentCoordinationMessage({
      ...BASE,
      event: { eventId: "evt_2", type: "worker.run.completed", data: {} },
    });
    expect(completed?.kind).toBe("finding");

    for (const type of ["worker.run.failed", "worker.run.budget_exhausted", "run.cancelled"]) {
      const message = buildPacketAgentCoordinationMessage({
        ...BASE,
        event: { eventId: `evt_${type}`, type, data: {} },
      });
      expect(message?.kind).toBe("blocker");
      expect(message?.body).toContain("without success");
    }
  });

  it("maps raw journal attention spellings too", () => {
    const message = buildPacketAgentCoordinationMessage({
      ...BASE,
      event: { eventId: "evt_3", type: "run.approval-required", data: {} },
    });
    expect(message?.kind).toBe("blocker");
  });

  it("returns nothing for non-attention, non-terminal, or id-less events", () => {
    expect(
      buildPacketAgentCoordinationMessage({
        ...BASE,
        event: { eventId: "evt_4", type: "worker.run.progress", data: {} },
      }),
    ).toBeUndefined();
    expect(
      buildPacketAgentCoordinationMessage({
        ...BASE,
        event: { type: "worker.run.approval_required", data: {} },
      }),
    ).toBeUndefined();
  });
});
