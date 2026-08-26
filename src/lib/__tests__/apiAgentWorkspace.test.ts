import { beforeEach, describe, expect, it, vi } from "vitest";
import { startApiAgentSession, type SshConfigInput } from "@/lib/tauri";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("startApiAgentSession workspace metadata", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  it("marks local launches as local workspaces", async () => {
    await startApiAgentSession(
      "conv-local",
      "openai",
      "gpt-5",
      "D:/projects/PacketADE",
      "hello",
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "start_api_agent_session",
      expect.objectContaining({
        projectPath: "D:/projects/PacketADE",
        sshConfig: null,
        workspace: {
          kind: "local",
          projectPath: "D:/projects/PacketADE",
        },
      }),
    );
  });

  it("sends SSH workspace metadata separately from projectPath", async () => {
    const sshConfig: SshConfigInput = {
      host: "example.com",
      port: 2222,
      user: "ian",
      remote_path: "/srv/packetbench",
      key_path: "C:/Users/ian/.ssh/id_ed25519",
      auth_method: "key",
      target_id: "srv-123",
      host_fingerprint: "SHA256:abc123",
    };

    await startApiAgentSession(
      "conv-ssh",
      "openai-codex",
      "gpt-5-codex",
      "/srv/packetbench",
      "hello",
      null,
      false,
      undefined,
      false,
      sshConfig,
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "start_api_agent_session",
      expect.objectContaining({
        projectPath: "/srv/packetbench",
        sshConfig,
        workspace: {
          kind: "ssh",
          serverId: "srv-123",
          host: "example.com",
          port: 2222,
          user: "ian",
          remotePath: "/srv/packetbench",
          keyPath: "C:/Users/ian/.ssh/id_ed25519",
          authMethod: "key",
          hostFingerprint: "SHA256:abc123",
        },
      }),
    );
  });
});
