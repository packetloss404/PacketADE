// Guided git-host setup: the per-host DESCRIPTOR that drives the wizard, plus
// the pure logic the wizard is built out of (URL normalisation, step
// derivation, scope sufficiency, verdict copy).
//
// The wizard component contains no per-host branches. Everything a host needs
// to differ on — whether it has an instance URL, what the API prefix is, which
// scopes matter and why, where you create a token, how the credential is
// validated, how the connection is persisted — lives in a descriptor here.
// Supporting another forge is one entry appended to `GIT_HOST_WIZARD_DESCRIPTORS`.
//
// Deliberately an ARRAY, not a `Record<GitHostKind, …>`: a new `GitHostKind`
// added elsewhere must not break this module's compile, and a descriptor may
// describe a host the backend connection model cannot represent yet (see
// `unsupported`).
//
// SECURITY: nothing in this module stores, returns, or formats a token. The
// token is a parameter to `save` and to the probe request, and lives nowhere
// else. See `gitHostProbe.ts` for the transport contract.

import type { GitHostKind } from "@/lib/tauri";
import { githubSetToken, gitHostAddConnection, gitHostAddGitea } from "@/lib/tauri";
import { GITHUB_CONNECTION_ID } from "@/lib/git-hosts";
import type { GitHostProbeOutcome, GitHostProbeResult } from "@/lib/gitHostProbe";

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

export interface GitHostScopeRequirement {
  /** The scope exactly as the host names it (`repo`, `read:org`, `api`). */
  id: string;
  /** Why PacketBench needs it — shown next to the scope, one line. */
  reason: string;
  /** Optional scopes unlock extras; their absence never blocks the wizard. */
  optional?: boolean;
}

/** How the credential is checked before anything is written to the keyring. */
export interface GitHostProbeSpec {
  /** e.g. `/api/v1` (Gitea), `/api/v4` (GitLab), `""` for api.github.com. */
  apiPrefix: string;
  /** Endpoint returning the authenticated account. */
  identityPath: string;
  authScheme: "bearer" | "token" | "private-token";
  accept?: string;
  /** Response header listing granted scopes, when the host reports them. */
  scopeHeader?: string;
  /**
   * Endpoint reporting the credential's own scopes, for hosts that expose them
   * as a resource rather than a response header. GitLab serves
   * `/personal_access_tokens/self`. Only consulted when `scopeHeader` did not
   * answer, and only after identity succeeded — so a host is never asked twice
   * for a credential it already rejected. A failure here degrades to
   * "scopes unknown", never to a rejection.
   */
  scopePath?: string;
  /** JSON field on the `scopePath` response holding the scope array. Default `scopes`. */
  scopeField?: string;
  /** JSON fields that may carry the account name, in priority order. */
  loginFields: string[];
}

/** How a validated credential becomes a persisted connection. */
export interface GitHostSaveInput {
  /** Normalised origin — empty string for hosts with a fixed base URL. */
  baseUrl: string;
  /** User-chosen display label (may be empty; the backend falls back). */
  label: string;
  token: string;
}

export interface GitHostWizardDescriptor {
  /** Stable descriptor id. Also the radio value in step 1. */
  id: string;
  /** The backend connection kind, or `null` when the model can't express it. */
  kind: GitHostKind | null;
  label: string;
  /** One line under the label in the host picker. */
  blurb: string;
  /** Self-hosted hosts need an instance URL step; cloud hosts skip it. */
  needsInstanceUrl: boolean;
  /** Base URL used when `needsInstanceUrl` is false. */
  fixedBaseUrl?: string;
  instanceUrlPlaceholder?: string;
  /** Path suffixes stripped from a pasted URL during normalisation. */
  strippableApiPaths: string[];
  tokenLabel: string;
  tokenPlaceholder: string;
  /** Where the token is created. Given the normalised origin when there is one. */
  tokenCreateUrl: (origin: string | null) => string | null;
  /** Human directions for finding the token page on this host. */
  tokenCreateHint: string;
  scopes: GitHostScopeRequirement[];
  probe: GitHostProbeSpec;
  /**
   * Persist the validated credential. Runs only after a green probe. Must route
   * the token straight to an existing keyring-backed Tauri command.
   */
  save: (input: GitHostSaveInput) => Promise<{ connectionId: string }>;
  /**
   * Set when the backend connection model cannot represent this host yet. The
   * option renders, disabled, with this text — so "can I use GitHub
   * Enterprise?" gets an answer instead of a missing menu item.
   */
  unsupported?: string;
}

