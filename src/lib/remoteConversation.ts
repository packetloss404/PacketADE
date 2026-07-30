import { useServerStore } from "@/stores/serverStore";
import type { AgentSshConfigInput } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";

/**
 * D3 (audit finding P0-4) — the single source of truth for "this
 * conversation's filesystem is NOT this machine's filesystem".
 *
 * SSH-backed conversations run their tools on a remote host, so every
 * disk-backed affordance in the app (Markdown Preview, applied-file Review,
 * Undo-on-disk, editor/file open) would silently operate on the LOCAL
 * filesystem at a path that only exists remotely. Until a remote-aware file
 * contract lands, those surfaces are disabled — with this tooltip so the
 * capability stays discoverable — rather than hidden or, worse, wrong.
 */
export const REMOTE_UNSUPPORTED_TOOLTIP = "Not yet available for SSH workspaces";

/** The remote-detection subset of a conversation. Deliberately structural so
 * callers can pass partial/derived records (and tests can pass literals). */
export type RemoteAwareConversation = Pick<AgentConversation, "sshTarget">;

/**
 * True when this conversation's tool calls execute on a remote SSH host.
 *
 * `sshTarget` is stamped at launch (`createApiConversation`) from the picked
 * `ServerConfig` and is the ONLY remote marker persisted on a conversation —
 * `projectPath` is the REMOTE path for these conversations, which is exactly
 * why local path operations must not be offered.
 */
export function isRemoteConversation(
  conversation: RemoteAwareConversation | null | undefined,
): boolean {
  return Boolean(conversation?.sshTarget);
}

/**
 * Rebuild the full launch-time SSH input for a conversation so a derived
 * conversation (Plan handoff, /new, /review) inherits the SAME remote
 * execution identity instead of silently becoming a local session pointed at
 * a remote-only path.
 *
 * Connection identity is resolved from the LIVE `ServerConfig` (same rule as
 * `buildResumeSshConfig`) so a renamed/repointed server is honored, while
 * `remotePath` stays the conversation's own remote working directory.
 *
 * Returns `null` for local conversations, and also when the server record is
 * gone — a deleted server leaves us with no port/key/auth-method/fingerprint,
 * and inventing them would mean launching with TOFU host-key checking. Callers
 * must treat `null` on a remote conversation as "cannot derive; disable".
 */
export function inheritSshTarget(
  conversation: RemoteAwareConversation,
): AgentSshConfigInput | null {
  const target = conversation.sshTarget;
  if (!target) return null;
  const server = useServerStore.getState().getServer(target.id);
  if (!server) return null;
  return {
    serverId: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    user: server.username,
    remotePath: target.remotePath,
    keyPath: server.keyPath ?? null,
    authMethod: server.authMethod,
    hostFingerprint: server.hostFingerprint ?? null,
  };
}
