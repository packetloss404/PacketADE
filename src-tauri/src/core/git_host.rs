//! Git host provider abstraction — cloud **GitHub** + self-hosted
//! **Gitea/Forgejo**. Mirrors the `LlmProvider` pattern (one seam, per-host
//! behaviour) so the ~45 `commands/github.rs` operations can target either host
//! by resolving the active connection instead of hardcoding `api.github.com`.
//!
//! G1 introduces the seam and routes client construction through it (GitHub
//! behaviour byte-identical). Per-command base-URL threading and the Gitea
//! divergences (pagination, diff-via-suffix, merge body, draft mechanism,
//! review-comment model, notifications mark-read) land with G4–G12.

use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT as HDR_USER_AGENT};
use serde::{Deserialize, Serialize};

/// Which kind of git host a connection points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitHostKind {
    GitHub,
    /// Gitea and its fork Forgejo share the same `/api/v1` surface.
    Gitea,
}

/// A resolved git-host connection: which kind, and the API base URL to hit.
/// For GitHub this is always `https://api.github.com`; for Gitea it is the
/// user's `{baseUrl}/api/v1`.
#[derive(Clone, Debug)]
pub struct GitHost {
    pub kind: GitHostKind,
    pub api_base: String,
}

impl GitHost {
    /// The canonical GitHub cloud host.
    pub fn github() -> Self {
        Self {
            kind: GitHostKind::GitHub,
            api_base: "https://api.github.com".to_string(),
        }
    }

    /// A Gitea/Forgejo host rooted at the user-supplied instance URL. The
    /// `/api/v1` suffix is appended (idempotently) so callers pass the bare
    /// instance origin (e.g. `https://git.example.com`).
    pub fn gitea(instance_url: &str) -> Self {
        let trimmed = instance_url.trim().trim_end_matches('/');
        let api_base = if trimmed.ends_with("/api/v1") {
            trimmed.to_string()
        } else {
            format!("{}/api/v1", trimmed)
        };
        Self {
            kind: GitHostKind::Gitea,
            api_base,
        }
    }

    /// Build `{api_base}{path}` — `path` must start with `/`. GitHub and Gitea
    /// share the same path grammar (`/repos/{o}/{r}/…`, `/user`, …) under
    /// different bases, so most call sites differ only by this prefix.
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    /// Pagination query fragment — GitHub uses `per_page`, Gitea uses `limit`.
    /// Both accept `page`. Returned without a leading `?`/`&`.
    pub fn page_params(&self, per_page: u32, page: u32) -> String {
        match self.kind {
            GitHostKind::GitHub => format!("per_page={}&page={}", per_page, page),
            GitHostKind::Gitea => format!("limit={}&page={}", per_page, page),
        }
    }

    /// Path for the authenticated user's repos, page `page` (30/page). GitHub
    /// sorts by last-updated; Gitea's `/user/repos` returns all owned repos.
    pub fn user_repos_path(&self, page: u32) -> String {
        match self.kind {
            GitHostKind::GitHub => {
                format!("/user/repos?sort=updated&{}", self.page_params(30, page))
            }
            GitHostKind::Gitea => format!("/user/repos?{}", self.page_params(30, page)),
        }
    }

    /// Authorization header value. GitHub uses `Bearer`; Gitea uses `token`
    /// (Gitea also accepts `Bearer`, but `token` is its documented scheme).
    fn auth_header(&self, token: &str) -> String {
        match self.kind {
            GitHostKind::GitHub => format!("Bearer {}", token),
            GitHostKind::Gitea => format!("token {}", token),
        }
    }

    /// Default `Accept` for JSON responses (per-request overrides — e.g. the
    /// GitHub diff media type — are applied at the call site).
    fn accept_header(&self) -> &'static str {
        match self.kind {
            GitHostKind::GitHub => "application/vnd.github+json",
            GitHostKind::Gitea => "application/json",
        }
    }

    /// Build an authenticated `reqwest::Client` for this host. For GitHub this
    /// reproduces the previous `github_client` exactly (Bearer + vnd.github+json
    /// + the brand user-agent).
    pub fn build_client(&self, token: &str) -> Result<reqwest::Client, String> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            self.auth_header(token)
                .parse()
                .map_err(|e| format!("Invalid header: {}", e))?,
        );
        headers.insert(
            ACCEPT,
            self.accept_header()
                .parse()
                .map_err(|e| format!("Invalid header: {}", e))?,
        );
        headers.insert(
            HDR_USER_AGENT,
            crate::core::brand::USER_AGENT
                .parse()
                .map_err(|e| format!("Invalid header: {}", e))?,
        );

        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_host_base_and_url() {
        let h = GitHost::github();
        assert_eq!(h.kind, GitHostKind::GitHub);
        assert_eq!(h.api_base, "https://api.github.com");
        assert_eq!(
            h.url("/repos/o/r/issues"),
            "https://api.github.com/repos/o/r/issues"
        );
        assert_eq!(h.auth_header("tok"), "Bearer tok");
        assert_eq!(h.accept_header(), "application/vnd.github+json");
    }

    #[test]
    fn gitea_host_appends_api_v1_idempotently() {
        assert_eq!(
            GitHost::gitea("https://git.example.com").api_base,
            "https://git.example.com/api/v1"
        );
        assert_eq!(
            GitHost::gitea("https://git.example.com/").api_base,
            "https://git.example.com/api/v1"
        );
        // already-suffixed input is not doubled
        assert_eq!(
            GitHost::gitea("https://git.example.com/api/v1").api_base,
            "https://git.example.com/api/v1"
        );
        let h = GitHost::gitea("https://git.example.com");
        assert_eq!(h.auth_header("tok"), "token tok");
        assert_eq!(h.accept_header(), "application/json");
        assert_eq!(
            h.url("/repos/o/r/pulls"),
            "https://git.example.com/api/v1/repos/o/r/pulls"
        );
    }

    #[test]
    fn pagination_and_repos_paths_differ_by_host() {
        let gh = GitHost::github();
        let gt = GitHost::gitea("https://git.example.com");
        assert_eq!(gh.page_params(30, 2), "per_page=30&page=2");
        assert_eq!(gt.page_params(30, 2), "limit=30&page=2");
        // GitHub keeps its sort=updated; both carry page params.
        assert_eq!(
            gh.user_repos_path(2),
            "/user/repos?sort=updated&per_page=30&page=2"
        );
        assert_eq!(gt.user_repos_path(2), "/user/repos?limit=30&page=2");
    }
}
