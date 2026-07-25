// G3: per-workspace git-host resolution. Given a repo's `origin` remote URL and
// the configured connections, decide which host (GitHub cloud or a Gitea/Forgejo
// instance) that workspace belongs to — so the pane targets the right API and
// shows the right branding. Pure + testable; the store calls it when the active
// project changes.

import type { GitHostConnectionInfo } from "@/lib/tauri";

/**
 * Extract the host (authority) from a git remote URL, handling both HTTPS
 * (`https://host/owner/repo.git`) and scp-like SSH (`git@host:owner/repo.git`)
 * forms. Returns a lowercased host, or null if unparseable.
 */
export function remoteHost(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;
  // scp-like: [user@]host:owner/repo(.git)
  const scp = url.match(/^(?:[^@/]+@)?([^:/@]+):[^/]/);
  if (scp && !url.includes("://")) return scp[1].toLowerCase();
  try {
    // hostname (not host) — ignore any port so an SSH remote (no HTTP port)
    // still matches a connection whose base URL carries one (e.g. :3000).
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The remote host a configured connection owns. */
export function connectionHost(c: Pick<GitHostConnectionInfo, "kind" | "baseUrl">): string {
  // GitHub's API base is api.github.com, but repos live on github.com.
  if (c.kind === "github") return "github.com";
  return remoteHost(c.baseUrl) ?? "";
}

export interface ResolvedConnection {
  /** Matching connection id, or null when no configured host owns the remote. */
  connectionId: string | null;
  /** True when more than one connection matched (first is returned). */
  ambiguous: boolean;
}

/**
 * Resolve which configured connection a repo's `origin` remote belongs to.
 * `github.com` (and subdomains) → the GitHub connection; a host matching a
 * configured Gitea `baseUrl` → that Gitea connection.
 */
export function resolveConnectionForRemote(
  originUrl: string | null | undefined,
  connections: GitHostConnectionInfo[],
): ResolvedConnection {
  const host = originUrl ? remoteHost(originUrl) : null;
  if (!host) return { connectionId: null, ambiguous: false };

  const matches = connections.filter((c) => {
    const chost = connectionHost(c);
    if (!chost) return false;
    if (c.kind === "github") return host === "github.com" || host.endsWith(".github.com");
    return host === chost;
  });

  if (matches.length === 0) return { connectionId: null, ambiguous: false };
  return { connectionId: matches[0].id, ambiguous: matches.length > 1 };
}
