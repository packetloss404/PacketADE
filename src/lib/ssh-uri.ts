/**
 * Helpers for encoding/decoding the "ssh://<serverId>?path=<remotePath>" URI
 * scheme used by the Agents pane to represent a remote project. The URI is
 * stored in `agentTaskStore.selectedRepo` (a `string | null`) alongside local
 * filesystem paths — `isSshUri` is the discriminator.
 *
 * Before Phase 2 of the SSH consolidation, the URI was `ssh://<sshTargetId>`
 * (no remote path — the path was part of the `SshTarget` record itself).
 * After Phase 2 the remote path is per-conversation and the server id refers
 * to a `ServerConfig` entry in `serverStore`. The old shape (no `?path=`)
 * still parses for backward compatibility with persisted localStorage state.
 */

export const SSH_URI_PREFIX = "ssh://";

export interface ParsedSshUri {
  serverId: string;
  /** Optional remote project path. `undefined` for legacy URIs. */
  remotePath?: string;
}

export function makeSshUri(serverId: string, remotePath?: string): string {
  const base = `${SSH_URI_PREFIX}${serverId}`;
  if (!remotePath) return base;
  return `${base}?path=${encodeURIComponent(remotePath)}`;
}

export function isSshUri(value: string | null | undefined): boolean {
  return !!value && value.startsWith(SSH_URI_PREFIX);
}

/** Parse `ssh://<serverId>` or `ssh://<serverId>?path=<encoded>`. Returns
 *  null if the input is not an SSH URI. */
export function parseSshUri(value: string): ParsedSshUri | null {
  if (!isSshUri(value)) return null;
  const body = value.slice(SSH_URI_PREFIX.length);
  const queryIdx = body.indexOf("?");
  if (queryIdx === -1) return { serverId: body };
  const serverId = body.slice(0, queryIdx);
  const query = body.slice(queryIdx + 1);
  const params = new URLSearchParams(query);
  const remotePath = params.get("path") ?? undefined;
  return { serverId, remotePath: remotePath || undefined };
}

/** Back-compat alias: returns the server id only (matches the old API that
 *  returned an SshTarget id). New callers should prefer `parseSshUri`. */
export function parseSshServerId(value: string): string | null {
  return parseSshUri(value)?.serverId ?? null;
}
