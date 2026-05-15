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
}

export interface GitHubConfig {
  selectedRepo: { owner: string; repo: string } | null;
}