const GITHUB_DESCRIPTOR: GitHostWizardDescriptor = {
  id: "github",
  kind: "github",
  label: "GitHub",
  blurb: "github.com — the hosted service.",
  needsInstanceUrl: false,
  fixedBaseUrl: "https://api.github.com",
  strippableApiPaths: [],
  tokenLabel: "Personal access token",
  tokenPlaceholder: "ghp_…",
  tokenCreateUrl: () => "https://github.com/settings/tokens/new",
  tokenCreateHint: "GitHub → Settings → Developer settings → Personal access tokens.",
  scopes: [
    { id: "repo", reason: "Read repositories, issues, and pull requests, and open PRs." },
    { id: "read:org", reason: "Resolve org-owned repositories and assignees.", optional: true },
    { id: "notifications", reason: "Show the notification inbox.", optional: true },
  ],
  probe: {
    apiPrefix: "",
    identityPath: "/user",
    authScheme: "bearer",
    accept: "application/vnd.github+json",
    scopeHeader: "x-oauth-scopes",
    loginFields: ["login", "name"],
  },
  save: async ({ token }) => {
    // The singleton GitHub connection: one keyring entry, fixed id.
    await githubSetToken(token);
    return { connectionId: GITHUB_CONNECTION_ID };
  },
};

const GITHUB_ENTERPRISE_DESCRIPTOR: GitHostWizardDescriptor = {
  id: "github-enterprise",
  kind: null,
  label: "GitHub Enterprise Server",
  blurb: "Self-hosted GitHub.",
  needsInstanceUrl: true,
  instanceUrlPlaceholder: "https://github.example.com",
  strippableApiPaths: ["/api/v3", "/api"],
  tokenLabel: "Personal access token",
  tokenPlaceholder: "ghp_…",
  tokenCreateUrl: (origin) => (origin ? `${origin}/settings/tokens/new` : null),
  tokenCreateHint: "Your instance → Settings → Developer settings → Personal access tokens.",
  scopes: [{ id: "repo", reason: "Read repositories, issues, and pull requests." }],
  probe: {
    apiPrefix: "/api/v3",
    identityPath: "/user",
    authScheme: "bearer",
    accept: "application/vnd.github+json",
    scopeHeader: "x-oauth-scopes",
    loginFields: ["login", "name"],
  },
  save: async () => {
    throw new Error("GitHub Enterprise Server connections are not supported yet.");
  },
  // The backend's GitHub connection is a singleton pinned to api.github.com
  // (`GITHUB_CONNECTION_ID`, no configurable base URL), so there is nowhere to
  // put an Enterprise origin. Say so rather than offering a dead-end flow.
  unsupported:
    "PacketBench's GitHub connection is fixed to github.com — an Enterprise Server base URL cannot be stored yet.",
};

const GITEA_DESCRIPTOR: GitHostWizardDescriptor = {
  id: "gitea",
  kind: "gitea",
  label: "Gitea / Forgejo",
  blurb: "Self-hosted. Also covers Codeberg.",
  needsInstanceUrl: true,
  instanceUrlPlaceholder: "https://git.example.com",
  strippableApiPaths: ["/api/v1", "/api"],
  tokenLabel: "Access token",
  tokenPlaceholder: "Access token",
  tokenCreateUrl: (origin) => (origin ? `${origin}/user/settings/applications` : null),
  tokenCreateHint:
    "Your instance → Settings → Applications → Generate New Token, then tick the scopes below.",
  scopes: [
    { id: "read:repository", reason: "List repositories and read their metadata." },
    { id: "write:repository", reason: "Open and update pull requests." },
    { id: "read:issue", reason: "Read issues and comments." },
    { id: "write:issue", reason: "Comment on and update issues.", optional: true },
    { id: "read:user", reason: "Confirm which account the token belongs to." },
  ],
  probe: {
    apiPrefix: "/api/v1",
    identityPath: "/user",
    authScheme: "token",
    accept: "application/json",
    // Gitea does not report a token's scopes on any response header, so the
    // wizard says "couldn't verify" rather than inventing a green tick.
    loginFields: ["login", "username", "full_name"],
  },
  save: async ({ baseUrl, label, token }) => {
    const connectionId = await gitHostAddGitea(baseUrl, label, token);
    return { connectionId };
  },
};

