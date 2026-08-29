import { create } from "zustand";
import {
  githubClearToken,
  githubCloseIssue,
  githubCreatePr,
  githubGetAuthenticatedUser,
  githubGetPrChecks,
  githubInvestigateIssue,
  githubListIssueComments,
  githubListIssues,
  githubListIssuesPage,
  githubListPrsPage,
  githubListReposPage,
  githubListRepos,
  githubListReleases,
  githubPostIssueComment,
  githubReopenIssue,
  githubSetIssueAssignees,
  githubSetIssueLabels,
  githubSetIssueMilestone,
  githubSetToken,
  githubListPrs,
  githubGetPrDiff,
  githubListNotifications,
  githubMarkNotificationRead,
  gitHostListConnections,
  gitHostAddConnection,
  gitHostRemoveConnection,
  gitHostSetActive,
  gitHostHasToken,
  gitGetOriginUrl,
} from "@/lib/tauri";
import type {
  GithubNotification,
  GitHostConnectionInfo,
  GitHostKind,
  GitHubRelease,
} from "@/lib/tauri";
import { resolveConnectionForRemote } from "@/lib/gitHostResolve";
import { GITHUB_CONNECTION_ID } from "@/lib/git-hosts";
import type {
  GitHubRepo,
  GitHubIssue,
  GitHubIssueComment,
  GitHubPr,
  GitHubPrChecks,
  GitHubConfig,
} from "@/types/github";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import { logSwallowed } from "@/lib/logSwallowed";

const STORAGE_KEY = "packetbench:github";
const SETTINGS_STORAGE_KEY = "packetbench:github:settings";

/** v0.8: persisted GitHub-side defaults the user can tweak in Settings → GitHub. */
export type GitHubMergeStrategy = "merge" | "squash" | "rebase";

export interface GitHubSettings {
  defaultMergeStrategy: GitHubMergeStrategy;
  /** Show inline confirm step before merge/close/convert-to-draft. */
  requireMergeConfirmation: boolean;
  /** Pre-check the "Open as draft" box in the New PR modal. */
  defaultDraftPrs: boolean;
  /** Pre-check "Publish attempts as draft PRs" in the async Flight launcher. */
  defaultPublishAttemptsAsPrs: boolean;
}

const DEFAULT_GITHUB_SETTINGS: GitHubSettings = {
  defaultMergeStrategy: "squash",
  requireMergeConfirmation: true,
  defaultDraftPrs: false,
  defaultPublishAttemptsAsPrs: false,
};

interface LoadedConfig {
  config: GitHubConfig;
  legacyToken: string | null;
}

function loadConfig(): LoadedConfig {
  const parsed = loadFromStorage<{ token?: unknown; selectedRepo?: unknown }>(STORAGE_KEY, {});
  const selectedRepo =
    parsed.selectedRepo &&
    typeof parsed.selectedRepo === "object" &&
    "owner" in parsed.selectedRepo &&
    "repo" in parsed.selectedRepo
      ? (parsed.selectedRepo as { owner: string; repo: string })
      : null;
  const legacyToken =
    typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
  return { config: { selectedRepo }, legacyToken };
}

function saveConfig(config: GitHubConfig) {
  saveToStorage(STORAGE_KEY, { selectedRepo: config.selectedRepo });
}

function loadSettings(): GitHubSettings {
  const parsed = loadFromStorage<Partial<GitHubSettings>>(SETTINGS_STORAGE_KEY, {});
  const strategy: GitHubMergeStrategy =
    parsed.defaultMergeStrategy === "merge" ||
    parsed.defaultMergeStrategy === "squash" ||
    parsed.defaultMergeStrategy === "rebase"
      ? parsed.defaultMergeStrategy
      : DEFAULT_GITHUB_SETTINGS.defaultMergeStrategy;
  return {
    defaultMergeStrategy: strategy,
    requireMergeConfirmation:
      typeof parsed.requireMergeConfirmation === "boolean"
        ? parsed.requireMergeConfirmation
        : DEFAULT_GITHUB_SETTINGS.requireMergeConfirmation,
    defaultDraftPrs:
      typeof parsed.defaultDraftPrs === "boolean"
        ? parsed.defaultDraftPrs
        : DEFAULT_GITHUB_SETTINGS.defaultDraftPrs,
    defaultPublishAttemptsAsPrs:
      typeof parsed.defaultPublishAttemptsAsPrs === "boolean"
        ? parsed.defaultPublishAttemptsAsPrs
        : DEFAULT_GITHUB_SETTINGS.defaultPublishAttemptsAsPrs,
  };
}

function saveSettings(settings: GitHubSettings) {
  saveToStorage(SETTINGS_STORAGE_KEY, settings);
}

function isTokenError(message: string): boolean {
  return message.toLowerCase().includes("token not set");
}

function isAuthRejection(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("bad credentials")
  );
}

interface AuthenticatedUser {
  login: string;
  avatarUrl: string;
}

interface GitHubStore {
  config: GitHubConfig;
  isConnected: boolean;
  isInitializing: boolean;
  authenticatedUser: AuthenticatedUser | null;
  repos: GitHubRepo[];
  issues: GitHubIssue[];
  isLoading: boolean;
  error: string | null;
  investigation: string | null;
  isInvestigating: boolean;
  prs: GitHubPr[];
  /** GP6: the selected repo's releases (read-only view). */
  releases: GitHubRelease[];
  /** GP6: releases fetch in flight — distinguishes "loading" from "genuinely none". */
  isReleasesLoading: boolean;
  /** GP6: last releases fetch failed (vs. an empty repo) so the UI can say so. */
  releasesError: string | null;
  prDiff: string | null;
  isPrLoading: boolean;
  /** Unix millis of the last successful repos/issues/PRs fetch. */
  lastSyncAt: number | null;

