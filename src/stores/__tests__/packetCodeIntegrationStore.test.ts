import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

const STORAGE_KEY = storageKey("packetcode-integration");

async function loadStore() {
  vi.resetModules();
  return import("../packetCodeIntegrationStore");
}

describe("packetCodeIntegrationStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists executable-independent integration settings", async () => {
    const { usePacketCodeIntegrationStore } = await loadStore();
    const store = usePacketCodeIntegrationStore.getState();

    store.setLocalDataHome("D:\\PacketCodeData");
    store.setDeveloperRepoPath("D:\\projects\\packetcode");
    store.setReleaseChannel("preview");
    store.setRemoteDataHome("server-1", "/srv/packetcode/data");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      localDataHome: "D:\\PacketCodeData",
      developerRepoPath: "D:\\projects\\packetcode",
      releaseChannel: "preview",
      remoteDataHomes: { "server-1": "/srv/packetcode/data" },
    });
  });

  it("hydrates defensively and drops malformed remote paths", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        localDataHome: "C:\\data",
        developerRepoPath: 42,
        releaseChannel: "nightly",
        remoteDataHomes: { good: "/srv/data", bad: 42, "": "/ignored" },
      }),
    );
    const { usePacketCodeIntegrationStore } = await loadStore();

    expect(usePacketCodeIntegrationStore.getState()).toMatchObject({
      localDataHome: "C:\\data",
      developerRepoPath: "",
      releaseChannel: "stable",
      remoteDataHomes: { good: "/srv/data" },
    });
  });

  it("validates Windows, UNC, and POSIX absolute homes by target platform", async () => {
    const { isAbsolutePacketCodePath } = await loadStore();

    expect(isAbsolutePacketCodePath("D:\\PacketCodeData", "windows")).toBe(true);
    expect(isAbsolutePacketCodePath("\\\\server\\share\\packetcode", "windows")).toBe(
      true,
    );
    expect(isAbsolutePacketCodePath("/srv/packetcode", "posix")).toBe(true);
    expect(isAbsolutePacketCodePath("relative/data", "either")).toBe(false);
    expect(isAbsolutePacketCodePath("/srv/packetcode", "windows")).toBe(false);
  });
});
