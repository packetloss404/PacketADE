import { create } from "zustand";
import {
  githubClearToken,
  githubCloseIssue,
  githubCreatePr,
  githubGetAuthenticatedUser,
  githubGetPrChecks,
  githubHasToken,
  githubInvestigateIssue,
  githubListIssueComments,
  githubListIssues,
  githubListIssuesPage,
  githubListPrsPage,
  githubListReposPage,
  githubListRepos,
  githubPostIssueComment,
  githubReopenIssue,
  githubSetIssueAssignees,
  githubSetIssueLabels,
  githubSetIssueMilestone,
  githubSetToken,
  githubListPrs,
  githubGetPrDiff,
} from "@/lib/tauri";
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

const STORAGE_KEY = "packetade:github";
const SETTINGS_STORAGE_KEY = "packetade:github:settings";

/** v0.8: persisted GitHub-side defaults the user can tweak in Settings → GitHub. */
export type GitHubMergeStrategy = "merge" | "squash" | "rebase";

export interface GitHubSettings {
  defaultMergeStrategy: GitHubMergeStrategy;
  /** Show inline confirm step before merge/close/convert-to-draft. */
  requireMergeConfirmation: boolean;
  /** Pre-check the "Open as draft" box in the New PR modal. */
  defaultDraftPrs: boolean;
  /** Pre-check "Publish attempts as draft PRs" in the async Mission launcher. */
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
  prDiff: string | null;
  isPrLoading: boolean;
  /** Unix millis of the last successful repos/issues/PRs fetch. */
  lastSyncAt: number | null;

