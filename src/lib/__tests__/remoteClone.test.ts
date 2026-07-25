import { describe, it, expect, vi } from "vitest";

// buildRemoteCloneArgs uses toGitServerConfigInput; mock it to a passthrough so
// this stays a pure test with no Tauri runtime.
vi.mock("@/lib/tauri", () => ({
  toGitServerConfigInput: (s: { id: string; hostFingerprint?: string }) => ({
    id: s.id,
    hostFingerprint: s.hostFingerprint ?? null,
  }),
}));

import {
  buildRemoteCloneArgs,
  shouldOfferRemoteClone,
} from "@/lib/remoteClone";
import type { ServerConfig } from "@/types/server";

const server = {
  id: "srv-1",
  name: "prod",
  host: "h.test",
  port: 22,
  username: "ian",
  authMethod: "key",
  hostFingerprint: "SHA256:x",
} as ServerConfig;

describe("buildRemoteCloneArgs", () => {
  it("builds args when repo URL and dest are present", () => {
    const args = buildRemoteCloneArgs(server, "  https://git/repo.git ", " /srv/app ", "dev");
    expect(args).toEqual({
      serverId: "srv-1",
      serverConfig: { id: "srv-1", hostFingerprint: "SHA256:x" },
      repoUrl: "https://git/repo.git",
      destPath: "/srv/app",
      branch: "dev",
    });
  });

  it("returns null branch when branch is blank", () => {
    const args = buildRemoteCloneArgs(server, "u", "/d", "   ");
    expect(args?.branch).toBeNull();
  });

  it("returns null when repo URL is blank (nothing to clone)", () => {
    expect(buildRemoteCloneArgs(server, "   ", "/d")).toBeNull();
  });

  it("returns null when dest path is blank", () => {
    expect(buildRemoteCloneArgs(server, "u", "  ")).toBeNull();
  });

  it("returns null when the server is undefined", () => {
    expect(buildRemoteCloneArgs(undefined, "u", "/d")).toBeNull();
  });
});

describe("shouldOfferRemoteClone", () => {
  it("offers when the path does not exist", () => {
    expect(shouldOfferRemoteClone(false, false)).toBe(true);
  });
  it("offers when the path exists but is not a git repo", () => {
    expect(shouldOfferRemoteClone(true, false)).toBe(true);
  });
  it("does not offer when the path is already a git repo", () => {
    expect(shouldOfferRemoteClone(true, true)).toBe(false);
  });
  it("does not offer for an unknown probe state", () => {
    expect(shouldOfferRemoteClone(undefined, undefined)).toBe(false);
  });
});
