/**
 * D3 (audit finding P0-4) — remote-detection contract.
 *
 * `isRemoteConversation` is THE single check every local-only surface gates
 * on, and `inheritSshTarget` is how derived conversations (Plan handoff,
 * /new, /review) keep the parent's remote execution identity instead of
 * silently becoming local sessions pointed at a remote-only path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveServersSlice: vi.fn(),
}));

import {
  inheritSshTarget,
  isRemoteConversation,
  REMOTE_UNSUPPORTED_TOOLTIP,
} from "@/lib/remoteConversation";
import { useServerStore } from "@/stores/serverStore";
import type { ServerConfig } from "@/types/server";

const SSH_TARGET = {
  id: "srv-1",
  name: "old name",
  host: "old.example.com",
  user: "olduser",
  remotePath: "/home/ian/proj",
};

const SERVER: ServerConfig = {
  id: "srv-1",
  name: "build box",
  host: "10.0.0.5",
  port: 2222,
  username: "ian",
  authMethod: "key",
  keyPath: "/home/ian/.ssh/id_ed25519",
  remotePath: "/srv/default",
  installedAgents: [],
  hostFingerprint: "SHA256:abc",
};

beforeEach(() => {
  useServerStore.setState({ servers: [], activeServerId: null });
});

describe("isRemoteConversation", () => {
  it("is false for local conversations and undefined/null records", () => {
    expect(isRemoteConversation({})).toBe(false);
    expect(isRemoteConversation(undefined)).toBe(false);
    expect(isRemoteConversation(null)).toBe(false);
  });

  it("is true whenever an sshTarget is stamped on the conversation", () => {
    expect(isRemoteConversation({ sshTarget: SSH_TARGET })).toBe(true);
  });

  it("exports one shared tooltip so every gated control says the same thing", () => {
    expect(REMOTE_UNSUPPORTED_TOOLTIP).toBe("Not yet available for SSH workspaces");
  });
});

describe("inheritSshTarget", () => {
  it("returns null for a local conversation (derived conversations stay local)", () => {
    expect(inheritSshTarget({})).toBeNull();
  });

  it("rebuilds the launch input from the LIVE server record, keeping the conversation's remote path", () => {
    useServerStore.setState({ servers: [SERVER] });

    expect(inheritSshTarget({ sshTarget: SSH_TARGET })).toEqual({
      serverId: "srv-1",
      name: "build box",
      host: "10.0.0.5",
      port: 2222,
      user: "ian",
      // NOT the server's default remotePath — the conversation's own cwd.
      remotePath: "/home/ian/proj",
      keyPath: "/home/ian/.ssh/id_ed25519",
      authMethod: "key",
      hostFingerprint: "SHA256:abc",
    });
  });

  it("returns null when the server record is gone rather than inventing an unpinned target", () => {
    // No server in the store: port/key/auth-method/fingerprint are unknown, and
    // guessing them would silently downgrade host-key checking to TOFU.
    expect(inheritSshTarget({ sshTarget: SSH_TARGET })).toBeNull();
  });
});
