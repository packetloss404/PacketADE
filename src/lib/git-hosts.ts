// G2: git-host provider catalog (GitHub cloud, Gitea/Forgejo self-hosted, and
// GitLab), the git-host analogue of `api-models.ts`'s provider catalog.
// Metadata only — connections + tokens live in the backend keyring; the
// frontend just needs display strings and a base-URL validator.

import type { GitHostKind } from "@/lib/tauri";

/** The always-present GitHub connection id (mirrors the Rust constant). */
export const GITHUB_CONNECTION_ID = "github";

export interface GitHostMeta {
  kind: GitHostKind;
  name: string;
  /** Self-hosted hosts need a user-supplied base URL; cloud GitHub does not. */
  needsBaseUrl: boolean;
  tokenLabel: string;
  tokenHint: string;
  /**
   * Placeholder for the base-URL field, when `needsBaseUrl`. GitLab takes the
   * *instance origin* for gitlab.com too — unlike GitHub there is no separate
   * API hostname, so `https://gitlab.com` is a normal, valid value here.
   */
  baseUrlPlaceholder?: string;
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
    baseUrlPlaceholder: "https://git.example.com",
  },
  gitlab: {
    kind: "gitlab",
    name: "GitLab",
    // gitlab.com AND self-hosted both go through this field: GitLab serves
    // /api/v4 under the instance origin in both cases.
    needsBaseUrl: true,
    tokenLabel: "Personal access token",
    tokenHint: "glpat-… with the api scope (Preferences → Access tokens)",
    baseUrlPlaceholder: "https://gitlab.com",
  },
};

/**
 * Per-host feature capabilities (the git-host analogue of `api-models.ts`'s
 * provider capability flags). Drives UI gating so GitHub-only surfaces don't
 * render broken on a Gitea/Forgejo workspace.
 */
export interface GitHostCapabilities {
  /** GraphQL draft ⇄ ready toggle (GitHub). Gitea uses a `WIP:` title prefix,
   *  GitLab a `Draft:` one — neither has a mutation to call. */
  draftPrToggle: boolean;
  /** Modern check-runs API. Gitea has combined commit status only; GitLab
   *  splits the concept into pipelines + commit statuses. */
  checkRuns: boolean;
  /** Typed Events activity feed. Neither other host has an equivalent. */
  activityFeed: boolean;
  /** Formal review objects listed per change request. GitLab has none. */
  prReviews: boolean;
  /** Author line-anchored review comments. Gitea's model is flat; GitLab's
   *  needs a three-SHA diff position hash. */
  inlineReviewComments: boolean;
  /** AI assist (investigate / PR description / review / catch-up / triage).
   *  These query api.github.com directly, so they're GitHub-only. */
  aiAssist: boolean;
  /** The notification inbox. GitLab's analogue is Todos, a different shape. */
  notifications: boolean;
  /** Requesting reviewers by username on an existing change request. */
  requestReviewers: boolean;
  /** Assigning issues by username. GitLab takes numeric `assignee_ids`. */
  assigneesByLogin: boolean;
  /** What this host calls a change request, for user-facing prose. */
  changeRequestNoun: "pull request" | "merge request";
}

// Mirrors `HostCapability` in `src-tauri/src/core/git_host.rs`. Both sides are
// exhaustive per-kind ALLOW-lists rather than "everything except Gitea"
// deny-lists: a deny-list silently admitted every host kind it had not been
// told about, which is how a GitLab workspace would have ended up firing the
// GitHub token at api.github.com.
export const GIT_HOST_CAPABILITIES: Record<GitHostKind, GitHostCapabilities> = {
  github: {
    draftPrToggle: true,
    checkRuns: true,
    activityFeed: true,
    prReviews: true,
    inlineReviewComments: true,
    aiAssist: true,
    notifications: true,
    requestReviewers: true,
    assigneesByLogin: true,
    changeRequestNoun: "pull request",
  },
  gitea: {
    draftPrToggle: false,
    checkRuns: false,
    activityFeed: false,
    prReviews: true,
    inlineReviewComments: false,
    aiAssist: false,
    notifications: true,
    requestReviewers: true,
    assigneesByLogin: true,
    changeRequestNoun: "pull request",
  },
  gitlab: {
    draftPrToggle: false,
    checkRuns: false,
    activityFeed: false,
    prReviews: false,
    inlineReviewComments: false,
    aiAssist: false,
    notifications: false,
    requestReviewers: false,
    assigneesByLogin: false,
    changeRequestNoun: "merge request",
  },
};

export function capabilitiesFor(kind: GitHostKind): GitHostCapabilities {
  return GIT_HOST_CAPABILITIES[kind];
}

/** Display name for a host kind (branding). */
export function hostLabel(kind: GitHostKind): string {
  return GIT_HOSTS[kind]?.name === "Gitea / Forgejo" ? "Gitea" : (GIT_HOSTS[kind]?.name ?? "GitHub");
}

export type NormalizeResult = { value: string } | { error: string };

/** The API-root suffix each self-hosted kind appends to its instance origin. */
const API_SUFFIX: Partial<Record<GitHostKind, RegExp>> = {
  gitea: /\/api\/v1$/i,
  gitlab: /\/api\/v4$/i,
};

/**
 * Validate + normalize a self-hosted instance base URL, mirroring the Rust
 * `git_host_add_connection` check. Returns the bare origin (no trailing slash,
 * no API-root suffix) so the backend can append the suffix itself, or an error.
 *
 * The same function serves gitlab.com and a self-hosted GitLab: GitLab has no
 * separate API hostname, so `https://gitlab.com` is a perfectly ordinary value
 * here — there is nothing to special-case.
 */
export function normalizeInstanceBaseUrl(kind: GitHostKind, input: string): NormalizeResult {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return { error: "Base URL is required" };
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: "Base URL must start with http:// or https://" };
  }
  // Accept a pasted API root and strip it back to the origin.
  const suffix = API_SUFFIX[kind];
  const stripped = suffix ? trimmed.replace(suffix, "") : trimmed;
  try {
    new URL(stripped);
  } catch {
    return { error: "Not a valid URL" };
  }
  return { value: stripped };
}

// `normalizeGiteaBaseUrl` used to live here as a Gitea-fixed alias of
// `normalizeInstanceBaseUrl`, documented as "kept so existing call sites
// (`GitHubSettingsCard`) keep compiling unchanged". That card stopped calling
// it when the guided wizard replaced its inline add-form — the wizard uses its
// descriptor's own `normalizeInstanceUrl` — leaving an exported helper whose
// only remaining callers were the tests written for it, under a comment that
// named a call site that no longer existed. Removed rather than re-documented:
// a kind-fixed wrapper is the shape that produced the GitLab gaps elsewhere in
// this file. Call `normalizeInstanceBaseUrl(kind, input)` instead.
