import { describe, expect, it } from "vitest";
import {
  getCliCatalogEntry,
  packetCodeInstallCommand,
} from "@/lib/cli-catalog";

describe("PacketCode CLI catalog integration", () => {
  it("is installable on Windows and POSIX instead of browse-only", () => {
    const entry = getCliCatalogEntry("packetcode");

    expect(entry?.browseRequired).not.toBe(true);
    expect(entry?.installCommand).toContain("install.sh");
    expect(entry?.installCommandWindows).toContain("install.ps1");
  });

  it("keeps stable and preview release channels explicit", () => {
    expect(packetCodeInstallCommand("stable", true)).not.toContain("prerelease");
    expect(packetCodeInstallCommand("preview", true)).toContain("prerelease");
    expect(packetCodeInstallCommand("stable", false)).not.toContain(
      "api.github.com",
    );
    expect(packetCodeInstallCommand("preview", false)).toContain(
      "api.github.com",
    );
  });
});