  /** G2: all configured git-host connections (GitHub + Gitea/Forgejo). */
  connections: GitHostConnectionInfo[];
  /** G3: the connection the current workspace resolves to (from its origin
   *  remote). Defaults to GitHub. Drives which host the pane targets + branding. */
  activeConnectionId: string;

  initializeAuth: () => Promise<void>;
  connect: (token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** G2: refresh the connection list from the backend. */
  loadConnections: () => Promise<void>;
  /**
   * G2: add a self-hosted / third-party host (base URL already normalized to
   * the instance origin by `normalizeInstanceBaseUrl`). The token goes straight
   * to the backend keyring — it is never held in store state.
   */
  addGitHostConnection: (
    kind: Exclude<GitHostKind, "github">,
    baseUrl: string,
    label: string,
    token: string,
  ) => Promise<void>;
  // `addGiteaHost` used to sit here as a Gitea-fixed alias "kept for existing
  // callers". There were none left once the guided wizard took over adding
  // hosts — it writes through its descriptor's own `save` — so it was an
  // unreachable path that wrote a token into the OS keyring, and a kind-fixed
  // one at that. Use `addGitHostConnection(kind, ...)`.
  /** G2: remove a non-GitHub connection. */
  removeGitHostConnection: (id: string) => Promise<void>;
  /** G3: manually set the active connection (host override). */
  setActiveConnection: (id: string, force?: boolean) => void;
  /** G3: resolve + set the active connection from a project's origin remote. */
  resolveActiveConnectionForProject: (projectPath: string) => Promise<void>;
  fetchRepos: () => Promise<void>;
  selectRepo: (owner: string, repo: string) => void;
  /** Clear repository authority without changing the selected Git host. */
  clearRepositoryContext: () => void;
  fetchIssues: () => Promise<void>;
  investigateIssue: (projectPath: string, issueNumber: number) => Promise<void>;
  createPR: (
    title: string,
    body: string,
    head: string,
    base: string,
    /** v0.8-G: optional draft flag. Defaults to false (regular PR). */
    draft?: boolean,
  ) => Promise<string>;
  fetchPrs: () => Promise<void>;
  /** GP6: fetch the selected repo's releases. */
  fetchReleases: () => Promise<void>;
  getPrDiff: (prNumber: number) => Promise<void>;

  // v0.8-A: optimistic PR patch. Lets PRActionBar reflect merge/close/reopen
  // immediately. `prNumber` is the PR number, not the DB id.
  updatePrState: (prNumber: number, patch: Partial<GitHubPr>) => void;

  // v0.8-B: per-PR CI status cache. Keyed `"{owner}/{repo}#{number}"`.
  prChecks: Record<string, GitHubPrChecks>;
  prChecksLoading: Record<string, boolean>;
  prChecksError: Record<string, string>;
  fetchPrChecks: (pr: GitHubPr, options?: { force?: boolean }) => Promise<void>;
  getPrChecks: (pr: GitHubPr) => GitHubPrChecks | undefined;

  // v0.8-C: issue interactivity (comments, state, filters, pagination).
  /** Comments cache keyed `"{owner}/{repo}#{number}"`. */
  issueComments: Record<string, GitHubIssueComment[]>;
  issueCommentsLoading: Record<string, boolean>;
  /** Filter strip in the Issues sub-tab. Default "open". */
  issueStateFilter: "open" | "closed" | "all";
  /** Filter strip in the PRs sub-tab. Default "open". */
  prStateFilter: "open" | "closed" | "all";
  /** Last loaded page number per entity. 1 means the initial 30. */
  issuesPage: number;
  prsPage: number;
  reposPage: number;
  /** True iff GitHub reports a next page for the backing API request. */
  issuesHasMore: boolean;
  prsHasMore: boolean;
  reposHasMore: boolean;
  isLoadingMoreIssues: boolean;
  isLoadingMorePrs: boolean;
  isLoadingMoreRepos: boolean;
  setIssueStateFilter: (state: "open" | "closed" | "all") => void;
  setPrStateFilter: (state: "open" | "closed" | "all") => void;
  fetchIssueComments: (issue: { number: number }) => Promise<void>;
  postIssueComment: (issue: { number: number }, body: string) => Promise<void>;
  setIssueState: (
    issue: { number: number; state: string },
    nextState: "open" | "closed",
  ) => Promise<void>;
  setIssueAssignees: (issue: { number: number }, assignees: string[]) => Promise<void>;
  setIssueLabels: (
    issue: { number: number },
    labels: { name: string; color: string }[],
  ) => Promise<void>;
  setIssueMilestone: (
    issue: { number: number },
    milestone: { number: number; title: string } | null,
  ) => Promise<void>;
  loadMoreIssues: () => Promise<void>;
  loadMorePrs: () => Promise<void>;
  loadMoreRepos: () => Promise<void>;

  // v0.8-E: AI PR-review cache. Keyed `"{owner}/{repo}#{number}"` via the
  // exported `prCacheKey` helper. Value is the rendered markdown returned
  // by the one-shot `claude-oauth` session; presence means "user has
  // already run a review on this PR in this session". Re-running calls
  // `setPrAiReview` again with fresh content.
  prAiReviews: Record<string, string>;
  setPrAiReview: (pr: { number: number }, markdown: string) => void;
  clearPrAiReview: (pr: { number: number }) => void;

  // Notifications inbox: the authenticated user's cross-repo notification
  // threads. Fetched lazily when the Inbox sub-tab is first opened.
  notifications: GithubNotification[];
  notificationsLoading: boolean;
  notificationsError: string | null;
  /** Count of unread threads — drives the sub-tab badge. Derived on fetch. */
  unreadCount: number;
  fetchNotifications: () => Promise<void>;
  /** Optimistically flip a thread to read, then reconcile with the backend. */
  markNotificationRead: (threadId: string) => Promise<void>;

  // v0.8: persisted GitHub-related preferences (Settings → GitHub card).
  defaultMergeStrategy: GitHubMergeStrategy;
  requireMergeConfirmation: boolean;
  defaultDraftPrs: boolean;
  defaultPublishAttemptsAsPrs: boolean;
  setDefaultMergeStrategy: (strategy: GitHubMergeStrategy) => void;
  setRequireMergeConfirmation: (require: boolean) => void;
  setDefaultDraftPrs: (draft: boolean) => void;
  setDefaultPublishAttemptsAsPrs: (publish: boolean) => void;

  clearError: () => void;
  clearInvestigation: () => void;
}

function resetHostScopedState(
  config: GitHubConfig,
  activeConnectionId: string,
): Partial<GitHubStore> {
  const nextConfig = { ...config, selectedRepo: null };
  saveConfig(nextConfig);
  return {
    activeConnectionId,
    isConnected: false,
    isInitializing: true,
    authenticatedUser: null,
    config: nextConfig,
    repos: [],
    issues: [],
    prs: [],
    releases: [],
    prDiff: null,
    investigation: null,
    isInvestigating: false,
    isLoading: false,
    isPrLoading: false,
    isReleasesLoading: false,
    releasesError: null,
    error: null,
    lastSyncAt: null,
    prChecks: {},
    prChecksLoading: {},
    prChecksError: {},
    issueComments: {},
    issueCommentsLoading: {},
    prAiReviews: {},
    notifications: [],
    notificationsLoading: false,
    notificationsError: null,
    unreadCount: 0,
    issuesPage: 1,
    prsPage: 1,
    reposPage: 1,
    issuesHasMore: false,
    prsHasMore: false,
    reposHasMore: false,
    isLoadingMoreIssues: false,
    isLoadingMorePrs: false,
    isLoadingMoreRepos: false,
  };
}

function resetRepoScopedState(config: GitHubConfig): Partial<GitHubStore> {
  saveConfig(config);
  return {
    config,
    issues: [],
    prs: [],
    releases: [],
    prDiff: null,
    investigation: null,
    isInvestigating: false,
    isLoading: false,
    isPrLoading: false,
    isReleasesLoading: false,
    releasesError: null,
    error: null,
    lastSyncAt: null,
    prChecks: {},
    prChecksLoading: {},
    prChecksError: {},
    issueComments: {},
    issueCommentsLoading: {},
    prAiReviews: {},
    issuesPage: 1,
    prsPage: 1,
    issuesHasMore: false,
    prsHasMore: false,
    isLoadingMoreIssues: false,
    isLoadingMorePrs: false,
  };
}

let authorityEpoch = 0;
let hostResolutionSequence = 0;
let hostActivationSequence = 0;
let hostActivationQueue: Promise<void> = Promise.resolve();
let lastConfirmedConnectionId = GITHUB_CONNECTION_ID;
let prDiffRequestSequence = 0;
let investigationRequestSequence = 0;
let connectionsRequestSequence = 0;

interface AuthoritySnapshot {
  epoch: number;
  key: string;
}

function authorityKey(state: Pick<GitHubStore, "activeConnectionId" | "config">): string {
  const repo = state.config.selectedRepo;
  return `${state.activeConnectionId}:${repo?.owner ?? ""}/${repo?.repo ?? ""}`;
}

function captureAuthority(state: GitHubStore): AuthoritySnapshot {
  return { epoch: authorityEpoch, key: authorityKey(state) };
}

function isAuthorityCurrent(snapshot: AuthoritySnapshot, state: GitHubStore): boolean {
  return snapshot.epoch === authorityEpoch && snapshot.key === authorityKey(state);
}

// v0.8-E: cache key shared by the AI-review store + the `PRReviewPanel`
// component. Stable shape across renders so component lookups stay O(1).
// Exported so the `PRReviewPanel` doesn't have to duplicate the format.
export function prCacheKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

// v0.8-C: cache key for issue comments. Stable across re-renders.
function issueCommentsKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

function parseIssuesPage(json: string): { issues: GitHubIssue[]; hasMore: boolean } {
  const parsed = JSON.parse(json) as
    | Array<GitHubIssue & { pull_request?: unknown }>
    | {
        items?: Array<GitHubIssue & { pull_request?: unknown }>;
        has_more?: boolean;
        hasMore?: boolean;
      };

  const raw = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  const issues: GitHubIssue[] = raw.filter((item) => !item.pull_request);
  const hasMore = Array.isArray(parsed)
    ? issues.length >= 30
    : (parsed.has_more ?? parsed.hasMore ?? issues.length >= 30);

  return { issues, hasMore };
}

const loaded = loadConfig();
const loadedSettings = loadSettings();
let pendingLegacyToken = loaded.legacyToken;

export const useGitHubStore = create<GitHubStore>((set, get) => ({
  config: loaded.config,
  isConnected: false,
  isInitializing: false,
  authenticatedUser: null,
  repos: [],
  issues: [],
  isLoading: false,
  error: null,
  investigation: null,
  isInvestigating: false,
  prs: [],
  releases: [],
  isReleasesLoading: false,
  releasesError: null,
  prDiff: null,
  isPrLoading: false,
  lastSyncAt: null,
  connections: [],
  activeConnectionId: GITHUB_CONNECTION_ID,

  // v0.8-B: per-PR CI status cache.
  prChecks: {},
  prChecksLoading: {},
  prChecksError: {},

  // v0.8-C
  issueComments: {},
  issueCommentsLoading: {},
  issueStateFilter: "open",
  prStateFilter: "open",
  issuesPage: 1,
  prsPage: 1,
  reposPage: 1,
  issuesHasMore: false,
  prsHasMore: false,
  reposHasMore: false,
  isLoadingMoreIssues: false,
  isLoadingMorePrs: false,
  isLoadingMoreRepos: false,

  initializeAuth: async () => {
    if (get().isInitializing) return;
    const connectionId = get().activeConnectionId;
    const transition = hostActivationSequence;
    set({ isInitializing: true, error: null });
    try {
      let hasToken = await gitHostHasToken(connectionId);
      if (connectionId === GITHUB_CONNECTION_ID && !hasToken && pendingLegacyToken) {
        await githubSetToken(pendingLegacyToken);
        hasToken = true;
      }

      // One-time migration: rewrite persisted config without token.
      if (connectionId === GITHUB_CONNECTION_ID && pendingLegacyToken) {
        pendingLegacyToken = null;
        saveConfig(get().config);
      }

      let authenticatedUser: AuthenticatedUser | null = null;
      let authProbeError: string | null = null;
      if (hasToken) {
        try {
          authenticatedUser = await githubGetAuthenticatedUser();
        } catch (e) {
          // Token may be stale/invalid — leave user null; badge falls back to
          // "user" and the next API call will surface a clearer error. Surface
          // the failure so a broken probe doesn't silently mask real issues.
          logSwallowed("githubStore.initializeAuth.userProbe")(e);
          const message = String(e);
          if (isAuthRejection(message)) {
            hasToken = false;
          } else {
            authProbeError = `Could not verify Git-host identity: ${message}`;
          }
        }
      }

      if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
        return;
      set({
        isConnected: hasToken,
        isInitializing: false,
        authenticatedUser,
        error: authProbeError,
      });
    } catch (e) {
      if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
        return;
      set({
        isConnected: false,
        isInitializing: false,
        authenticatedUser: null,
        error: String(e),
      });
    }
  },

  connect: async (token) => {
    const trimmed = token.trim();
    if (!trimmed) return;
    const connectionId = get().activeConnectionId;
    const transition = hostActivationSequence;
    set({ isLoading: true, error: null });
    try {
      await githubSetToken(trimmed);
      pendingLegacyToken = null;
      let authenticatedUser: AuthenticatedUser | null = null;
      let authProbeError: string | null = null;
      try {
        authenticatedUser = await githubGetAuthenticatedUser();
      } catch (e) {
        logSwallowed("githubStore.connect.userProbe")(e);
        const message = String(e);
        if (isAuthRejection(message)) {
          try {
            await githubClearToken();
          } catch (clearError) {
            console.warn("[githubStore] rejected token cleanup failed:", clearError);
          }
          if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
            return;
          set({
            isConnected: false,
            isLoading: false,
            authenticatedUser: null,
            error: `GitHub rejected this token: ${message}`,
          });
          return;
        }
        authProbeError = `Token saved, but GitHub identity could not be verified: ${message}`;
      }
      if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
        return;
      authorityEpoch += 1;
      set({
        ...resetRepoScopedState(get().config),
        isConnected: true,
        isLoading: false,
        authenticatedUser,
        error: authProbeError,
      });
    } catch (e) {
      if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
        return;
      set({
        isConnected: false,
        isLoading: false,
        authenticatedUser: null,
        error: String(e),
      });
    }
  },

  disconnect: async () => {
    const connectionId = get().activeConnectionId;
    const transition = hostActivationSequence;
    set({ isLoading: true, error: null });
    try {
      await githubClearToken();
      if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
        return;
      authorityEpoch += 1;
      set({
        ...resetHostScopedState(get().config, get().activeConnectionId),
        isConnected: false,
        isInitializing: false,
        isLoading: false,
      });
    } catch (e) {
      if (get().activeConnectionId !== connectionId || transition !== hostActivationSequence)
        return;
      set({
        isLoading: false,
        error: String(e),
      });
    }
  },

  loadConnections: async () => {
    const request = ++connectionsRequestSequence;
    try {
      const connections = await gitHostListConnections();
      if (request !== connectionsRequestSequence) return;
      set({ connections });
    } catch (e) {
      console.warn("[githubStore] loadConnections failed:", e);
    }
  },

  addGitHostConnection: async (kind, baseUrl, label, token) => {
    await gitHostAddConnection(kind, baseUrl, label, token);
    await get().loadConnections();
  },

  removeGitHostConnection: async (id) => {
    const wasActiveAtStart = get().activeConnectionId === id;
    await gitHostRemoveConnection(id);
    // If we removed the active host, fall back to GitHub — and sync the backend
    // (its active_connection_id must not dangle at the deleted id).
    const currentConnectionId = get().activeConnectionId;
    if (currentConnectionId === id) {
      get().setActiveConnection(GITHUB_CONNECTION_ID);
    } else if (wasActiveAtStart) {
      // Rust falls back to GitHub when it removes the active connection. If
      // the user selected another host while removal was in flight, reassert
      // that newer intent through the serialized activation queue.
      get().setActiveConnection(currentConnectionId, true);
    }
    await get().loadConnections();
  },

  setActiveConnection: (id, force = false) => {
    if (get().activeConnectionId === id && !force) return;
    const previousConfig = get().config;
    hostResolutionSequence += 1;
    const transition = ++hostActivationSequence;
    authorityEpoch += 1;
    set(resetHostScopedState(get().config, id));
    hostActivationQueue = hostActivationQueue
      .catch(() => undefined)
      .then(async () => {
        await gitHostSetActive(id);
        if (transition !== hostActivationSequence) return;
        const hasToken = await gitHostHasToken(id);
        let authReady = hasToken;
        let authenticatedUser: AuthenticatedUser | null = null;
        let authProbeError: string | null = null;
        if (authReady) {
          try {
            authenticatedUser = await githubGetAuthenticatedUser();
          } catch (e) {
            logSwallowed("githubStore.setActiveConnection.userProbe")(e);
            const message = String(e);
            if (isAuthRejection(message)) {
              authReady = false;
            } else {
              authProbeError = `Could not verify Git-host identity: ${message}`;
            }
          }
        }
        if (transition !== hostActivationSequence || get().activeConnectionId !== id) return;
        lastConfirmedConnectionId = id;
        set({
          isConnected: authReady,
          isInitializing: false,
          authenticatedUser,
          error: authProbeError,
        });
      })
      .catch(async (e) => {
        if (transition !== hostActivationSequence || get().activeConnectionId !== id) return;
        authorityEpoch += 1;
        let rollbackSucceeded = true;
        try {
          await gitHostSetActive(lastConfirmedConnectionId);
        } catch (rollbackError) {
          rollbackSucceeded = false;
          console.warn("[githubStore] Git host rollback failed:", rollbackError);
        }
        if (transition !== hostActivationSequence || get().activeConnectionId !== id) return;
        if (!rollbackSucceeded) {
          set({
            ...resetHostScopedState(get().config, id),
            isConnected: false,
            isInitializing: false,
            authenticatedUser: null,
            error: `Could not activate Git host and could not restore the last confirmed host: ${String(e)}`,
          });
          return;
        }
        let hasToken = false;
        let authenticatedUser: AuthenticatedUser | null = null;
        try {
          hasToken = await gitHostHasToken(lastConfirmedConnectionId);
          if (transition !== hostActivationSequence || get().activeConnectionId !== id) return;
          if (hasToken) authenticatedUser = await githubGetAuthenticatedUser();
        } catch (probeError) {
          console.warn("[githubStore] rolled-back Git host auth probe failed:", probeError);
          if (isAuthRejection(String(probeError))) hasToken = false;
        }
        if (transition !== hostActivationSequence || get().activeConnectionId !== id) return;
        set({
          ...resetHostScopedState(previousConfig, lastConfirmedConnectionId),
          isConnected: hasToken,
          isInitializing: false,
          authenticatedUser,
          error: `Could not activate Git host: ${String(e)}`,
        });
      });
  },

  resolveActiveConnectionForProject: async (projectPath) => {
    if (!projectPath) return;
    const resolution = ++hostResolutionSequence;
    try {
      // Ensure the connection list is loaded so the resolver can match.
      if (get().connections.length === 0) await get().loadConnections();
      const origin = await gitGetOriginUrl(projectPath);
      if (resolution !== hostResolutionSequence) return;
      const { connectionId } = resolveConnectionForRemote(origin, get().connections);
      const active = connectionId ?? GITHUB_CONNECTION_ID;
      get().setActiveConnection(active);
    } catch (e) {
      console.warn("[githubStore] resolveActiveConnectionForProject failed:", e);
    }
  },

  fetchRepos: async () => {
    if (!get().isConnected) return;
    const authority = captureAuthority(get());
    set({ isLoading: true, error: null });
    try {
      // v0.8-C: route through the paginated endpoint so we can compute
      // `reposHasMore` from the response cardinality (page-size 30).
      const json = await githubListReposPage(1);
      const repos: GitHubRepo[] = JSON.parse(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        repos,
        isLoading: false,
        lastSyncAt: Date.now(),
        reposPage: 1,
        reposHasMore: repos.length >= 30,
      });
    } catch (e) {
      const message = String(e);
      if (!isTokenError(message)) {
        try {
          const json = await githubListRepos();
          const repos: GitHubRepo[] = JSON.parse(json);
          if (!isAuthorityCurrent(authority, get())) return;
          set({
            repos,
            isLoading: false,
            lastSyncAt: Date.now(),
            reposPage: 1,
            reposHasMore: false,
            error: null,
          });
          return;
        } catch (fallbackErr) {
          // Both paginated + legacy fell over — surface the legacy failure so
          // we can tell a backend regression apart from a paginated-only bug.
          logSwallowed("githubStore.fetchRepos.legacyFallback")(fallbackErr);
        }
      }
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        isConnected: isTokenError(message) ? false : get().isConnected,
        error: message,
        isLoading: false,
      });
    }
  },

