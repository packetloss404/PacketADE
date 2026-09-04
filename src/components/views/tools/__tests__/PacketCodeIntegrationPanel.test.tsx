import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PacketCodeIntegrationPanel, type PacketCodeInstallReport } from "../PacketCodeIntegrationPanel";
import { usePacketCodeIntegrationStore } from "@/stores/packetCodeIntegrationStore";
import { useServerStore } from "@/stores/serverStore";
import type { PacketCodeInstallationInspection } from "@/lib/tauri";

const installerPath = "C:\\Users\\ian\\AppData\\Local\\Programs\\PacketCode\\bin\\packetcode.exe";
const overridePath = "D:\\tools\\packetcode.exe";

function inspection(
  overrides: Partial<PacketCodeInstallationInspection> = {},
): PacketCodeInstallationInspection {
  return {
    installerExecutablePath: installerPath,
    installerVersion: "packetcode v0.6.0",
    activeExecutablePath: overridePath,
    activeVersion: "packetcode v0.5.1",
    activeSource: "settings",
    workspaceUsesInstaller: false,
    ...overrides,
  };
}

describe("PacketCodeIntegrationPanel install outcome", () => {
  beforeEach(() => {
    useServerStore.setState({ servers: [] });
    usePacketCodeIntegrationStore.setState({
      localDataHome: "",
      developerRepoPath: "",
      releaseChannel: "stable",
      remoteDataHomes: {},
    });
  });

  it("reports the exact installed version and warns when Workspace still uses an override", () => {
    const onPinExecutable = vi.fn().mockResolvedValue(undefined);
    const before = inspection({ installerVersion: "packetcode v0.5.0" });
    const after = inspection();
    const report: PacketCodeInstallReport = {
      status: "success",
      channel: "stable",
      before,
      after,
    };

    render(
      <PacketCodeIntegrationPanel
        detection={{
          id: "packetcode",
          installed: true,
          path: overridePath,
          version: after.activeVersion,
          source: "settings",
        }}
        manualPath={overridePath}
        installing={false}
        inspection={after}
        installReport={report}
        onPinExecutable={onPinExecutable}
        onInstall={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue(overridePath)).toBeInTheDocument();
    expect(screen.getByText(/packetcode v0\.5\.0/)).toBeInTheDocument();
    expect(screen.getByText(`Installed: ${installerPath}`)).toBeInTheDocument();
    expect(screen.getByText(/Workspace still launches/)).toHaveTextContent(overridePath);

    fireEvent.click(screen.getByRole("button", { name: "Use installed binary in Workspace" }));
    expect(onPinExecutable).toHaveBeenCalledWith(installerPath);
  });

  it("confirms when the installer target is already the active Workspace binary", () => {
    const active = inspection({
      activeExecutablePath: installerPath,
      activeVersion: "packetcode v0.6.0",
      activeSource: "installerLocation",
      workspaceUsesInstaller: true,
    });

    render(
      <PacketCodeIntegrationPanel
        detection={{
          id: "packetcode",
          installed: true,
          path: installerPath,
          version: active.activeVersion,
          source: "installerLocation",
        }}
        manualPath={null}
        installing={false}
        inspection={active}
        installReport={{
          status: "success",
          channel: "preview",
          before: inspection({ installerVersion: "packetcode v0.5.1" }),
          after: active,
        }}
        onPinExecutable={vi.fn()}
        onInstall={vi.fn()}
      />,
    );

    expect(screen.getByText("Workspace will launch this exact binary.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use installed binary in Workspace" })).toBeNull();
  });
});