  initializeAuth: () => Promise<void>;
  connect: (token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  fetchRepos: () => Promise<void>;
  selectRepo: (owner: string, repo: string) => void;
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
  prDiff: null,
  isPrLoading: false,
  lastSyncAt: null,

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
    set({ isInitializing: true, error: null });
    try {
      let hasToken = await githubHasToken();
      if (!hasToken && pendingLegacyToken) {
        await githubSetToken(pendingLegacyToken);
        hasToken = true;
      }

      // One-time migration: rewrite persisted config without token.
      if (pendingLegacyToken) {
        pendingLegacyToken = null;
        saveConfig(get().config);
      }

      let authenticatedUser: AuthenticatedUser | null = null;
      if (hasToken) {
        try {
          authenticatedUser = await githubGetAuthenticatedUser();
        } catch (e) {
          // Token may be stale/invalid — leave user null; badge falls back to
          // "user" and the next API call will surface a clearer error. Surface
          // the failure so a broken probe doesn't silently mask real issues.
          logSwallowed("githubStore.initializeAuth.userProbe")(e);
        }
      }

      set({
        isConnected: hasToken,
        isInitializing: false,
        authenticatedUser,
      });
    } catch (e) {
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
    set({ isLoading: true, error: null });
    try {
      await githubSetToken(trimmed);
      pendingLegacyToken = null;
      let authenticatedUser: AuthenticatedUser | null = null;
      try {
        authenticatedUser = await githubGetAuthenticatedUser();
      } catch (e) {
        // Don't fail connect on the probe; the badge will show "user" until
        // the next refresh.
        logSwallowed("githubStore.connect.userProbe")(e);
      }
      set({
        isConnected: true,
        isLoading: false,
        authenticatedUser,
        repos: [],
        issues: [],
      });
    } catch (e) {
      set({
        isConnected: false,
        isLoading: false,
        authenticatedUser: null,
        error: String(e),
      });
    }
  },

  disconnect: async () => {
    set({ isLoading: true, error: null });
    try {
      await githubClearToken();
      set({
        isConnected: false,
        isLoading: false,
        authenticatedUser: null,
        repos: [],
        issues: [],
        lastSyncAt: null,
      });
    } catch (e) {
      set({
        isLoading: false,
        error: String(e),
      });
    }
  },

  fetchRepos: async () => {
    if (!get().isConnected) return;
    set({ isLoading: true, error: null });
    try {
      // v0.8-C: route through the paginated endpoint so we can compute
      // `reposHasMore` from the response cardinality (page-size 30).
      const json = await githubListReposPage(1);
      const repos: GitHubRepo[] = JSON.parse(json);
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
      set({
        isConnected: isTokenError(message) ? false : get().isConnected,
        error: message,
        isLoading: false,
      });
    }
  },

  selectRepo: (owner, repo) => {
    const config = { ...get().config, selectedRepo: { owner, repo } };
    saveConfig(config);
    set({
      config,
      issues: [],
      issuesPage: 1,
      issuesHasMore: false,
      prs: [],
      prsPage: 1,
      prsHasMore: false,
    });
  },

  fetchIssues: async () => {
    const { config, issueStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo) return;
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
    set({ isInvestigating: true, investigation: null });
    try {
      const result = await githubInvestigateIssue(
        projectPath,
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issueNumber,
      );
      set({ investigation: result, isInvestigating: false });
    } catch (e) {
      const message = String(e);
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
      set({ isLoading: false });
      return json;
    } catch (e) {
      const message = String(e);
      set({
        isConnected: isTokenError(message) ? false : get().isConnected,
        error: message,
        isLoading: false,
      });
      throw e;
    }
  },

  fetchPrs: async () => {
    const { config, prStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    set({ isPrLoading: true, error: null });
    try {
      const json = await githubListPrsPage(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        prStateFilter,
        1,
      );
      const prs: GitHubPr[] = JSON.parse(json);
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
      set({ error: message, isPrLoading: false });
    }
  },

  getPrDiff: async (prNumber) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
    set({ isPrLoading: true, prDiff: null });
    try {
      const diff = await githubGetPrDiff(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        prNumber,
      );
      set({ prDiff: diff, isPrLoading: false });
    } catch (e) {
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
    const key = `${config.selectedRepo.owner}/${config.selectedRepo.repo}#${pr.number}`;
    if (!options?.force && get().prChecks[key]) return;
    set((s) => ({ prChecksLoading: { ...s.prChecksLoading, [key]: true } }));
    try {
      const checks = await githubGetPrChecks(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        pr.number,
      );
      set((s) => ({
        prChecks: { ...s.prChecks, [key]: checks },
        prChecksLoading: { ...s.prChecksLoading, [key]: false },
        prChecksError: { ...s.prChecksError, [key]: "" },
      }));
    } catch (e) {
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
    set({ issueStateFilter: state, issues: [] });
    void get().fetchIssues();
  },

  setPrStateFilter: (state) => {
    if (get().prStateFilter === state) return;
    set({ prStateFilter: state, prs: [] });
    void get().fetchPrs();
  },

  fetchIssueComments: async (issue) => {
    const { config } = get();
    if (!get().isConnected || !config.selectedRepo) return;
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
    const key = issueCommentsKey(config.selectedRepo.owner, config.selectedRepo.repo, issue.number);
    try {
      const created = await githubPostIssueComment(
        config.selectedRepo.owner,
        config.selectedRepo.repo,
        issue.number,
        trimmed,
      );
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
      // Success: reconcile with the server (handles GitHub-side
      // normalization). On error we skip this — the rollback above is
      // the authoritative final state, and a redundant fetch would just
      // burn a rate-limit token.
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
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
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
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
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
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
      void get().fetchIssues();
    } catch (e) {
      const message = String(e);
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
      set({ error: String(e), isLoadingMoreIssues: false });
    }
  },

  loadMorePrs: async () => {
    const { config, prsPage, isLoadingMorePrs, prStateFilter } = get();
    if (!get().isConnected || !config.selectedRepo || isLoadingMorePrs || !get().prsHasMore) {
      return;
    }
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
      set({ error: String(e), isLoadingMorePrs: false });
    }
  },

  loadMoreRepos: async () => {
    const { reposPage, isLoadingMoreRepos } = get();
    if (!get().isConnected || isLoadingMoreRepos || !get().reposHasMore) {
      return;
    }
    set({ isLoadingMoreRepos: true });
    const nextPage = reposPage + 1;
    try {
      const json = await githubListReposPage(nextPage);
      const more: GitHubRepo[] = JSON.parse(json);
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

  clearError: () => set({ error: null }),
  clearInvestigation: () => set({ investigation: null }),
}));