const GITLAB_DESCRIPTOR: GitHostWizardDescriptor = {
  id: "gitlab",
  kind: "gitlab",
  label: "GitLab",
  blurb: "gitlab.com or self-hosted CE/EE.",
  // gitlab.com goes through the same field as a self-hosted instance: unlike
  // GitHub there is no separate API hostname, so the origin IS the base URL.
  needsInstanceUrl: true,
  instanceUrlPlaceholder: "https://gitlab.com",
  strippableApiPaths: ["/api/v4", "/api"],
  tokenLabel: "Personal access token",
  tokenPlaceholder: "glpat-…",
  tokenCreateUrl: (origin) =>
    origin ? `${origin}/-/user_settings/personal_access_tokens` : null,
  tokenCreateHint:
    "Your instance → Preferences → Access tokens → Add new token, then tick the scopes below.",
  scopes: [
    { id: "api", reason: "Read and write projects, issues, and merge requests." },
    {
      id: "read_api",
      reason: "Lets PacketBench verify this token's own scopes.",
      optional: true,
    },
  ],
  probe: {
    apiPrefix: "/api/v4",
    identityPath: "/user",
    authScheme: "private-token",
    accept: "application/json",
    // GitLab reports scopes as a resource, not a header — see `scopePath`.
    scopePath: "/personal_access_tokens/self",
    scopeField: "scopes",
    loginFields: ["username", "name"],
  },
  save: async ({ baseUrl, label, token }) => {
    const connectionId = await gitHostAddConnection("gitlab", baseUrl, label, token);
    return { connectionId };
  },
};

/**
 * Ordered host options. Append a descriptor to support another forge — the
 * wizard, its step flow, its validation and its copy are all derived from these.
 */
export const GIT_HOST_WIZARD_DESCRIPTORS: GitHostWizardDescriptor[] = [
  GITHUB_DESCRIPTOR,
  GITHUB_ENTERPRISE_DESCRIPTOR,
  GITLAB_DESCRIPTOR,
  GITEA_DESCRIPTOR,
];

export function descriptorById(id: string): GitHostWizardDescriptor | null {
  return GIT_HOST_WIZARD_DESCRIPTORS.find((d) => d.id === id) ?? null;
}

/**
 * The descriptor that describes an already-saved connection of this kind — how
 * to probe it, and which scopes it needs. Used by the edit/rotate flow, which
 * starts from a stored connection rather than from the host picker.
 *
 * Skips `unsupported` entries: those describe hosts the connection model
 * cannot store, so no saved connection can be one of them, and their `probe`
 * spec would be the wrong dialect for whatever actually is stored.
 */
export function descriptorForKind(kind: GitHostKind): GitHostWizardDescriptor | null {
  return GIT_HOST_WIZARD_DESCRIPTORS.find((d) => d.kind === kind && !d.unsupported) ?? null;
}

// ---------------------------------------------------------------------------
// Step flow (descriptor-driven)
// ---------------------------------------------------------------------------

export type WizardStep = "host" | "instance" | "token" | "verify" | "done";

export interface WizardStepMeta {
  id: WizardStep;
  title: string;
}

const STEP_TITLES: Record<WizardStep, string> = {
  host: "Choose a host",
  instance: "Instance URL",
  token: "Access token",
  verify: "Verify",
  done: "Connected",
};

/**
 * The steps for a given descriptor. `null` (nothing picked yet) yields the
 * host-picker step alone, so the progress rail doesn't promise steps that may
 * not apply to whatever the user ends up choosing.
 */
export function wizardSteps(descriptor: GitHostWizardDescriptor | null): WizardStepMeta[] {
  const ids: WizardStep[] = ["host"];
  if (descriptor) {
    if (descriptor.needsInstanceUrl) ids.push("instance");
    ids.push("token", "verify", "done");
  }
  return ids.map((id) => ({ id, title: STEP_TITLES[id] }));
}

// ---------------------------------------------------------------------------
// Instance URL normalisation
// ---------------------------------------------------------------------------

export interface NormalizedInstanceUrl {
  ok: true;
  /** The origin (plus any sub-path) the connection will actually be stored as. */
  value: string;
  /** Human-readable description of every change made to what the user typed. */
  notes: string[];
  /** Non-blocking concerns worth showing before the token is entered. */
  warnings: string[];
}

export interface InstanceUrlError {
  ok: false;
  error: string;
}