  selectRepo: (owner, repo) => {
    const config = { ...get().config, selectedRepo: { owner, repo } };
    if (
      authorityKey({ activeConnectionId: get().activeConnectionId, config }) === authorityKey(get())
    ) {
      return;
    }
    authorityEpoch += 1;
    set(resetRepoScopedState(config));
  },

  clearRepositoryContext: () => {
    hostResolutionSequence += 1;
    const state = get();
    if (!state.config.selectedRepo && state.issues.length === 0 && state.prs.length === 0) return;
    authorityEpoch += 1;
    set(resetRepoScopedState({ ...state.config, selectedRepo: null }));
  },

  fetchIssues: async () => {
    const { config, issueStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    set({ isLoading: true, error: null });
    try {
      // v0.8-C: paginated + state-filtered.
      const json = await githubListIssuesPage(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issueStateFilter,
        1,
      );
      const { issues, hasMore } = parseIssuesPage(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        issues,
        isLoading: false,
        lastSyncAt: Date.now(),
        issuesPage: 1,
        issuesHasMore: hasMore,
      });
    } catch (e) {
      const message = String(e);
      if (!isTokenError(message) && issueStateFilter === "open") {
        try {
          const json = await githubListIssues(config.selectedRepo.owner, config.selectedRepo.repo);
          const { issues } = parseIssuesPage(json);
          if (!isAuthorityCurrent(authority, get())) return;
          set({
            issues,
            isLoading: false,
            lastSyncAt: Date.now(),
            issuesPage: 1,
            issuesHasMore: false,
            error: null,
          });
          return;
        } catch (fallbackErr) {
          // Both paginated + legacy issues calls failed — log so we don't lose
          // the legacy error under the (later-reported) paginated message.
          logSwallowed("githubStore.fetchIssues.legacyFallback")(fallbackErr);
        }
      }
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        isConnected: isTokenError(message) ? false : get().isConnected,
        error: message,
        isLoading: false,
      });
    }
  },

  investigateIssue: async (projectPath, issueNumber) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const request = ++investigationRequestSequence;
    set({ isInvestigating: true, investigation: null });
    try {
      const result = await githubInvestigateIssue(
        projectPath,
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issueNumber,
      );
      if (!isAuthorityCurrent(authority, get()) || request !== investigationRequestSequence) return;
      set({ investigation: result, isInvestigating: false });
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get()) || request !== investigationRequestSequence) return;
      set({
        isConnected: isTokenError(message) ? false : get().isConnected,
        error: message,
        isInvestigating: false,
        investigation: null,
      });
    }
  },

  createPR: async (title, body, head, base, draft) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) throw new Error("No repo selected");
    const authority = captureAuthority(get());
    set({ isLoading: true, error: null });
    try {
      const json = await githubCreatePr(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        title,
        body,
        head,
        base,
        draft,
      );
      if (isAuthorityCurrent(authority, get())) set({ isLoading: false });
      return json;
    } catch (e) {
      const message = String(e);
      if (isAuthorityCurrent(authority, get())) {
        set({
          isConnected: isTokenError(message) ? false : get().isConnected,
          error: message,
          isLoading: false,
        });
      }
      throw e;
    }
  },

  fetchPrs: async () => {
    const { config, prStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    set({ isPrLoading: true, error: null });
    try {
      const json = await githubListPrsPage(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        prStateFilter,
        1,
      );
      const prs: GitHubPr[] = JSON.parse(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        prs,
        isPrLoading: false,
        lastSyncAt: Date.now(),
        prsPage: 1,
        prsHasMore: prs.length >= 30,
      });
    } catch (e) {
      const message = String(e);
      if (!isTokenError(message) && prStateFilter === "open") {
        try {
          const json = await githubListPrs(config.selectedRepo.owner, config.selectedRepo.repo);
          const prs: GitHubPr[] = JSON.parse(json);
          if (!isAuthorityCurrent(authority, get())) return;
          set({
            prs,
            isPrLoading: false,
            lastSyncAt: Date.now(),
            prsPage: 1,
            prsHasMore: false,
            error: null,
          });
          return;
        } catch (fallbackErr) {
          // Both paginated + legacy PR list calls failed — surface so the
          // legacy error isn't masked by the paginated one we report below.
          logSwallowed("githubStore.fetchPrs.legacyFallback")(fallbackErr);
        }
      }
      if (!isAuthorityCurrent(authority, get())) return;
      set({ error: message, isPrLoading: false });
    }
  },

  fetchReleases: async () => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    set({ isReleasesLoading: true, releasesError: null });
    try {
      const json = await githubListReleases(config.selectedRepo.owner, config.selectedRepo.repo);
      const releases: GitHubRelease[] = JSON.parse(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set({ releases, isReleasesLoading: false, releasesError: null });
    } catch (e) {
      logSwallowed("githubStore.fetchReleases")(e);
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        releases: [],
        isReleasesLoading: false,
        releasesError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  getPrDiff: async (prNumber) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const request = ++prDiffRequestSequence;
    set({ isPrLoading: true, prDiff: null });
    try {
      const diff = await githubGetPrDiff(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        prNumber,
      );
      if (!isAuthorityCurrent(authority, get()) || request !== prDiffRequestSequence) return;
      set({ prDiff: diff, isPrLoading: false });
    } catch (e) {
      if (!isAuthorityCurrent(authority, get()) || request !== prDiffRequestSequence) return;
      set({ error: String(e), isPrLoading: false });
    }
  },

  // === v0.8-A: optimistic PR patch ==========================================
  updatePrState: (prNumber, patch) => {
    set((s) => ({
      prs: s.prs.map((p) => (p.number === prNumber ? { ...p, ...patch } : p)),
    }));
  },

  // === v0.8-B: CI / check-run cache =========================================
  fetchPrChecks: async (pr, options) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const key = `${config.selectedRepo.owner}/${config.selectedRepo.repo}#${pr.number}`;
    if (!options?.force && get().prChecks[key]) return;
    set((s) => ({ prChecksLoading: { ...s.prChecksLoading, [key]: true } }));
    try {
      const checks = await githubGetPrChecks(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        pr.number,
      );
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => ({
        prChecks: { ...s.prChecks, [key]: checks },
        prChecksLoading: { ...s.prChecksLoading, [key]: false },
        prChecksError: { ...s.prChecksError, [key]: "" },
      }));
    } catch (e) {
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => ({
        prChecksLoading: { ...s.prChecksLoading, [key]: false },
        prChecksError: { ...s.prChecksError, [key]: String(e) },
      }));
    }
  },
  getPrChecks: (pr) => {
    const { config } = get();
    if (!config.selectedRepo) return undefined;
    const key = `${config.selectedRepo.owner}/${config.selectedRepo.repo}#${pr.number}`;
    return get().prChecks[key];
  },

  // === v0.8-C: issue interactivity ==========================================

  setIssueStateFilter: (state) => {
    if (get().issueStateFilter === state) return;
    authorityEpoch += 1;
    set({ issueStateFilter: state, issues: [] });
    void get().fetchIssues();
  },

  setPrStateFilter: (state) => {
    if (get().prStateFilter === state) return;
    authorityEpoch += 1;
    set({ prStateFilter: state, prs: [] });
    void get().fetchPrs();
  },

  fetchIssueComments: async (issue) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const key = issueCommentsKey(config.selectedRepo.owner, config.selectedRepo.repo, issue.number);
    set((s) => ({
      issueCommentsLoading: { ...s.issueCommentsLoading, [key]: true },
    }));
    try {
      const comments = await githubListIssueComments(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issue.number,
      );
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => ({
        issueComments: { ...s.issueComments, [key]: comments },
        issueCommentsLoading: (() => {
          const next = { ...s.issueCommentsLoading };
          delete next[key];
          return next;
        })(),
      }));
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => ({
        error: message,
        isConnected: isTokenError(message) ? false : s.isConnected,
        issueCommentsLoading: (() => {
          const next = { ...s.issueCommentsLoading };
          delete next[key];
          return next;
        })(),
      }));
    }
  },

  postIssueComment: async (issue, body) => {
    const trimmed = body.trim();
    if (!trimmed) {
      set({ error: "Comment cannot be empty" });
      throw new Error("Comment cannot be empty");
    }
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) {
      throw new Error("Not connected");
    }
    const authority = captureAuthority(get());
    const key = issueCommentsKey(config.selectedRepo.owner, config.selectedRepo.repo, issue.number);
    try {
      const created = await githubPostIssueComment(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issue.number,
        trimmed,
      );
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => ({
        issueComments: {
          ...s.issueComments,
          [key]: [...(s.issueComments[key] ?? []), created],
        },
      }));
      // Refetch to reconcile with server-side ordering / formatting.
      void get().fetchIssueComments(issue);
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) throw e;
      set((s) => ({
        error: message,
        isConnected: isTokenError(message) ? false : s.isConnected,
      }));
      throw e;
    }
  },

  setIssueState: async (issue, nextState) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const prev = issue.state;
    // Optimistic update.
    set((s) => ({
      issues: s.issues.map((i) => (i.number === issue.number ? { ...i, state: nextState } : i)),
    }));
    try {
      if (nextState === "closed") {
        await githubCloseIssue(config.selectedRepo.owner, config.selectedRepo.repo, issue.number);
      } else {
        await githubReopenIssue(config.selectedRepo.owner, config.selectedRepo.repo, issue.number);
      }
      if (!isAuthorityCurrent(authority, get())) return;
      // Success: reconcile with the server (handles GitHub-side
      // normalization). On error we skip this — the rollback above is
      // the authoritative final state, and a redundant fetch would just
      // burn a rate-limit token.
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) throw e;
      // Roll back optimistic update.
      set((s) => ({
        issues: s.issues.map((i) => (i.number === issue.number ? { ...i, state: prev } : i)),
        error: message,
        isConnected: isTokenError(message) ? false : s.isConnected,
      }));
      throw e;
    }
  },

  setIssueAssignees: async (issue, assignees) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const prev = get().issues.find((i) => i.number === issue.number);
    set((s) => ({
      issues: s.issues.map((i) =>
        i.number === issue.number ? { ...i, assignees: assignees.map((login) => ({ login })) } : i,
      ),
    }));
    try {
      await githubSetIssueAssignees(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issue.number,
        assignees,
      );
      if (!isAuthorityCurrent(authority, get())) return;
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) throw e;
      if (prev) {
        set((s) => ({
          issues: s.issues.map((i) =>
            i.number === issue.number ? { ...i, assignees: prev.assignees } : i,
          ),
          error: message,
        }));
      }
      throw e;
    }
  },

  setIssueLabels: async (issue, labels) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const prev = get().issues.find((i) => i.number === issue.number);
    set((s) => ({
      issues: s.issues.map((i) => (i.number === issue.number ? { ...i, labels } : i)),
    }));
    try {
      await githubSetIssueLabels(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issue.number,
        labels.map((l) => l.name),
      );
      if (!isAuthorityCurrent(authority, get())) return;
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) throw e;
      if (prev) {
        set((s) => ({
          issues: s.issues.map((i) =>
            i.number === issue.number ? { ...i, labels: prev.labels } : i,
          ),
          error: message,
        }));
      }
      throw e;
    }
  },

  setIssueMilestone: async (issue, milestone) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    const authority = captureAuthority(get());
    const prev = get().issues.find((i) => i.number === issue.number);
    set((s) => ({
      issues: s.issues.map((i) => (i.number === issue.number ? { ...i, milestone } : i)),
    }));
    try {
      await githubSetIssueMilestone(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issue.number,
        milestone?.number ?? null,
      );
      if (!isAuthorityCurrent(authority, get())) return;
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) throw e;
      if (prev) {
        set((s) => ({
          issues: s.issues.map((i) =>
            i.number === issue.number ? { ...i, milestone: prev.milestone } : i,
          ),
          error: message,
        }));
      }
      throw e;
    }
  },

  loadMoreIssues: async () => {
    const { config, issuesPage, isLoadingMoreIssues, issueStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo || isLoadingMoreIssues || !get().issuesHasMore) {
      return;
    }
    const authority = captureAuthority(get());
    set({ isLoadingMoreIssues: true });
    const nextPage = issuesPage + 1;
    try {
      const json = await githubListIssuesPage(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issueStateFilter,
        nextPage,
      );
      const { issues: more, hasMore } = parseIssuesPage(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => {
        const seen = new Set(s.issues.map((i) => i.number));
        const appended = [...s.issues, ...more.filter((i) => !seen.has(i.number))];
        return {
          issues: appended,
          issuesPage: nextPage,
          issuesHasMore: hasMore,
          isLoadingMoreIssues: false,
        };
      });
    } catch (e) {
      if (!isAuthorityCurrent(authority, get())) return;
      set({ error: String(e), isLoadingMoreIssues: false });
    }
  },

  loadMorePrs: async () => {
    const { config, prsPage, isLoadingMorePrs, prStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo || isLoadingMorePrs || !get().prsHasMore) {
      return;
    }
    const authority = captureAuthority(get());
    set({ isLoadingMorePrs: true });
    const nextPage = prsPage + 1;
    try {
      const json = await githubListPrsPage(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        prStateFilter,
        nextPage,
      );
      const more: GitHubPr[] = JSON.parse(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => {
        const seen = new Set(s.prs.map((p) => p.number));
        const appended = [...s.prs, ...more.filter((p) => !seen.has(p.number))];
        return {
          prs: appended,
          prsPage: nextPage,
          prsHasMore: more.length >= 30,
          isLoadingMorePrs: false,
        };
      });
    } catch (e) {
      if (!isAuthorityCurrent(authority, get())) return;
      set({ error: String(e), isLoadingMorePrs: false });
    }
  },

  loadMoreRepos: async () => {
    const { reposPage, isLoadingMoreRepos } = get();
    if (!get().isConnected || isLoadingMoreRepos || !get().reposHasMore) {
      return;
    }
    const authority = captureAuthority(get());
    set({ isLoadingMoreRepos: true });
    const nextPage = reposPage + 1;
    try {
      const json = await githubListReposPage(nextPage);
      const more: GitHubRepo[] = JSON.parse(json);
      if (!isAuthorityCurrent(authority, get())) return;
      set((s) => {
        const seen = new Set(s.repos.map((r) => r.id));
        const appended = [...s.repos, ...more.filter((r) => !seen.has(r.id))];
        return {
          repos: appended,
          reposPage: nextPage,
          reposHasMore: more.length >= 30,
          isLoadingMoreRepos: false,
        };
      });
    } catch (e) {
      if (!isAuthorityCurrent(authority, get())) return;
      set({ error: String(e), isLoadingMoreRepos: false });
    }
  },

  // v0.8: persisted GitHub settings (Settings → GitHub).
  defaultMergeStrategy: loadedSettings.defaultMergeStrategy,
  requireMergeConfirmation: loadedSettings.requireMergeConfirmation,
  defaultDraftPrs: loadedSettings.defaultDraftPrs,
  defaultPublishAttemptsAsPrs: loadedSettings.defaultPublishAttemptsAsPrs,

  setDefaultMergeStrategy: (strategy) => {
    set({ defaultMergeStrategy: strategy });
    saveSettings({
      defaultMergeStrategy: strategy,
      requireMergeConfirmation: get().requireMergeConfirmation,
      defaultDraftPrs: get().defaultDraftPrs,
      defaultPublishAttemptsAsPrs: get().defaultPublishAttemptsAsPrs,
    });
  },
  setRequireMergeConfirmation: (require) => {
    set({ requireMergeConfirmation: require });
    saveSettings({
      defaultMergeStrategy: get().defaultMergeStrategy,
      requireMergeConfirmation: require,
      defaultDraftPrs: get().defaultDraftPrs,
      defaultPublishAttemptsAsPrs: get().defaultPublishAttemptsAsPrs,
    });
  },
  setDefaultDraftPrs: (draft) => {
    set({ defaultDraftPrs: draft });
    saveSettings({
      defaultMergeStrategy: get().defaultMergeStrategy,
      requireMergeConfirmation: get().requireMergeConfirmation,
      defaultDraftPrs: draft,
      defaultPublishAttemptsAsPrs: get().defaultPublishAttemptsAsPrs,
    });
  },
  setDefaultPublishAttemptsAsPrs: (publish) => {
    set({ defaultPublishAttemptsAsPrs: publish });
    saveSettings({
      defaultMergeStrategy: get().defaultMergeStrategy,
      requireMergeConfirmation: get().requireMergeConfirmation,
      defaultDraftPrs: get().defaultDraftPrs,
      defaultPublishAttemptsAsPrs: publish,
    });
  },

  // v0.8-E: AI PR-review cache (see interface comment for shape).
  prAiReviews: {},

  setPrAiReview: (pr, markdown) =>
    set((state) => {
      const repo = state.config.selectedRepo;
      if (!repo) return state;
      const key = prCacheKey(repo.owner, repo.repo, pr.number);
      return { prAiReviews: { ...state.prAiReviews, [key]: markdown } };
    }),

  clearPrAiReview: (pr) =>
    set((state) => {
      const repo = state.config.selectedRepo;
      if (!repo) return state;
      const key = prCacheKey(repo.owner, repo.repo, pr.number);
      const next = { ...state.prAiReviews };
      delete next[key];
      return { prAiReviews: next };
    }),

  // === Notifications inbox ==================================================
  notifications: [],
  notificationsLoading: false,
  notificationsError: null,
  unreadCount: 0,

  fetchNotifications: async () => {
    if (!get().isConnected) return;
    const authority = captureAuthority(get());
    set({ notificationsLoading: true, notificationsError: null });
    try {
      const notifications = await githubListNotifications(false);
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        notifications,
        unreadCount: notifications.filter((n) => n.unread).length,
        notificationsLoading: false,
      });
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) return;
      set({
        notificationsError: message,
        notificationsLoading: false,
        isConnected: isTokenError(message) ? false : get().isConnected,
      });
    }
  },

  markNotificationRead: async (threadId) => {
    const authority = captureAuthority(get());
    const target = get().notifications.find((n) => n.id === threadId);
    // Nothing to do if it's already read / unknown.
    if (!target || !target.unread) return;
    // Optimistic: flip to read locally and drop the unread count.
    set((s) => ({
      notifications: s.notifications.map((n) => (n.id === threadId ? { ...n, unread: false } : n)),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }));
    try {
      await githubMarkNotificationRead(threadId);
    } catch (e) {
      const message = String(e);
      if (!isAuthorityCurrent(authority, get())) return;
      // Roll back the optimistic update. Recompute unreadCount from the
      // (rolled-back) array rather than blindly re-incrementing, so a refetch
      // that replaced the list mid-flight can't leave the badge over-counting.
      set((s) => {
        const notifications = s.notifications.map((n) =>
          n.id === threadId ? { ...n, unread: true } : n,
        );
        return {
          notifications,
          unreadCount: notifications.filter((n) => n.unread).length,
          notificationsError: message,
          isConnected: isTokenError(message) ? false : s.isConnected,
        };
      });
      // Error is surfaced via notificationsError; don't rethrow (callers invoke
      // this as fire-and-forget, so a throw becomes an unhandled rejection).
    }
  },

  clearError: () => set({ error: null }),
  clearInvestigation: () => {
    investigationRequestSequence += 1;
    set({ investigation: null, isInvestigating: false });
  },
}));
