import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@/types/server";

const mockSaveServersSlice = vi.hoisted(() => vi.fn());
const mockGetSshPasswordExists = vi.hoisted(() => vi.fn());
const mockLogSwallowedSink = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  getSshPasswordExists: mockGetSshPasswordExists,
  saveServersSlice: mockSaveServersSlice,
}));

vi.mock("@/lib/logSwallowed", () => ({
  logSwallowed: () => mockLogSwallowedSink,
}));

import { migrateSshTargetsToServers } from "@/lib/sshTargetMigration";
import { useServerStore } from "@/stores/serverStore";

const LEGACY_STORAGE_KEY = "packetbench:ssh-targets";
const LEGACY_PACKETCODE_KEY = "packetcode:ssh-targets";

function legacyTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-1",
    name: "Prod",
    host: "prod.example.com",
    port: 22,
    user: "ian",
    remotePath: "/srv/app",
    createdAt: 1,
    lastUsed: 2,
    ...overrides,
  };
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "legacy-1",
    name: "Prod",
    host: "prod.example.com",
    port: 22,
    username: "ian",
    authMethod: "agent",
    remotePath: "/srv/app",
    installedAgents: [],
    ...overrides,
  };
}

describe("migrateSshTargetsToServers", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    mockSaveServersSlice.mockReset();
    mockSaveServersSlice.mockResolvedValue(undefined);
    mockGetSshPasswordExists.mockReset();
    mockGetSshPasswordExists.mockResolvedValue(false);
    mockLogSwallowedSink.mockReset();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      connectionStates: {},
      knownHostsPath: null,
    });
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("preserves legacy localStorage keys when the server save fails", async () => {
    const legacy = [legacyTarget()];
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    mockSaveServersSlice.mockRejectedValueOnce(new Error("save failed"));

    const result = await migrateSshTargetsToServers();

    expect(result).toEqual({ migrated: 1, skipped: 0 });
    expect(mockSaveServersSlice).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "legacy-1",
        authMethod: "agent",
      }),
    ]);
    expect(useServerStore.getState().servers).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(JSON.stringify(legacy));
    expect(localStorage.getItem(LEGACY_PACKETCODE_KEY)).toBeNull();
  });

  it("preserves password auth intent when a legacy keyring password exists", async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacyTarget()]));
    mockGetSshPasswordExists.mockResolvedValueOnce(true);

    const result = await migrateSshTargetsToServers();

    expect(result).toEqual({ migrated: 1, skipped: 0 });
    expect(mockGetSshPasswordExists).toHaveBeenCalledWith("legacy-1");
    expect(mockSaveServersSlice).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "legacy-1",
        authMethod: "password",
      }),
    ]);
    expect(useServerStore.getState().servers[0]).toEqual(
      expect.objectContaining({
        id: "legacy-1",
        authMethod: "password",
      }),
    );
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("merges packetbench and packetcode legacy target namespaces before cleanup", async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacyTarget()]));
    localStorage.setItem(
      LEGACY_PACKETCODE_KEY,
      JSON.stringify([
        legacyTarget({
          id: "legacy-2",
          name: "Staging",
          host: "staging.example.com",
          user: "dev",
        }),
      ]),
    );

    const result = await migrateSshTargetsToServers();

    expect(result).toEqual({ migrated: 2, skipped: 0 });
    expect(mockSaveServersSlice).toHaveBeenCalledWith([
      expect.objectContaining({ id: "legacy-1", host: "prod.example.com" }),
      expect.objectContaining({ id: "legacy-2", host: "staging.example.com" }),
    ]);
    expect(useServerStore.getState().servers.map((s) => s.id)).toEqual(["legacy-1", "legacy-2"]);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_PACKETCODE_KEY)).toBeNull();
  });

  it("skips duplicate ids and is idempotent after confirmed save", async () => {
    const existing = server();
    useServerStore.setState({ servers: [existing] });
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacyTarget()]));

    const first = await migrateSshTargetsToServers();
    const second = await migrateSshTargetsToServers();

    expect(first).toEqual({ migrated: 0, skipped: 1 });
    expect(second).toEqual({ migrated: 0, skipped: 0 });
    expect(mockSaveServersSlice).toHaveBeenCalledTimes(1);
    expect(mockSaveServersSlice).toHaveBeenCalledWith([existing]);
    expect(mockGetSshPasswordExists).not.toHaveBeenCalled();
    expect(useServerStore.getState().servers).toEqual([existing]);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});
