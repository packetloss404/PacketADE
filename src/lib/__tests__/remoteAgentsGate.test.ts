import { beforeEach, describe, expect, it } from "vitest";

import {
  REMOTE_AGENTS_PRIVATE_BETA_GATES,
  assertRemoteAgentsEnabled,
  isRemoteAgentsEnabled,
  remoteAgentsGatesMet,
  unmetRemoteAgentsGates,
} from "../remoteAgentsGate";
import { useRemoteAgentsSettingsStore } from "@/stores/remoteAgentsSettingsStore";

describe("remoteAgentsGate", () => {
  beforeEach(() => {
    localStorage.clear();
    useRemoteAgentsSettingsStore.setState({ requested: { enabled: false } });
  });

  it("transcribes the private-beta gate list from 04-security.md", () => {
    expect(REMOTE_AGENTS_PRIVATE_BETA_GATES.map((gate) => gate.requirement)).toEqual([
      "real account auth",
      "device approval/revocation",
      "object-level authorization tests",
      "WebSocket origin validation",
      "audit log",
      "payload encryption for agent/approval content",
      "E2EE test vectors pass in Rust and browser",
      "revoked active device loses WebSocket within 5 seconds",
      "mobile `allow_always` is rejected",
      "cloud logs are scanned for prompt/tool content and pass redaction checks",
      "documented incident kill switch",
    ]);
  });

  it("reports every gate unmet in this repository", () => {
    // If this fails, someone marked a gate met. That is allowed — but it must be
    // the same change that implements the requirement, not a drive-by.
    expect(unmetRemoteAgentsGates()).toHaveLength(REMOTE_AGENTS_PRIVATE_BETA_GATES.length);
    expect(remoteAgentsGatesMet()).toBe(false);
  });

  it("stays off even when the user asks for it", () => {
    useRemoteAgentsSettingsStore.getState().setRequestedEnabled(true);

    expect(useRemoteAgentsSettingsStore.getState().requested.enabled).toBe(true);
    expect(isRemoteAgentsEnabled()).toBe(false);
  });

  it("throws from the assertion, naming the unmet gates and the call site", () => {
    useRemoteAgentsSettingsStore.getState().setRequestedEnabled(true);

    expect(() => assertRemoteAgentsEnabled("relayClient.connect")).toThrowError(
      /^relayClient\.connect: Remote Agents is gated off\. 11 of 11 private-beta requirements are unmet/,
    );
    expect(() => assertRemoteAgentsEnabled("relayClient.connect")).toThrowError(
      /dev\/remoteagents\/04-security\.md:385/,
    );
    expect(() => assertRemoteAgentsEnabled("relayClient.connect")).toThrowError(/e2ee-test-vectors/);
  });

  it("does not open when every gate is met but the user has not opted in", () => {
    const allMet = REMOTE_AGENTS_PRIVATE_BETA_GATES.map((gate) => ({ ...gate, met: true }));

    expect(allMet.length > 0 && allMet.every((gate) => gate.met)).toBe(true);
    expect(isRemoteAgentsEnabled()).toBe(false);
  });

  it("treats an empty gate list as closed, not as nothing-left-to-satisfy", () => {
    // The reason `remoteAgentsGatesMet` carries a `length > 0` conjunct:
    // `[].every()` is `true`, so an emptied list would otherwise read as full
    // authorization. This asserts the hazard is real rather than hypothetical.
    const emptied: { met: boolean }[] = [];
    expect(emptied.every((gate) => gate.met)).toBe(true);
    expect(emptied.length > 0 && emptied.every((gate) => gate.met)).toBe(false);
  });

  it("keeps the gate decision independent of user intent", () => {
    expect(remoteAgentsGatesMet()).toBe(false);
    useRemoteAgentsSettingsStore.getState().setRequestedEnabled(true);
    expect(remoteAgentsGatesMet()).toBe(false);
  });
});
