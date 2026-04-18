export interface SshTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  remotePath: string;
  keyPath?: string;
  createdAt: number;
  lastUsed: number | null;
}

export const SSH_URI_PREFIX = "ssh://";

export function makeSshUri(targetId: string): string {
  return `${SSH_URI_PREFIX}${targetId}`;
}

export function isSshUri(value: string | null | undefined): boolean {
  return !!value && value.startsWith(SSH_URI_PREFIX);
}

export function parseSshTargetId(value: string): string | null {
  return isSshUri(value) ? value.slice(SSH_URI_PREFIX.length) : null;
}

export function describeSshTarget(t: SshTarget): string {
  return `${t.user}@${t.host}${t.port === 22 ? "" : `:${t.port}`}:${t.remotePath}`;
}
