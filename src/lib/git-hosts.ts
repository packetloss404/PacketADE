// G2: git-host provider catalog (GitHub cloud + Gitea/Forgejo self-hosted),
// the git-host analogue of `api-models.ts`'s provider catalog. Metadata only —
// connections + tokens live in the backend keyring; the frontend just needs
// display strings and a base-URL validator.

import type { GitHostKind } from "@/lib/tauri";

export interface GitHostMeta {
  kind: GitHostKind;
  name: string;
  /** Self-hosted hosts need a user-supplied base URL; cloud GitHub does not. */
  needsBaseUrl: boolean;
  tokenLabel: string;
  tokenHint: string;
}

export const GIT_HOSTS: Record<GitHostKind, GitHostMeta> = {
  github: {
    kind: "github",
    name: "GitHub",
    needsBaseUrl: false,
    tokenLabel: "Personal access token",
    tokenHint: "ghp_… with repo scope",
  },
  gitea: {
    kind: "gitea",
    name: "Gitea / Forgejo",
    needsBaseUrl: true,
    tokenLabel: "Access token",
    tokenHint: "Settings → Applications → Generate New Token (scope: repo, issue)",
  },
};

export type NormalizeResult = { value: string } | { error: string };

/**
 * Validate + normalize a Gitea/Forgejo instance base URL, mirroring the Rust
 * `git_host_add_gitea` check. Returns the bare origin (no trailing slash, no
 * `/api/v1` suffix) so the backend can append `/api/v1` itself, or an error.
 */
export function normalizeGiteaBaseUrl(input: string): NormalizeResult {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return { error: "Base URL is required" };
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: "Base URL must start with http:// or https://" };
  }
  // Accept a pasted API root and strip it back to the origin.
  const stripped = trimmed.replace(/\/api\/v1$/i, "");
  try {
    new URL(stripped);
  } catch {
    return { error: "Not a valid URL" };
  }
  return { value: stripped };
}
