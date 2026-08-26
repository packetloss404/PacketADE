/**
 * The PacketCode route's wiring.
 *
 * Two claims, and only two: the ACP engine gate stands in front of this route,
 * and it is invisible once the engine is ready — the pinned provider still
 * reaches `AgentsView` untouched. The gate's own behaviour is covered in
 * `components/agents/__tests__/PacketCodeEngineGate.test.tsx`; `AgentsView` is
 * stubbed here so this file tests the composition rather than re-mounting the
 * whole Agents surface.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

const harness = vi.hoisted(() => ({
  acpProbe: vi.fn(),
  acpInstallEngine: vi.fn(),
  agentsView: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  acpProbe: harness.acpProbe,
  acpInstallEngine: harness.acpInstallEngine,
  ACP_INSTALL_OUTPUT_EVENT: "acp:install-output",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/components/views/AgentsView", () => ({
  AgentsView: (props: { pinnedAgent?: string; pinnedModel?: string }) => {
    harness.agentsView(props);
    return <div data-testid="agents-view">agents view</div>;
  },
}));

import { PacketCodeView } from "@/components/views/PacketCodeView";
import { resetEngineProbeCache } from "@/components/agents/engineGateState";
import type { AcpEngineProbe } from "@/lib/tauri";

const READY: AcpEngineProbe = {
  found: true,
  version: "0.9.0",
  minimumVersion: "0.8.0",
  compatible: true,
  installSupported: true,
};

const MISSING: AcpEngineProbe = {
  found: false,
  minimumVersion: "0.8.0",
  compatible: false,
  installSupported: true,
};

beforeEach(() => {
  resetEngineProbeCache();
  harness.acpProbe.mockReset();
  harness.acpInstallEngine.mockReset();
  harness.agentsView.mockReset();
});

describe("PacketCodeView", () => {
  it("renders the pinned Agents view once the engine is ready", async () => {
    harness.acpProbe.mockResolvedValue(READY);
    render(<PacketCodeView />);

    await screen.findByTestId("agents-view");
    expect(harness.agentsView).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedAgent: "api-packetcode" }),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gates the route — and only this route — when the engine is missing", async () => {
    harness.acpProbe.mockResolvedValue(MISSING);
    render(<PacketCodeView />);

    await screen.findByText(/packetcode is not installed/i);
    // The pinned view is never mounted behind the gate.
    expect(harness.agentsView).not.toHaveBeenCalled();
    expect(screen.queryByTestId("agents-view")).toBeNull();
  });
});
