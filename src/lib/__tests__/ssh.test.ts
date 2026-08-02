import { describe, expect, it, vi } from "vitest";
import { buildSshArgs, buildSshExecArgs } from "@/lib/ssh";
import type { ServerConfig } from "@/types/server";

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "server-1",
    name: "Build host",
    host: "build.example.test",
    port: 22,
    username: "dev",
    authMethod: "agent",
    installedAgents: [],
    ...overrides,
  };
}

describe("SSH argument construction", () => {
  it("pins a saved fingerprint to the app-managed known_hosts file", () => {
    const args = buildSshArgs(
      server({ hostFingerprint: "SHA256:abc" }),
      "/repo",
      "codex",
      [],
      "C:/PacketADE/known_hosts",
    );

    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=C:/PacketADE/known_hosts");
    expect(args).not.toContain("StrictHostKeyChecking=accept-new");
  });

  it("uses accept-new for an unpinned legacy server", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const args = buildSshExecArgs(server(), "true", "C:/PacketADE/known_hosts");

    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("includes non-default port and key authentication arguments", () => {
    const args = buildSshExecArgs(
      server({
        port: 2222,
        authMethod: "key",
        keyPath: "C:/Keys/build key",
        hostFingerprint: "SHA256:abc",
      }),
      "uname -a",
      "C:/PacketADE/known_hosts",
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "-t",
        "-p",
        "2222",
        "-i",
        "C:/Keys/build key",
        "PreferredAuthentications=publickey",
      ]),
    );
  });

  it("does not allocate a PTY for password one-shot commands", () => {
    const args = buildSshExecArgs(
      server({ authMethod: "password", hostFingerprint: "SHA256:abc" }),
      "node --version",
      "C:/PacketADE/known_hosts",
    );

    expect(args).not.toContain("-t");
    expect(args).toContain("PreferredAuthentications=keyboard-interactive,password");
    expect(args).toContain("PubkeyAuthentication=no");
  });

  it("exports an isolated PacketCode home without allowing shell injection", () => {
    const args = buildSshArgs(
      server({ hostFingerprint: "SHA256:abc" }),
      "/repo with spaces",
      "packetcode",
      [],
      "C:/PacketADE/known_hosts",
      { PACKETCODE_HOME: "/srv/packet code/'isolated'" },
    );
    const remote = args[args.length - 1] ?? "";

    expect(remote).toContain("export PACKETCODE_HOME='/srv/packet code/'\\''isolated'\\''';");
    expect(remote).toContain("cd '/repo with spaces' && 'packetcode'");
  });

  it("rejects invalid remote environment variable names", () => {
    expect(() =>
      buildSshArgs(server(), "/repo", "packetcode", [], undefined, {
        "PACKETCODE_HOME; touch /tmp/pwned": "/safe",
      }),
    ).toThrow("Invalid remote environment variable name");
  });

  it("launches the remote host login shell when no remote command is requested", () => {
    const args = buildSshArgs(
      server({ hostFingerprint: "SHA256:abc" }),
      "/repo",
      null,
      undefined,
      "C:/PacketADE/known_hosts",
    );
    const remote = args[args.length - 1] ?? "";

    expect(remote).toContain("cd '/repo' && exec \"${SHELL:-/bin/sh}\" -l");
    expect(remote).not.toContain("powershell");
    expect(remote).not.toContain("bash");
  });
});
