import type { ServerConfig } from "@/types/server";

/** The SSH config shape the API-agent backend expects (snake_case wire form). */
export interface ResumeSshConfig {
  host: string;
  port: number;
  user: string;
  remote_path: string;
  key_path: string | null;
  auth_method: "agent" | "key" | "password" | null;
  target_id: string;
  host_fingerprint: string | null;
}

/** The persisted per-conversation SSH target (the display subset). */
export interface ConversationSshTarget {
  id: string;
  host: string;
  user: string;
  remotePath: string;
}

/**
 * S5: build the resume-time `SshConfig` for an API conversation.
 *
 * Connection identity — host, port, user, key, auth method, and the pinned host
 * fingerprint — is resolved from the LIVE `ServerConfig` (looked up by
 * `sshTarget.id`), so a server that was renamed or repointed since the
 * conversation was created resumes against its current address, not the stale
 * copy frozen into the conversation. When the server has been deleted we fall
 * back to the persisted host/user so the backend can still fail-fast on bad
 * creds (the right failure mode) rather than us silently doing nothing.
 *
 * `remote_path` is deliberately NOT taken from the server: it is the
 * conversation's own working directory on the remote (pinned per-conversation
 * at launch), which is independent of the server's default remote path.
 */
export function buildResumeSshConfig(
  sshTarget: ConversationSshTarget,
  server: ServerConfig | undefined,
): ResumeSshConfig {
  return {
    host: server?.host ?? sshTarget.host,
    port: server?.port ?? 22,
    user: server?.username ?? sshTarget.user,
    remote_path: sshTarget.remotePath,
    key_path: server?.keyPath ?? null,
    auth_method: server?.authMethod ?? null,
    target_id: sshTarget.id,
    host_fingerprint: server?.hostFingerprint ?? null,
  };
}