export type InstanceUrlResult = NormalizedInstanceUrl | InstanceUrlError;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Normalise a pasted instance URL.
 *
 * Accepts what people actually paste: no scheme, a trailing slash, the API root
 * copied out of the docs, a query string left over from a browser URL. Every
 * change is reported back in `notes` — the wizard shows the result rather than
 * silently rewriting the field under the user.
 */
export function normalizeInstanceUrl(
  input: string,
  descriptor: Pick<GitHostWizardDescriptor, "strippableApiPaths">,
): InstanceUrlResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Instance URL is required." };

  const notes: string[] = [];
  const warnings: string[] = [];

  let candidate = raw;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
  if (!hasScheme) {
    // A bare `git.example.com` is what most people paste. Assume TLS.
    candidate = `https://${candidate}`;
    notes.push("Added https:// — this address had no scheme.");
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "The instance URL must use http:// or https://." };
  }
  if (!url.hostname) {
    return { ok: false, error: "The instance URL has no host name." };
  }
  if (url.username || url.password) {
    // A credential in the URL would be a second secret handled outside the
    // keyring; refuse rather than quietly stripping it.
    return {
      ok: false,
      error: "Remove the username and password from the URL — the token is entered separately.",
    };
  }
  if (url.hostname.includes(" ")) {
    return { ok: false, error: "That is not a valid host name." };
  }

  if (url.search || url.hash) {
    notes.push("Dropped the query string / fragment — only the address is stored.");
    url.search = "";
    url.hash = "";
  }

  let path = url.pathname.replace(/\/+$/, "");
  const strippedApi = descriptor.strippableApiPaths.find((suffix) =>
    path.toLowerCase().endsWith(suffix.toLowerCase()),
  );
  if (strippedApi) {
    path = path.slice(0, path.length - strippedApi.length).replace(/\/+$/, "");
    notes.push(`Removed the ${strippedApi} suffix — PacketBench appends the API path itself.`);
  }
  if (url.pathname !== "/" && url.pathname !== path && !strippedApi) {
    notes.push("Removed the trailing slash.");
  }

  url.pathname = path;
  // `URL.toString()` re-adds a trailing slash for an empty path; strip it so
  // what we display is exactly what gets stored.
  const value = url.toString().replace(/\/+$/, "");

  if (url.protocol === "http:" && !LOCAL_HOSTNAMES.has(url.hostname)) {
    warnings.push("This is a plain http:// address — the token would travel unencrypted.");
  }

  return { ok: true, value, notes, warnings };
}

// ---------------------------------------------------------------------------
// Validation verdicts
// ---------------------------------------------------------------------------

export type VerdictLevel = "ok" | "warning" | "error";

export interface WizardVerdict {
  level: VerdictLevel;
  /** Stable key for tests and telemetry. */
  code: GitHostProbeOutcome | "insufficient_scopes" | "scopes_unknown";
  /** One-line headline. */
  title: string;
  /** What actually failed, in the user's terms. Never contains the token. */
  detail: string;
  /** The single next thing to do. */
  remedy: string;
  /** Scopes the descriptor requires that the host says were not granted. */
  missingScopes?: string[];
  /** Whether the wizard may proceed to save. */
  canSave: boolean;
}

/**
 * A granted scope satisfies a required one when it is the same scope, or when
 * it implies it: `write:issue` grants `read:issue`, and a bare `repo` grants
 * every `repo:*` child scope.
 */
function scopeSatisfied(scopeId: string, granted: Set<string>): boolean {
  const id = scopeId.toLowerCase();
  if (granted.has(id)) return true;
  const separator = id.indexOf(":");
  if (separator > 0) {
    const verb = id.slice(0, separator);
    const subject = id.slice(separator + 1);
    if (verb === "read" && granted.has(`write:${subject}`)) return true;
    if (granted.has(verb)) return true;
  }
  return false;
}

/**
 * Required (non-optional) scopes the host reports as *not* granted.
 *
 * `granted == null` means the host declined to report its grants at all, which
 * is not evidence of anything — return nothing missing and let the caller
 * surface the uncertainty instead of failing the user on a guess.
 */
