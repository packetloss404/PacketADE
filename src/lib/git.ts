/**
 * v0.8-15: small git helpers used in the renderer. The canonical
 * implementation lives in `src-tauri/src/core/git.rs::parse_github_remote`
 * — this TS sibling exists so workspace creation can synchronously
 * parse the remote URL once the Tauri command returns the raw string,
 * without an extra round trip.
 *
 * Keep both in sync. The Rust side has unit tests; the TS side is
 * trivial enough that we mirror behaviour exactly.
 */

/**
 * Parse a GitHub remote URL into `(owner, repo)`. Accepts the three
 * shapes git typically emits:
 *
 *   - `git@github.com:owner/repo.git`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *
 * Trailing `.git` and a trailing slash are stripped. Anything that
 * doesn't match a GitHub host or lacks the `owner/repo` shape returns
 * `null` so callers can silently skip auto-binding for non-GitHub
 * remotes.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const prefixes = [
    "git@github.com:",
    "ssh://git@github.com/",
    "https://github.com/",
    "http://github.com/",
    "git://github.com/",
  ];

  let afterHost: string | null = null;
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      afterHost = trimmed.slice(prefix.length);
      break;
    }
  }
  if (afterHost == null) return null;

  // Strip optional `.git` suffix and a trailing slash.
  let stripped = afterHost.replace(/\/+$/, "");
  if (stripped.endsWith(".git")) {
    stripped = stripped.slice(0, -".git".length);
  }

  const parts = stripped.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}
