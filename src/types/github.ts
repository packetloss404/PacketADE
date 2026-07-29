export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  html_url: string;
  updated_at: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string; color: string }[];
  user: { login: string };
  html_url: string;
  created_at: string;
  updated_at?: string;
  /** v0.8-C: assignees populated by GitHub's /issues endpoint. */
  assignees?: { login: string; avatar_url?: string }[];
  /** v0.8-C: milestone populated by GitHub's /issues endpoint. */
  milestone?: { number: number; title: string } | null;
}

export interface GitHubPr {
  number: number;
  title: string;
  user: { login: string } | null;
  head: { ref: string } | null;
  base: { ref: string } | null;
  html_url: string;
  state: string;
  created_at: string;
  /**
   * Present on GitHub's `/pulls` LIST endpoint. Other size/review fields
   * (additions, deletions, changed_files, requested_reviewers) are NOT
   * returned by the list endpoint — they require a per-PR fetch and are
   * intentionally omitted from this type to prevent fake-zero rendering
   * in the PR list (see GitHubView FIX 3 in v0.7).
   */
  draft?: boolean;
  /**
   * v0.8-A: present on `GET /pulls/{n}` (single-PR fetch) but NOT on the
   * list endpoint. The PRActionBar relies on it to render the "Merged"
   * pill — when absent it falls back to state==="closed" with `merged_at`
   * set as a hint.
   */
  merged?: boolean;
  merged_at?: string | null;
}

// === v0.8-B: CI / check-run DTOs ===========================================
//
// Mirrors the Rust DTOs in `src-tauri/src/commands/github.rs`. Field names
// are camelCase here because the Rust side renames via `#[serde(rename)]`
// to match this contract.

export type GitHubCheckCombinedState =
  | "success"
  | "failure"
  | "pending"
  | "neutral"
  | "skipped"
  | "none";

export interface GitHubCheckRun {
  id: number;
  name: string;
  /** `queued | in_progress | completed`. Legacy statuses are flattened to
   *  `completed` (or `in_progress` when the legacy state was `pending`). */
  status: string;
  /** `success | failure | neutral | cancelled | skipped | timed_out |
   *  action_required` — only present when `status === "completed"`. */
  conclusion: string | null;
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  appName: string | null;
}

export interface GitHubPrChecks {
  combinedState: GitHubCheckCombinedState;
  total: number;
  passing: number;
  failing: number;
  pending: number;
  runs: GitHubCheckRun[];
}

export interface GitHubConfig {
  selectedRepo: { owner: string; repo: string } | null;
}

// v0.8-C: issue comments DTO returned by `github_list_issue_comments` /
// `github_post_issue_comment`.
export interface GitHubIssueComment {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

// v0.8-C: repo label/milestone/assignable user pickers.
export interface GitHubLabel {
  id?: number;
  name: string;
  color: string;
  description?: string | null;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  state: string;
  description?: string | null;
}

export interface GitHubAssignableUser {
  login: string;
  avatar_url: string;
}

// v0.8-F: AI triage suggestion per issue. Matches the Rust DTO in
// `commands/github.rs::TriageSuggestion`. `duplicateOf` is omitted (not
// set to null) when there is no duplicate, because the Rust side uses
// `skip_serializing_if = "Option::is_none"`.
export interface TriageSuggestion {
  number: number;
  suggestedLabels: string[];
  priority: "P0" | "P1" | "P2" | "P3" | string;
  rationale: string;
  duplicateOf?: number;
}

// v0.8-F: shape consumed by `AITriageDrawer.onApply`. The drawer collects
// the user's accepted labels per issue and passes them up so the caller
// can fan out the actual `github_set_issue_labels` calls.
export interface TriageChanges {
  /** Map from issue number → labels to set on that issue. */
  labelsByIssue: Record<number, string[]>;
}