export function missingRequiredScopes(
  descriptor: Pick<GitHostWizardDescriptor, "scopes">,
  granted: string[] | null | undefined,
): string[] {
  if (!granted) return [];
  const have = new Set(granted.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return descriptor.scopes
    .filter((s) => !s.optional && !scopeSatisfied(s.id, have))
    .map((s) => s.id);
}

/**
 * Turn a raw probe result into the verdict the wizard renders. Pure, so every
 * distinguishable failure has a test without a live host.
 */
export function verdictFor(
  descriptor: GitHostWizardDescriptor,
  result: GitHostProbeResult,
): WizardVerdict {
  const hostName = descriptor.label;
  switch (result.outcome) {
    case "unreachable":
      return {
        level: "error",
        code: "unreachable",
        title: `Could not reach ${hostName}`,
        detail: result.detail ?? "The host did not answer.",
        remedy: "Check the instance URL, and that this machine can reach it (VPN, firewall, DNS).",
        canSave: false,
      };
    case "tls_error":
      return {
        level: "error",
        code: "tls_error",
        title: "The host answered, but its certificate was rejected",
        detail: result.detail ?? "The TLS certificate could not be verified.",
        remedy:
          "Install the instance's CA certificate in this machine's trust store, or use a certificate from a public CA.",
        canSave: false,
      };
    case "not_a_host":
      return {
        level: "error",
        code: "not_a_host",
        title: "That address is not this host's API",
        detail: result.detail ?? "The address answered with something unexpected.",
        remedy: `Check the instance URL. PacketBench requested ${result.endpoint}.`,
        canSave: false,
      };
    case "invalid_token":
      return {
        level: "error",
        code: "invalid_token",
        title: "The token was rejected",
        detail: `${hostName} is reachable, but it did not accept this token.`,
        remedy: "Re-copy the token, or create a new one — it may be expired or revoked.",
        canSave: false,
      };
    case "forbidden":
      return {
        level: "error",
        code: "forbidden",
        title: "The token is valid but not permitted",
        detail: result.detail ?? "The host refused the request.",
        remedy:
          "Authorize the token for your organization's SSO, or check IP allow-lists on the host.",
        canSave: false,
      };
    case "rate_limited":
      return {
        level: "error",
        code: "rate_limited",
        title: "The host is rate-limiting this token",
        detail: result.detail ?? "Too many requests.",
        remedy: "Wait a minute and verify again — nothing has been saved.",
        canSave: false,
      };
    case "server_error":
      return {
        level: "error",
        code: "server_error",
        title: `${hostName} returned a server error`,
        detail: result.detail ?? "The host is reachable but failing.",
        remedy: "This is a problem on the host — try again once it recovers.",
        canSave: false,
      };
    case "unknown":
      return {
        level: "error",
        code: "unknown",
        title: "Unexpected response from the host",
        detail: result.detail ?? "The host answered in a way PacketBench does not recognise.",
        remedy: `Check the instance URL. PacketBench requested ${result.endpoint}.`,
        canSave: false,
      };
    case "ok":
      break;
  }

  const missing = missingRequiredScopes(descriptor, result.scopes);
  if (missing.length > 0) {
    return {
      level: "error",
      code: "insufficient_scopes",
      title: "The token works, but is missing scopes",
      detail: `Signed in as ${result.login ?? "unknown"}. ${hostName} reports this token was granted: ${
        result.scopes && result.scopes.length > 0 ? result.scopes.join(", ") : "no scopes"
      }.`,
      remedy: `Add ${missing.join(", ")} to the token (or create a new one) and verify again.`,
      missingScopes: missing,
      canSave: false,
    };
  }

  if (!result.scopes) {
    // Fine-grained GitHub tokens and Gitea tokens don't report their grants.
    // Saying "verified" would be a lie; blocking the user would be wrong.
    return {
      level: "warning",
      code: "scopes_unknown",
      title: `Connected as ${result.login ?? "unknown"}`,
      detail: `${hostName} does not report which scopes this token was granted, so PacketBench could not check them.`,
      remedy: "If repository or issue actions fail later, revisit the token's permissions.",
      canSave: true,
    };
  }

  return {
    level: "ok",
    code: "ok",
    title: `Connected as ${result.login ?? "unknown"}`,
    detail: `Token accepted with: ${result.scopes.join(", ") || "no scopes reported"}.`,
    remedy: "",
    canSave: true,
  };
}

/** Default connection label when the user leaves the field blank. */
export function defaultConnectionLabel(
  descriptor: GitHostWizardDescriptor,
  baseUrl: string,
): string {
  if (!descriptor.needsInstanceUrl) return descriptor.label;
  try {
    return new URL(baseUrl).host;
  } catch {
    return descriptor.label;
  }
}
