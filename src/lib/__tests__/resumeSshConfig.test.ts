import { describe, it, expect } from "vitest";
import { buildResumeSshConfig } from "@/lib/resumeSshConfig";
import type { ServerConfig } from "@/types/server";

const sshTarget = {
  id: "srv-1",
  host: "old-host.test",
  user: "olduser",
  remotePath: "/home/olduser/projects/app",
};

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "srv-1",
    name: "prod",
    host: "new-host.test",
    port: 2222,
    username: "newuser",
    authMethod: "key",
    keyPath: "~/.ssh/id_ed25519",
    remotePath: "/srv/default",
    hostFingerprint: "SHA256:live",
    ...overrides,
  } as ServerConfig;
}

describe("buildResumeSshConfig", () => {
  it("resolves host/user/port/key/fingerprint from the live server", () => {
    const cfg = buildResumeSshConfig(sshTarget, server());
    expect(cfg.host).toBe("new-host.test"); // repointed → new host, not stale
    expect(cfg.user).toBe("newuser");
    expect(cfg.port).toBe(2222);
    expect(cfg.key_path).toBe("~/.ssh/id_ed25519");
    expect(cfg.auth_method).toBe("key");
    expect(cfg.host_fingerprint).toBe("SHA256:live");
    expect(cfg.target_id).toBe("srv-1");
  });

  it("keeps the conversation's own remote_path, not the server default", () => {
    const cfg = buildResumeSshConfig(sshTarget, server());
    expect(cfg.remote_path).toBe("/home/olduser/projects/app");
  });

  it("falls back to persisted host/user when the server was deleted", () => {
    const cfg = buildResumeSshConfig(sshTarget, undefined);
    expect(cfg.host).toBe("old-host.test");
    expect(cfg.user).toBe("olduser");
    expect(cfg.port).toBe(22);
    expect(cfg.key_path).toBeNull();
    expect(cfg.auth_method).toBeNull();
    expect(cfg.host_fingerprint).toBeNull();
    expect(cfg.remote_path).toBe("/home/olduser/projects/app");
  });

  it("carries a null fingerprint for a legacy server without one", () => {
    const cfg = buildResumeSshConfig(sshTarget, server({ hostFingerprint: undefined }));
    expect(cfg.host_fingerprint).toBeNull();
  });
});
