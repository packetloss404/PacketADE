//! Git host provider abstraction — cloud **GitHub**, self-hosted
//! **Gitea/Forgejo**, and **GitLab** (gitlab.com + self-hosted).
//!
//! ## Why this file grew a real abstraction
//!
//! The first version of this seam was ~200 lines because GitHub and Gitea
//! agree on *path grammar* (`/repos/{owner}/{repo}/…`) and on *vocabulary*
//! ("pull request", `state=open`, `{"state":"closed"}`). The only divergences
//! were the API base URL and a handful of query/verb details, so callers could
//! keep building paths inline with `format!("/repos/{}/{}/issues", …)` and hand
//! the string to [`GitHost::url`].
//!
//! GitLab breaks both assumptions at once:
//!
//! | | GitHub / Gitea | GitLab |
//! |---|---|---|
//! | repo address | two path segments `/repos/{o}/{r}` | one URL-encoded segment `/projects/{o%2Fr}` |
//! | change request | "pull request", `/pulls` | "merge request", `/merge_requests` |
//! | id in the path | repo-scoped `number` | project-scoped `iid` (NOT the global `id`) |
//! | open state | `open` | `opened` |
//! | state change | `PATCH {"state":"closed"}` | `PUT {"state_event":"close"}` |
//! | auth header | `Authorization:` | `PRIVATE-TOKEN:` |
//! | branch/issue JSON | `number` / `body` / `html_url` | `iid` / `description` / `web_url` |
//!
//! So a `GitHost::gitlab(url)` constructor would be a lie: `url()` receives a
//! pre-formatted *GitHub-grammar* path, and the GitLab arm would have to parse
//! it back into components to re-render it. Instead the seam is split in two,
//! and both halves are pure functions so they are fully testable without a
//! live instance:
//!
//! * **Outbound** — [`RepoRef`] is a host-neutral repo coordinate, and every
//!   path/body a command needs is a *named method* on [`GitHost`] that takes
//!   structured arguments and renders host-specific grammar. No caller
//!   `format!`s a path any more. (This extends the shape the file already had
//!   — `user_repos_path`, `pr_diff_path`, `page_params` — from three
//!   divergences to every one of them.)
//! * **Inbound** — the canonical wire shape is **GitHub's**, because the whole
//!   frontend (`src/types/github.ts`, `GitHubView`, `githubStore`) is already
//!   written against it. GitLab responses are projected into that shape by the
//!   `normalize_*` functions here, so nothing above Rust learns a third
//!   vocabulary.
//!
//! A third piece, [`HostCapability`], replaces the old `if kind == Gitea {
//! refuse }` deny-list guards. Those failed **open**: a host kind the guard had
//! never heard of sailed through and the command then fired the GitHub token at
//! `api.github.com` carrying that host's ids. Capabilities are an explicit
//! per-kind allow-list, so an unlisted host is refused by construction.

use reqwest::header::{HeaderName, ACCEPT, AUTHORIZATION, USER_AGENT as HDR_USER_AGENT};
use serde::{Deserialize, Serialize};

/// GitLab authenticates with a bespoke header rather than `Authorization`.
/// Personal/project/group access tokens all go here.
const PRIVATE_TOKEN: &str = "private-token";

/// Which kind of git host a connection points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitHostKind {
    GitHub,
    /// Gitea and its fork Forgejo share the same `/api/v1` surface.
    Gitea,
    /// GitLab CE/EE — `gitlab.com` and self-hosted alike, `/api/v4`.
    GitLab,
}

impl GitHostKind {
    /// Human display name.
    pub fn label(&self) -> &'static str {
        match self {
            GitHostKind::GitHub => "GitHub",
            GitHostKind::Gitea => "Gitea",
            GitHostKind::GitLab => "GitLab",
        }
    }

    /// What this host calls a change request, for user-facing prose. Keeping
    /// the noun here means error strings can be host-correct without every
    /// call site learning a `match`.
    pub fn change_request_noun(&self) -> &'static str {
        match self {
            GitHostKind::GitLab => "merge request",
            _ => "pull request",
        }
    }
}

// ============================================================================
// Capabilities — an allow-list, not a deny-list
// ============================================================================

/// A host-specific feature a command depends on.
///
/// Guards used to read `if active_host_kind() == Gitea { refuse }`. That is a
/// deny-list, and a deny-list fails **open**: the day a third kind appeared,
/// every one of those guards passed and the command went on to hit its
/// hardcoded `https://api.github.com/...` URL with the *other* host's token and
/// ids. Every arm below is written out explicitly so adding a fourth kind is a
/// compile error, not a silent credential leak.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostCapability {
    /// Authoring line-anchored review comments on a diff.
    InlineReviewComments,
    /// Formal review objects (approve / request-changes) listed per PR.
    PrReviews,
    /// Draft ⇄ ready toggle on an existing change request.
    DraftToggle,
    /// The modern check-runs API.
    CheckRuns,
    /// A typed repository activity feed (GitHub's Events API).
    ActivityFeed,
    /// The in-app notification inbox.
    Notifications,
    /// Requesting reviewers on an existing change request.
    RequestReviewers,
    /// Assigning issues by *login string*. GitLab takes numeric `assignee_ids`,
    /// which the frontend has no way to supply, so it is refused rather than
    /// silently dropped.
    AssigneesByLogin,
    /// Milestones addressed by a numeric id the frontend already holds.
    Milestones,
    /// The AI-assist commands (`github_ai_*`, `github_investigate_issue`).
    /// They build `https://api.github.com/...` URLs directly, so they are
    /// GitHub-only by construction, not by preference.
    AiAssist,
}

impl GitHost {
    /// Whether this host supports `cap`. Exhaustive on purpose — see
    /// [`HostCapability`].
    pub fn supports(&self, cap: HostCapability) -> bool {
        use GitHostKind::*;
        use HostCapability::*;
        match cap {
            InlineReviewComments => matches!(self.kind, GitHub),
            // Gitea serves `/pulls/{n}/reviews`; GitLab has no review objects
            // at all (approvals are a separate, Premium-tier concept).
            PrReviews => matches!(self.kind, GitHub | Gitea),
            DraftToggle => matches!(self.kind, GitHub),
            CheckRuns => matches!(self.kind, GitHub),
            ActivityFeed => matches!(self.kind, GitHub),
            // GitLab's analogue is Todos, a different resource with a different
            // shape; v1 does not pretend otherwise.
            Notifications => matches!(self.kind, GitHub | Gitea),
            // Gitea has the same `requested_reviewers` sub-resource taking
            // logins; GitLab takes numeric `reviewer_ids` on the MR itself.
            RequestReviewers => matches!(self.kind, GitHub | Gitea),
            AssigneesByLogin => matches!(self.kind, GitHub | Gitea),
            Milestones => matches!(self.kind, GitHub | Gitea | GitLab),
            AiAssist => matches!(self.kind, GitHub),
        }
    }

    /// The error a refused capability produces. Names the host that was
    /// actually active so the user isn't told to check a token they never set.
    pub fn unsupported(&self, cap: HostCapability) -> String {
        // (subject, plural) — the verb is carried explicitly rather than
        // sniffed from a trailing "s", which got "Requesting reviewers" wrong.
        let (what, plural) = match cap {
            HostCapability::InlineReviewComments => ("Inline review comments", true),
            HostCapability::PrReviews => ("Reviews", true),
            HostCapability::DraftToggle => ("The draft toggle", false),
            HostCapability::CheckRuns => ("Check runs", true),
            HostCapability::ActivityFeed => ("The activity feed", false),
            HostCapability::Notifications => ("Notifications", true),
            HostCapability::RequestReviewers => ("Requesting reviewers", false),
            HostCapability::AssigneesByLogin => ("Assigning by username", false),
            HostCapability::Milestones => ("Milestones", true),
            HostCapability::AiAssist => ("This AI feature", false),
        };
        let hint = match (self.kind, cap) {
            (GitHostKind::Gitea, HostCapability::DraftToggle) => {
                " — prefix the title with \"WIP:\" instead"
            }
            (GitHostKind::GitLab, HostCapability::DraftToggle) => {
                " — prefix the title with \"Draft:\" instead"
            }
            (GitHostKind::Gitea, HostCapability::InlineReviewComments)
            | (GitHostKind::GitLab, HostCapability::InlineReviewComments) => {
                " — post a regular comment instead"
            }
            (GitHostKind::GitLab, HostCapability::AssigneesByLogin) => {
                " — GitLab assigns by numeric user id; set it in GitLab"
            }
            _ => "",
        };
        format!(
            "{} {} supported on {}{}.",
            what,
            if plural { "aren't" } else { "isn't" },
            self.kind.label(),
            hint
        )
    }
}

// ============================================================================
// RepoRef — a host-neutral repository coordinate
// ============================================================================

/// Percent-encode one path segment, keeping only RFC 3986 unreserved
/// characters. GitLab addresses a project as a *single* segment holding the
/// full namespace path, so `group/sub/proj` must arrive as
/// `group%2Fsub%2Fproj`; a raw `/` would be read as a path separator and hit a
/// different (or nonexistent) endpoint.
fn percent_encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

/// A repository coordinate, independent of how a host spells it.
///
/// `owner` may contain `/` — GitLab subgroups (`group/subgroup`) are a normal
/// namespace there. Each slash-separated part is validated on construction, so
/// even on GitHub/Gitea (where a slashed owner simply 404s) nothing can smuggle
/// `..`, a query string, or a fragment into the URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoRef {
    owner: String,
    repo: String,
}

impl RepoRef {
    /// Validate and build. `field` names appear verbatim in error messages,
    /// matching the pre-existing `validate_github_name` wording.
    pub fn new(owner: &str, repo: &str) -> Result<Self, String> {
        let owner = owner.trim();
        let repo = repo.trim();
        if owner.is_empty() {
            return Err("owner cannot be empty".to_string());
        }
        // A namespace may nest (GitLab subgroups); every part still has to be a
        // plain name. Cap the depth so a pathological input can't build a
        // multi-kilobyte URL.
        let parts: Vec<&str> = owner.split('/').collect();
        if parts.len() > 8 {
            return Err("owner has too many namespace levels".to_string());
        }
        for part in parts {
            validate_name_part(part, "owner")?;
        }
        validate_name_part(repo, "repo")?;
        Ok(Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    pub fn repo(&self) -> &str {
        &self.repo
    }

    /// `owner/repo` — the human-readable full path (also GitLab's project
    /// path before encoding).
    pub fn full_path(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// One slash-separated part of an owner, or a repo name.
fn validate_name_part(name: &str, field: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{} cannot be empty", field));
    }
    if name.len() > 100 {
        return Err(format!("{} is too long", field));
    }
    // Reject `.`/`..` outright: they are made of allowed characters but are
    // path traversal once interpolated into a URL.
    if name == "." || name == ".." {
        return Err(format!("{} contains invalid characters", field));
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "{} contains invalid characters (allowed: alphanumeric, -, _, .)",
            field
        ));
    }
    Ok(())
}

// ============================================================================
// GitHost
// ============================================================================

/// A resolved git-host connection: which kind, and the API base URL to hit.
#[derive(Clone, Debug)]
pub struct GitHost {
    pub kind: GitHostKind,
    pub api_base: String,
}

/// Which issue/change-request states a listing can ask for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListState {
    Open,
    Closed,
    All,
}

impl ListState {
    /// Parse the frontend's string, defaulting unknown input to `Open` (the
    /// pre-existing behaviour of every `match state.as_str()` call site).
    pub fn parse(s: &str) -> Self {
        match s {
            "closed" => ListState::Closed,
            "all" => ListState::All,
            _ => ListState::Open,
        }
    }
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
        Self {
            kind: GitHostKind::Gitea,
            api_base: api_base_with_suffix(instance_url, "/api/v1"),
        }
    }

    /// A GitLab host rooted at the user-supplied instance URL — this is the
    /// *same* constructor for `https://gitlab.com` and for a self-hosted
    /// instance, because GitLab exposes `/api/v4` under the instance origin in
    /// both cases (there is no `api.gitlab.com` split-host arrangement).
    pub fn gitlab(instance_url: &str) -> Self {
        Self {
            kind: GitHostKind::GitLab,
            api_base: api_base_with_suffix(instance_url, "/api/v4"),
        }
    }

    /// Build a host from a kind + stored base URL.
    pub fn from_parts(kind: GitHostKind, base_url: &str) -> Self {
        match kind {
            GitHostKind::GitHub => Self::github(),
            GitHostKind::Gitea => Self::gitea(base_url),
            GitHostKind::GitLab => Self::gitlab(base_url),
        }
    }

    /// Build `{api_base}{path}` — `path` must start with `/`.
    ///
    /// Prefer the named path methods below; this stays public only for the
    /// GitHub-gated commands that legitimately target one fixed endpoint.
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    /// The **browser** origin for this host, as opposed to its API base.
    ///
    /// GitHub is the only one where the two differ (`api.github.com` vs
    /// `github.com`); for the self-hosted kinds it is the API base with the
    /// version suffix stripped back off. Needed wherever an API URL has to be
    /// rewritten into something a user can click.
    pub fn web_base(&self) -> String {
        match self.kind {
            GitHostKind::GitHub => "https://github.com".to_string(),
            GitHostKind::Gitea => self
                .api_base
                .trim_end_matches("/api/v1")
                .trim_end_matches('/')
                .to_string(),
            GitHostKind::GitLab => self
                .api_base
                .trim_end_matches("/api/v4")
                .trim_end_matches('/')
                .to_string(),
        }
    }

    // ---- pagination -------------------------------------------------------

    /// Pagination query fragment. GitHub and GitLab use `per_page`; Gitea uses
    /// `limit`. All three accept `page`. Returned without a leading `?`/`&`.
    pub fn page_params(&self, per_page: u32, page: u32) -> String {
        match self.kind {
            GitHostKind::Gitea => format!("limit={}&page={}", per_page, page),
            _ => format!("per_page={}&page={}", per_page, page),
        }
    }

    // ---- vocabulary -------------------------------------------------------

    /// The value of a `state=` filter for a listing.
    ///
    /// GitLab spells the open state `opened`, and expresses "all" by omitting
    /// the filter entirely — sending `state=all` there is not an error but is
    /// not documented either, so we omit.
    fn state_query(&self, state: ListState) -> String {
        let value = match (self.kind, state) {
            // GitLab spells the open state `opened` (its other MR states are
            // `locked` and `merged`); `closed` and `all` match.
            (GitHostKind::GitLab, ListState::Open) => "opened",
            (_, ListState::Open) => "open",
            (_, ListState::Closed) => "closed",
            (_, ListState::All) => "all",
        };
        format!("state={}&", value)
    }

    /// Body for closing/reopening an issue or change request.
    ///
    /// GitHub/Gitea PATCH the resource's `state`; GitLab PUTs a `state_event`
    /// *verb*. Getting this wrong is silent — GitLab ignores an unknown field
    /// and returns 200 with the resource unchanged.
    pub fn state_change_body(&self, open: bool) -> serde_json::Value {
        match self.kind {
            GitHostKind::GitLab => {
                serde_json::json!({ "state_event": if open { "reopen" } else { "close" } })
            }
            _ => serde_json::json!({ "state": if open { "open" } else { "closed" } }),
        }
    }

    /// HTTP verb for updating an issue / change request. GitLab uses PUT where
    /// GitHub and Gitea use PATCH.
    pub fn update_method(&self) -> reqwest::Method {
        match self.kind {
            GitHostKind::GitLab => reqwest::Method::PUT,
            _ => reqwest::Method::PATCH,
        }
    }

    /// Body for creating a change request.
    ///
    /// GitLab renames every field (`source_branch`/`target_branch`/
    /// `description`) and has no boolean draft flag — draft is the literal
    /// `Draft:` title prefix, applied here so callers keep one contract.
    pub fn create_change_request_body(
        &self,
        title: &str,
        body: &str,
        head: &str,
        base: &str,
        draft: Option<bool>,
    ) -> serde_json::Value {
        match self.kind {
            GitHostKind::GitLab => {
                let title = if draft == Some(true) && !is_draft_title(title) {
                    format!("Draft: {}", title)
                } else {
                    title.to_string()
                };
                serde_json::json!({
                    "title": title,
                    "description": body,
                    "source_branch": head,
                    "target_branch": base,
                })
            }
            GitHostKind::GitHub => {
                let mut v = serde_json::json!({
                    "title": title, "body": body, "head": head, "base": base,
                });
                if let Some(d) = draft {
                    v["draft"] = serde_json::Value::Bool(d);
                }
                v
            }
            // Gitea has no draft flag and no title convention we impose.
            GitHostKind::Gitea => serde_json::json!({
                "title": title, "body": body, "head": head, "base": base,
            }),
        }
    }

    /// Verb + body for merging a change request.
    ///
    /// GitHub `PUT {merge_method}`, Gitea `POST {Do}`, GitLab `PUT {squash}` —
    /// GitLab expresses squash as a boolean rather than a method name, and has
    /// **no rebase-on-merge parameter at all** (rebase is a separate
    /// `PUT …/rebase` endpoint). Mapping `rebase` onto `squash: false` there
    /// would silently produce a merge commit, so it is refused instead.
    pub fn merge_request_shape(
        &self,
        method: &str,
    ) -> Result<(reqwest::Method, serde_json::Value), String> {
        Ok(match self.kind {
            GitHostKind::GitHub => (
                reqwest::Method::PUT,
                serde_json::json!({ "merge_method": method }),
            ),
            GitHostKind::Gitea => (reqwest::Method::POST, serde_json::json!({ "Do": method })),
            GitHostKind::GitLab => {
                if method == "rebase" {
                    return Err(
                        "GitLab's merge endpoint has no rebase option — rebase the merge request \
                         first, then merge."
                            .to_string(),
                    );
                }
                (
                    reqwest::Method::PUT,
                    serde_json::json!({ "squash": method == "squash" }),
                )
            }
        })
    }

    /// Body for a full label replace.
    ///
    /// GitHub takes an array of label *names*; GitLab takes a **comma-separated
    /// string** — passing an array there is accepted but each element becomes
    /// one label, so `["a", "b"]` and `["a,b"]` are not the same thing and the
    /// latter would create a label literally named `a,b`. (Gitea takes an array
    /// of label *ids*, resolved by the caller against the repo's label set,
    /// because that needs a network round-trip.)
    pub fn labels_body_from_names(&self, names: &[String]) -> serde_json::Value {
        match self.kind {
            GitHostKind::GitLab => serde_json::json!({ "labels": names.join(",") }),
            _ => serde_json::json!({ "labels": names }),
        }
    }

    /// Body that sets (or clears) a milestone on an issue. GitHub's field is
    /// `milestone`; GitLab's is `milestone_id` and it matches on the milestone's
    /// **global** id — which is what [`normalize_milestone`] hands the frontend.
    pub fn milestone_body(&self, milestone: Option<u64>) -> serde_json::Value {
        let field = match self.kind {
            GitHostKind::GitLab => "milestone_id",
            _ => "milestone",
        };
        let value = match milestone {
            Some(n) => serde_json::Value::from(n),
            // GitLab clears with 0 (null is rejected as a non-integer);
            // GitHub/Gitea clear with an explicit null.
            None if self.kind == GitHostKind::GitLab => serde_json::Value::from(0),
            None => serde_json::Value::Null,
        };
        serde_json::json!({ field: value })
    }

    /// Whether a successful merge returns a parseable JSON body with
    /// `{sha, merged}`. Gitea returns an empty 2xx.
    pub fn merge_returns_body(&self) -> bool {
        !matches!(self.kind, GitHostKind::Gitea)
    }

    // ---- path grammar -----------------------------------------------------

    /// The repository/project root path. **The one method that carries the
    /// whole grammar difference**: two segments on GitHub/Gitea, one
    /// URL-encoded segment on GitLab.
    pub fn repo_base(&self, r: &RepoRef) -> String {
        match self.kind {
            GitHostKind::GitLab => {
                format!("/projects/{}", percent_encode_segment(&r.full_path()))
            }
            _ => format!("/repos/{}/{}", r.owner, r.repo),
        }
    }

    /// The change-request collection segment: `pulls` vs `merge_requests`.
    fn cr_segment(&self) -> &'static str {
        match self.kind {
            GitHostKind::GitLab => "merge_requests",
            _ => "pulls",
        }
    }

    /// `GET` the authenticated user.
    pub fn user_path(&self) -> &'static str {
        "/user"
    }

    /// The authenticated user's repositories, page `page` (30/page).
    ///
    /// GitLab has no `/user/repos`: projects are listed from `/projects` with
    /// `membership=true`, which is the closest analogue to "repos I can act
    /// on".
    pub fn user_repos_path(&self, page: u32) -> String {
        match self.kind {
            GitHostKind::GitHub => {
                format!("/user/repos?sort=updated&{}", self.page_params(30, page))
            }
            GitHostKind::Gitea => format!("/user/repos?{}", self.page_params(30, page)),
            GitHostKind::GitLab => format!(
                "/projects?membership=true&order_by=last_activity_at&{}",
                self.page_params(30, page)
            ),
        }
    }

    pub fn issues_path(&self, r: &RepoRef, state: ListState, per_page: u32, page: u32) -> String {
        format!(
            "{}/issues?{}{}",
            self.repo_base(r),
            self.state_query(state),
            self.page_params(per_page, page)
        )
    }

    /// A single issue. `number` is GitHub's repo-scoped issue number and
    /// GitLab's project-scoped `iid` — **never** GitLab's global `id`, which
    /// is a different integer that silently addresses another project's issue.
    pub fn issue_path(&self, r: &RepoRef, number: u32) -> String {
        format!("{}/issues/{}", self.repo_base(r), number)
    }

    /// Comments on an issue. GitLab calls them "notes".
    pub fn issue_comments_path(&self, r: &RepoRef, number: u32, per_page: u32) -> String {
        let seg = match self.kind {
            GitHostKind::GitLab => "notes",
            _ => "comments",
        };
        format!(
            "{}/issues/{}/{}?{}",
            self.repo_base(r),
            number,
            seg,
            self.page_params(per_page, 1)
        )
    }

    /// Create-comment path (no pagination query).
    pub fn issue_comment_create_path(&self, r: &RepoRef, number: u32) -> String {
        let seg = match self.kind {
            GitHostKind::GitLab => "notes",
            _ => "comments",
        };
        format!("{}/issues/{}/{}", self.repo_base(r), number, seg)
    }

    pub fn issues_create_path(&self, r: &RepoRef) -> String {
        format!("{}/issues", self.repo_base(r))
    }

    pub fn change_requests_path(
        &self,
        r: &RepoRef,
        state: ListState,
        per_page: u32,
        page: u32,
    ) -> String {
        format!(
            "{}/{}?{}{}",
            self.repo_base(r),
            self.cr_segment(),
            self.state_query(state),
            self.page_params(per_page, page)
        )
    }

    pub fn change_requests_create_path(&self, r: &RepoRef) -> String {
        format!("{}/{}", self.repo_base(r), self.cr_segment())
    }

    /// A single change request, by repo-scoped number / project-scoped `iid`.
    pub fn change_request_path(&self, r: &RepoRef, number: u32) -> String {
        format!("{}/{}/{}", self.repo_base(r), self.cr_segment(), number)
    }

    pub fn change_request_merge_path(&self, r: &RepoRef, number: u32) -> String {
        format!(
            "{}/{}/{}/merge",
            self.repo_base(r),
            self.cr_segment(),
            number
        )
    }

    /// Comments on a change request. On GitHub these live on the *issue*
    /// resource (PRs are issues); GitLab keeps notes on the MR itself.
    pub fn change_request_comments_path(&self, r: &RepoRef, number: u32, per_page: u32) -> String {
        match self.kind {
            GitHostKind::GitLab => format!(
                "{}/merge_requests/{}/notes?{}",
                self.repo_base(r),
                number,
                self.page_params(per_page, 1)
            ),
            _ => self.issue_comments_path(r, number, per_page),
        }
    }

    /// Diff endpoint for a change request — all three return a ready-made
    /// unified diff, by three different mechanisms.
    ///
    /// GitHub serves it from the resource itself via a media-type `Accept`
    /// header; Gitea serves it at a `.diff` URL suffix; GitLab has a dedicated
    /// `raw_diffs` sub-resource. (GitLab's `/changes` is *deprecated* since
    /// 15.7 and its replacement `/diffs` returns structured per-file JSON with
    /// no `diff --git` preamble — `raw_diffs` is the one that matches what the
    /// frontend's diff renderer already parses.)
    pub fn change_request_diff_path(&self, r: &RepoRef, number: u32) -> String {
        match self.kind {
            GitHostKind::GitHub => self.change_request_path(r, number),
            GitHostKind::Gitea => format!("{}.diff", self.change_request_path(r, number)),
            GitHostKind::GitLab => {
                format!("{}/raw_diffs", self.change_request_path(r, number))
            }
        }
    }

    /// The `Accept` header to request a diff, or `None` when the endpoint
    /// needs no special media type.
    pub fn change_request_diff_accept(&self) -> Option<&'static str> {
        match self.kind {
            GitHostKind::GitHub => Some("application/vnd.github.diff"),
            _ => None,
        }
    }

    pub fn reviews_path(&self, r: &RepoRef, number: u32, per_page: u32) -> String {
        format!(
            "{}/pulls/{}/reviews?{}",
            self.repo_base(r),
            number,
            self.page_params(per_page, 1)
        )
    }

    pub fn review_comments_path(&self, r: &RepoRef, number: u32, per_page: u32) -> String {
        format!(
            "{}/pulls/{}/comments?{}",
            self.repo_base(r),
            number,
            self.page_params(per_page, 1)
        )
    }

    pub fn branches_path(&self, r: &RepoRef, per_page: u32) -> String {
        match self.kind {
            GitHostKind::GitLab => format!(
                "{}/repository/branches?{}",
                self.repo_base(r),
                self.page_params(per_page, 1)
            ),
            _ => format!(
                "{}/branches?{}",
                self.repo_base(r),
                self.page_params(per_page, 1)
            ),
        }
    }

    pub fn labels_path(&self, r: &RepoRef, per_page: u32) -> String {
        format!(
            "{}/labels?{}",
            self.repo_base(r),
            self.page_params(per_page, 1)
        )
    }

    /// Milestones. GitLab's state filter is `active`, not `open`.
    pub fn milestones_path(&self, r: &RepoRef, per_page: u32) -> String {
        let state = match self.kind {
            GitHostKind::GitLab => "state=active",
            _ => "state=open",
        };
        format!(
            "{}/milestones?{}&{}",
            self.repo_base(r),
            state,
            self.page_params(per_page, 1)
        )
    }

    pub fn milestones_create_path(&self, r: &RepoRef) -> String {
        format!("{}/milestones", self.repo_base(r))
    }

    /// Users who can be assigned. GitHub/Gitea expose `/assignees`; GitLab
    /// exposes project members (including inherited ones).
    pub fn assignable_users_path(&self, r: &RepoRef, per_page: u32) -> String {
        match self.kind {
            GitHostKind::GitLab => format!(
                "{}/members/all?{}",
                self.repo_base(r),
                self.page_params(per_page, 1)
            ),
            _ => format!(
                "{}/assignees?{}",
                self.repo_base(r),
                self.page_params(per_page, 1)
            ),
        }
    }

    pub fn releases_path(&self, r: &RepoRef, per_page: u32) -> String {
        format!(
            "{}/releases?{}",
            self.repo_base(r),
            self.page_params(per_page, 1)
        )
    }

    /// Setting labels on an issue. GitHub/Gitea have a `/labels` sub-resource
    /// replaced with PUT; GitLab sets a comma-joined `labels` field on the
    /// issue itself. `None` means "no sub-resource — update the issue".
    pub fn issue_labels_path(&self, r: &RepoRef, number: u32) -> Option<String> {
        match self.kind {
            GitHostKind::GitLab => None,
            _ => Some(format!("{}/issues/{}/labels", self.repo_base(r), number)),
        }
    }

    /// The notification inbox path. Gated by [`HostCapability::Notifications`]
    /// — GitLab's analogue is Todos, whose shape is different enough that v1
    /// does not pretend.
    pub fn notifications_path(&self, all: bool, per_page: u32) -> String {
        format!(
            "/notifications?all={}&{}",
            all,
            self.page_params(per_page, 1)
        )
    }

    // ---- headers / client -------------------------------------------------

    /// The auth header name+value pair.
    ///
    /// GitHub uses `Authorization: Bearer`; Gitea documents
    /// `Authorization: token`; GitLab uses its own `PRIVATE-TOKEN` header for
    /// personal/project/group access tokens.
    fn auth_header(&self, token: &str) -> (HeaderName, String) {
        match self.kind {
            GitHostKind::GitHub => (AUTHORIZATION, format!("Bearer {}", token)),
            GitHostKind::Gitea => (AUTHORIZATION, format!("token {}", token)),
            GitHostKind::GitLab => (
                HeaderName::from_static(PRIVATE_TOKEN),
                token.trim().to_string(),
            ),
        }
    }

    /// Default `Accept` for JSON responses (per-request overrides — e.g. the
    /// GitHub diff media type — are applied at the call site).
    fn accept_header(&self) -> &'static str {
        match self.kind {
            GitHostKind::GitHub => "application/vnd.github+json",
            _ => "application/json",
        }
    }

    /// Build an authenticated `reqwest::Client` for this host.
    pub fn build_client(&self, token: &str) -> Result<reqwest::Client, String> {
        let mut headers = reqwest::header::HeaderMap::new();
        let (name, value) = self.auth_header(token);
        headers.insert(
            name,
            value
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

/// Append `suffix` to a user-supplied instance origin, idempotently, so callers
/// may paste either the origin or the API root.
fn api_base_with_suffix(instance_url: &str, suffix: &str) -> String {
    let trimmed = instance_url.trim().trim_end_matches('/');
    if trimmed.ends_with(suffix) {
        trimmed.to_string()
    } else {
        format!("{}{}", trimmed, suffix)
    }
}

/// GitLab treats a title beginning with any of `Draft:`, `[Draft]`, `(Draft)`
/// (or the legacy `WIP:`) as a draft MR. Case-insensitive.
fn is_draft_title(title: &str) -> bool {
    let t = title.trim_start().to_ascii_lowercase();
    ["draft:", "[draft]", "(draft)", "wip:"]
        .iter()
        .any(|p| t.starts_with(p))
}

// ============================================================================
// Error labelling
// ============================================================================

/// Human name for whichever host actually answered a request.
///
/// Lives here (rather than in `commands/github.rs`, where it was introduced)
/// so the agent tools in `core/tool_github.rs` can reuse it instead of
/// hardcoding "GitHub API error" — `core` may not depend on `commands`.
pub fn host_label_from_url(url: &reqwest::Url) -> String {
    match url.host_str() {
        Some("api.github.com") => "GitHub".to_string(),
        Some(host) => host.to_string(),
        // Hostless URL (only reachable for non-network schemes) — stay generic
        // rather than blaming a host we cannot name.
        None => "Git host".to_string(),
    }
}

/// Sanitized, host-named message for a failing status. The raw body is never
/// included: it can echo tokens and private repo data.
pub fn sanitize_host_error(host_label: &str, status: reqwest::StatusCode) -> String {
    let reason = match status.as_u16() {
        401 => format!("unauthorized — check your {} token", host_label),
        403 => "forbidden — you may lack permissions or be rate-limited".to_string(),
        404 => "not found — the resource may not exist or may be private".to_string(),
        422 => "validation failed — check your request parameters".to_string(),
        429 => "rate limited — try again later".to_string(),
        _ if status.is_client_error() => "client error".to_string(),
        _ if status.is_server_error() => format!("{} server error — try again later", host_label),
        _ => "unexpected error".to_string(),
    };
    format!("{} API error {}: {}", host_label, status.as_u16(), reason)
}

// ============================================================================
// Inbound normalization — GitLab JSON → the canonical GitHub-shaped wire DTO
// ============================================================================
//
// The frontend (`src/types/github.ts` and every consumer of it) is written
// against GitHub's field names. Rather than teach ~30 React components a third
// vocabulary, GitLab payloads are projected here. These are pure `Value ->
// Value` functions, so they are unit-testable with no live instance.

/// GitLab spells the open state `opened`; `locked` is an open MR with locked
/// discussion. Everything else already matches.
fn normalize_state(state: &str) -> &str {
    match state {
        "opened" | "locked" => "open",
        other => other,
    }
}

fn gl_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

/// GitLab `author`/`user` → GitHub `{login, avatar_url}`.
fn normalize_user(v: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(u) = v else {
        return serde_json::json!({ "login": "" });
    };
    serde_json::json!({
        "login": gl_str(u, "username").unwrap_or_default(),
        "avatar_url": gl_str(u, "avatar_url").unwrap_or_default(),
        "html_url": gl_str(u, "web_url").unwrap_or_default(),
    })
}

/// GitLab labels arrive as bare strings on an issue/MR (or as objects from the
/// project labels endpoint). GitHub's DTO wants `{name, color}`.
fn normalize_labels(v: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return serde_json::json!([]);
    };
    serde_json::Value::Array(
        arr.iter()
            .map(|l| match l {
                serde_json::Value::String(s) => serde_json::json!({ "name": s, "color": "" }),
                other => serde_json::json!({
                    "name": gl_str(other, "name").unwrap_or_default(),
                    // GitLab colors carry a leading '#'; GitHub's do not.
                    "color": gl_str(other, "color").unwrap_or_default().trim_start_matches('#'),
                    "id": other.get("id").cloned().unwrap_or(serde_json::Value::Null),
                }),
            })
            .collect(),
    )
}

/// GitLab milestone → `{number, title}`. GitLab milestones carry both a global
/// `id` and a project-scoped `iid`; the frontend round-trips this value back
/// into `milestone_id`, which GitLab matches on the **global id**.
fn normalize_milestone(v: Option<&serde_json::Value>) -> serde_json::Value {
    match v {
        None | Some(serde_json::Value::Null) => serde_json::Value::Null,
        Some(m) => serde_json::json!({
            "number": m.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
            "title": gl_str(m, "title").unwrap_or_default(),
            "state": normalize_state(gl_str(m, "state").unwrap_or("active")),
        }),
    }
}

/// A milestone from the project milestones *listing* (as opposed to one nested
/// inside an issue). Same projection; separate entry point because the listing
/// is normalized element-wise.
pub fn normalize_milestone_row(v: &serde_json::Value) -> serde_json::Value {
    normalize_milestone(Some(v))
}

/// GitLab issue → GitHub issue shape.
pub fn normalize_issue(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        // `iid` — the project-scoped number the UI shows and the API path takes.
        // Using `id` here would render the wrong number AND build URLs that
        // resolve to a different project's issue.
        "number": v.get("iid").and_then(|x| x.as_u64()).unwrap_or(0),
        "title": gl_str(v, "title").unwrap_or_default(),
        "body": v.get("description").cloned().unwrap_or(serde_json::Value::Null),
        "state": normalize_state(gl_str(v, "state").unwrap_or_default()),
        "labels": normalize_labels(v.get("labels")),
        "user": normalize_user(v.get("author")),
        "html_url": gl_str(v, "web_url").unwrap_or_default(),
        "created_at": gl_str(v, "created_at").unwrap_or_default(),
        "updated_at": gl_str(v, "updated_at").unwrap_or_default(),
        "assignees": v
            .get("assignees")
            .and_then(|x| x.as_array())
            .map(|a| serde_json::Value::Array(a.iter().map(|u| normalize_user(Some(u))).collect()))
            .unwrap_or_else(|| serde_json::json!([])),
        "milestone": normalize_milestone(v.get("milestone")),
    })
}

/// GitLab merge request → GitHub pull request shape.
pub fn normalize_change_request(v: &serde_json::Value) -> serde_json::Value {
    let state = normalize_state(gl_str(v, "state").unwrap_or_default());
    serde_json::json!({
        "number": v.get("iid").and_then(|x| x.as_u64()).unwrap_or(0),
        "title": gl_str(v, "title").unwrap_or_default(),
        "body": v.get("description").cloned().unwrap_or(serde_json::Value::Null),
        "user": normalize_user(v.get("author")),
        "head": { "ref": gl_str(v, "source_branch").unwrap_or_default() },
        "base": { "ref": gl_str(v, "target_branch").unwrap_or_default() },
        "html_url": gl_str(v, "web_url").unwrap_or_default(),
        // GitLab's `merged` is a *state*, not a boolean field; GitHub's DTO
        // wants `state: closed` + `merged: true` for a merged PR.
        "state": if state == "merged" { "closed" } else { state },
        "merged": state == "merged",
        "merged_at": v.get("merged_at").cloned().unwrap_or(serde_json::Value::Null),
        "created_at": gl_str(v, "created_at").unwrap_or_default(),
        "updated_at": gl_str(v, "updated_at").unwrap_or_default(),
        "draft": v
            .get("draft")
            .or_else(|| v.get("work_in_progress"))
            .and_then(|x| x.as_bool())
            .unwrap_or_else(|| is_draft_title(gl_str(v, "title").unwrap_or_default())),
        "labels": normalize_labels(v.get("labels")),
    })
}

/// GitLab project → GitHub repo shape.
pub fn normalize_repo(v: &serde_json::Value) -> serde_json::Value {
    let full = gl_str(v, "path_with_namespace").unwrap_or_default();
    let owner = full.rsplit_once('/').map(|(o, _)| o).unwrap_or("");
    serde_json::json!({
        "id": v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        "full_name": full,
        "name": gl_str(v, "path").unwrap_or_default(),
        "owner": { "login": owner },
        "description": v.get("description").cloned().unwrap_or(serde_json::Value::Null),
        // GitLab: "private" | "internal" | "public". Anything not public is
        // private as far as the badge is concerned.
        "private": gl_str(v, "visibility").unwrap_or("private") != "public",
        "html_url": gl_str(v, "web_url").unwrap_or_default(),
        "updated_at": gl_str(v, "last_activity_at")
            .or_else(|| gl_str(v, "updated_at"))
            .unwrap_or_default(),
    })
}

/// GitLab note → GitHub issue-comment shape.
pub fn normalize_comment(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        "body": gl_str(v, "body").unwrap_or_default(),
        "user": normalize_user(v.get("author")),
        "created_at": gl_str(v, "created_at").unwrap_or_default(),
        "updated_at": gl_str(v, "updated_at").unwrap_or_default(),
        // Notes carry no browser URL of their own; the caller falls back to the
        // parent resource.
        "html_url": "",
    })
}

/// GitLab branch → GitHub branch shape (`commit.id` → `commit.sha`).
pub fn normalize_branch(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "name": gl_str(v, "name").unwrap_or_default(),
        "commit": { "sha": v.get("commit").and_then(|c| gl_str(c, "id")).unwrap_or_default() },
        "protected": v.get("protected").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// GitLab project label → GitHub label shape.
pub fn normalize_label(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        "name": gl_str(v, "name").unwrap_or_default(),
        "color": gl_str(v, "color").unwrap_or_default().trim_start_matches('#'),
        "description": v.get("description").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// GitLab project member → GitHub assignable-user shape.
pub fn normalize_member(v: &serde_json::Value) -> serde_json::Value {
    normalize_user(Some(v))
}

/// GitLab release → GitHub release shape (thin: the UI shows tag + name +
/// date + body).
pub fn normalize_release(v: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": 0,
        "tag_name": gl_str(v, "tag_name").unwrap_or_default(),
        "name": gl_str(v, "name").unwrap_or_default(),
        "body": gl_str(v, "description").unwrap_or_default(),
        "published_at": gl_str(v, "released_at").or_else(|| gl_str(v, "created_at")).unwrap_or_default(),
        "html_url": v.get("_links").and_then(|l| gl_str(l, "self")).unwrap_or_default(),
        "draft": false,
        "prerelease": v.get("upcoming_release").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// GitLab `GET /user` → the `{login, avatar_url}` the badge reads.
pub fn normalize_authenticated_user(v: &serde_json::Value) -> serde_json::Value {
    normalize_user(Some(v))
}

/// Apply `f` to each element of a JSON array, returning a JSON array. Non-array
/// input passes through untouched so a host error body isn't mangled.
pub fn normalize_array(
    body: &serde_json::Value,
    f: fn(&serde_json::Value) -> serde_json::Value,
) -> serde_json::Value {
    match body.as_array() {
        Some(arr) => serde_json::Value::Array(arr.iter().map(f).collect()),
        None => body.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rr(owner: &str, repo: &str) -> RepoRef {
        RepoRef::new(owner, repo).expect("valid repo ref")
    }

    // ---- constructors -----------------------------------------------------

    #[test]
    fn github_host_base_and_url() {
        let h = GitHost::github();
        assert_eq!(h.kind, GitHostKind::GitHub);
        assert_eq!(h.api_base, "https://api.github.com");
        assert_eq!(
            h.url("/repos/o/r/issues"),
            "https://api.github.com/repos/o/r/issues"
        );
        assert_eq!(
            h.auth_header("tok"),
            (AUTHORIZATION, "Bearer tok".to_string())
        );
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
        assert_eq!(
            GitHost::gitea("https://git.example.com/api/v1").api_base,
            "https://git.example.com/api/v1"
        );
        let h = GitHost::gitea("https://git.example.com");
        assert_eq!(
            h.auth_header("tok"),
            (AUTHORIZATION, "token tok".to_string())
        );
        assert_eq!(h.accept_header(), "application/json");
    }

    #[test]
    fn gitlab_host_appends_api_v4_idempotently_for_cloud_and_self_hosted() {
        // gitlab.com and a self-hosted instance take the SAME constructor —
        // GitLab has no separate API hostname.
        assert_eq!(
            GitHost::gitlab("https://gitlab.com").api_base,
            "https://gitlab.com/api/v4"
        );
        assert_eq!(
            GitHost::gitlab("https://gitlab.internal.example.com/").api_base,
            "https://gitlab.internal.example.com/api/v4"
        );
        assert_eq!(
            GitHost::gitlab("https://gitlab.com/api/v4").api_base,
            "https://gitlab.com/api/v4"
        );
        // A path-prefixed self-hosted install (reverse proxy under /gitlab).
        assert_eq!(
            GitHost::gitlab("https://example.com/gitlab").api_base,
            "https://example.com/gitlab/api/v4"
        );
    }

    #[test]
    fn gitlab_uses_the_private_token_header_not_authorization() {
        // Sending `Authorization: Bearer <PAT>` to GitLab is the wrong scheme;
        // more importantly, never reuse GitHub's header shape by accident.
        let h = GitHost::gitlab("https://gitlab.com");
        let (name, value) = h.auth_header("glpat-xxx");
        assert_eq!(name.as_str(), "private-token");
        assert_eq!(value, "glpat-xxx");
        assert_ne!(name, AUTHORIZATION);
    }

    // ---- RepoRef + URL encoding -------------------------------------------

    #[test]
    fn gitlab_encodes_the_project_path_as_one_segment() {
        let h = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            h.repo_base(&rr("acme", "widget")),
            "/projects/acme%2Fwidget"
        );
    }

    #[test]
    fn gitlab_encodes_subgroups() {
        let h = GitHost::gitlab("https://gitlab.com");
        // Every slash must become %2F — a raw slash would address
        // /projects/group/sub/proj, which is a different (nonexistent) route.
        assert_eq!(
            h.repo_base(&rr("group/sub", "proj")),
            "/projects/group%2Fsub%2Fproj"
        );
        assert_eq!(
            h.repo_base(&rr("a/b/c/d", "e")),
            "/projects/a%2Fb%2Fc%2Fd%2Fe"
        );
    }

    #[test]
    fn gitlab_leaves_unreserved_characters_alone() {
        // Dots and dashes are unreserved: encoding them would still resolve but
        // makes URLs unreadable and diverges from GitLab's own docs.
        let h = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            h.repo_base(&rr("my-group", "my.project_v2")),
            "/projects/my-group%2Fmy.project_v2"
        );
    }

    #[test]
    fn github_and_gitea_keep_two_path_segments() {
        assert_eq!(GitHost::github().repo_base(&rr("o", "r")), "/repos/o/r");
        assert_eq!(
            GitHost::gitea("https://g.example.com").repo_base(&rr("o", "r")),
            "/repos/o/r"
        );
    }

    #[test]
    fn repo_ref_rejects_traversal_and_injection() {
        // These are the inputs that would escape the path if interpolated raw.
        assert!(RepoRef::new("..", "r").is_err());
        assert!(RepoRef::new(".", "r").is_err());
        assert!(RepoRef::new("o", "..").is_err());
        assert!(RepoRef::new("o", "r?x=1").is_err());
        assert!(RepoRef::new("o", "r#frag").is_err());
        assert!(RepoRef::new("o", "r%2F..").is_err());
        assert!(RepoRef::new("o/../..", "r").is_err());
        assert!(RepoRef::new("", "r").is_err());
        assert!(RepoRef::new("o", "").is_err());
        assert!(RepoRef::new("o", &"x".repeat(101)).is_err());
        assert!(RepoRef::new("a/b/c/d/e/f/g/h/i", "r").is_err());
    }

    #[test]
    fn repo_ref_accepts_a_nested_namespace() {
        let r = RepoRef::new("group/sub", "proj").expect("subgroups are valid");
        assert_eq!(r.full_path(), "group/sub/proj");
        assert_eq!(r.owner(), "group/sub");
        assert_eq!(r.repo(), "proj");
    }

    #[test]
    fn percent_encode_escapes_everything_reserved() {
        assert_eq!(percent_encode_segment("a/b"), "a%2Fb");
        assert_eq!(percent_encode_segment("a b"), "a%20b");
        assert_eq!(percent_encode_segment("a?b#c"), "a%3Fb%23c");
        assert_eq!(percent_encode_segment("a.b-c_d~e"), "a.b-c_d~e");
    }

    // ---- path grammar -----------------------------------------------------

    #[test]
    fn pagination_and_repos_paths_differ_by_host() {
        let gh = GitHost::github();
        let gt = GitHost::gitea("https://git.example.com");
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(gh.page_params(30, 2), "per_page=30&page=2");
        assert_eq!(gt.page_params(30, 2), "limit=30&page=2");
        assert_eq!(gl.page_params(30, 2), "per_page=30&page=2");
        assert_eq!(
            gh.user_repos_path(2),
            "/user/repos?sort=updated&per_page=30&page=2"
        );
        assert_eq!(gt.user_repos_path(2), "/user/repos?limit=30&page=2");
        // GitLab has no /user/repos at all.
        assert_eq!(
            gl.user_repos_path(2),
            "/projects?membership=true&order_by=last_activity_at&per_page=30&page=2"
        );
    }

    #[test]
    fn change_request_vocabulary_differs() {
        let gh = GitHost::github();
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gh.change_request_path(&rr("o", "r"), 7),
            "/repos/o/r/pulls/7"
        );
        assert_eq!(
            gl.change_request_path(&rr("o", "r"), 7),
            "/projects/o%2Fr/merge_requests/7"
        );
        assert_eq!(gh.kind.change_request_noun(), "pull request");
        assert_eq!(gl.kind.change_request_noun(), "merge request");
    }

    #[test]
    fn open_state_is_spelled_opened_on_gitlab() {
        let gh = GitHost::github();
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gh.issues_path(&rr("o", "r"), ListState::Open, 30, 1),
            "/repos/o/r/issues?state=open&per_page=30&page=1"
        );
        assert_eq!(
            gl.issues_path(&rr("o", "r"), ListState::Open, 30, 1),
            "/projects/o%2Fr/issues?state=opened&per_page=30&page=1"
        );
        assert_eq!(
            gl.issues_path(&rr("o", "r"), ListState::All, 30, 1),
            "/projects/o%2Fr/issues?state=all&per_page=30&page=1"
        );
    }

    #[test]
    fn comments_are_notes_on_gitlab() {
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gl.issue_comment_create_path(&rr("o", "r"), 3),
            "/projects/o%2Fr/issues/3/notes"
        );
        assert_eq!(
            gl.change_request_comments_path(&rr("o", "r"), 3, 100),
            "/projects/o%2Fr/merge_requests/3/notes?per_page=100&page=1"
        );
        assert_eq!(
            GitHost::github().issue_comment_create_path(&rr("o", "r"), 3),
            "/repos/o/r/issues/3/comments"
        );
    }

    #[test]
    fn diff_paths_and_accept_headers_differ() {
        let gh = GitHost::github();
        let gt = GitHost::gitea("https://g.example.com");
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gh.change_request_diff_path(&rr("o", "r"), 5),
            "/repos/o/r/pulls/5"
        );
        assert_eq!(
            gh.change_request_diff_accept(),
            Some("application/vnd.github.diff")
        );
        assert_eq!(
            gt.change_request_diff_path(&rr("o", "r"), 5),
            "/repos/o/r/pulls/5.diff"
        );
        assert_eq!(gt.change_request_diff_accept(), None);
        // NOT `/changes` — deprecated since 15.7 — and NOT `/diffs`, which
        // returns per-file JSON with no `diff --git` preamble.
        assert_eq!(
            gl.change_request_diff_path(&rr("o", "r"), 5),
            "/projects/o%2Fr/merge_requests/5/raw_diffs"
        );
        assert_eq!(gl.change_request_diff_accept(), None);
    }

    #[test]
    fn branches_and_members_take_gitlab_specific_paths() {
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gl.branches_path(&rr("o", "r"), 100),
            "/projects/o%2Fr/repository/branches?per_page=100&page=1"
        );
        assert_eq!(
            gl.assignable_users_path(&rr("o", "r"), 100),
            "/projects/o%2Fr/members/all?per_page=100&page=1"
        );
        assert_eq!(
            gl.milestones_path(&rr("o", "r"), 100),
            "/projects/o%2Fr/milestones?state=active&per_page=100&page=1"
        );
        assert_eq!(
            GitHost::github().milestones_path(&rr("o", "r"), 100),
            "/repos/o/r/milestones?state=open&per_page=100&page=1"
        );
    }

    #[test]
    fn issue_labels_has_no_subresource_on_gitlab() {
        assert_eq!(
            GitHost::gitlab("https://gitlab.com").issue_labels_path(&rr("o", "r"), 1),
            None
        );
        assert_eq!(
            GitHost::github().issue_labels_path(&rr("o", "r"), 1),
            Some("/repos/o/r/issues/1/labels".to_string())
        );
    }

    // ---- vocabulary bodies ------------------------------------------------

    #[test]
    fn state_change_uses_state_event_on_gitlab() {
        let gh = GitHost::github();
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gh.state_change_body(false),
            serde_json::json!({"state":"closed"})
        );
        assert_eq!(
            gh.state_change_body(true),
            serde_json::json!({"state":"open"})
        );
        // GitLab ignores an unknown `state` field and returns 200 unchanged —
        // the silent-no-op this test exists to prevent.
        assert_eq!(
            gl.state_change_body(false),
            serde_json::json!({"state_event":"close"})
        );
        assert_eq!(
            gl.state_change_body(true),
            serde_json::json!({"state_event":"reopen"})
        );
        assert_eq!(gl.update_method(), reqwest::Method::PUT);
        assert_eq!(gh.update_method(), reqwest::Method::PATCH);
    }

    #[test]
    fn create_change_request_body_renames_every_field_on_gitlab() {
        let gl = GitHost::gitlab("https://gitlab.com");
        let v = gl.create_change_request_body("T", "B", "feat", "main", None);
        assert_eq!(v["source_branch"], "feat");
        assert_eq!(v["target_branch"], "main");
        assert_eq!(v["description"], "B");
        assert!(v.get("head").is_none());
        assert!(v.get("body").is_none());
    }

    #[test]
    fn gitlab_draft_is_a_title_prefix_not_a_flag() {
        let gl = GitHost::gitlab("https://gitlab.com");
        let v = gl.create_change_request_body("T", "B", "f", "m", Some(true));
        assert_eq!(v["title"], "Draft: T");
        assert!(v.get("draft").is_none());
        // Already-prefixed titles are not double-prefixed.
        let v2 = gl.create_change_request_body("Draft: T", "B", "f", "m", Some(true));
        assert_eq!(v2["title"], "Draft: T");
        // draft=false leaves the title alone.
        let v3 = gl.create_change_request_body("T", "B", "f", "m", Some(false));
        assert_eq!(v3["title"], "T");
    }

    #[test]
    fn github_keeps_its_draft_flag() {
        let v = GitHost::github().create_change_request_body("T", "B", "f", "m", Some(true));
        assert_eq!(v["draft"], serde_json::Value::Bool(true));
        assert_eq!(v["head"], "f");
        assert_eq!(v["base"], "m");
        // Gitea gets neither.
        let g = GitHost::gitea("https://g.example.com").create_change_request_body(
            "T",
            "B",
            "f",
            "m",
            Some(true),
        );
        assert!(g.get("draft").is_none());
    }

    #[test]
    fn merge_shape_differs_by_host() {
        assert_eq!(
            GitHost::github().merge_request_shape("squash").unwrap(),
            (
                reqwest::Method::PUT,
                serde_json::json!({"merge_method":"squash"})
            )
        );
        assert_eq!(
            GitHost::gitea("https://g.example.com")
                .merge_request_shape("squash")
                .unwrap(),
            (reqwest::Method::POST, serde_json::json!({"Do":"squash"}))
        );
        assert_eq!(
            GitHost::gitlab("https://gitlab.com")
                .merge_request_shape("squash")
                .unwrap(),
            (reqwest::Method::PUT, serde_json::json!({"squash":true}))
        );
        assert_eq!(
            GitHost::gitlab("https://gitlab.com")
                .merge_request_shape("merge")
                .unwrap(),
            (reqwest::Method::PUT, serde_json::json!({"squash":false}))
        );
    }

    #[test]
    fn gitlab_refuses_rebase_on_merge_rather_than_silently_merging() {
        // GitLab's /merge has no rebase option. Mapping it onto `squash:false`
        // would quietly produce a merge commit the user did not ask for.
        let err = GitHost::gitlab("https://gitlab.com")
            .merge_request_shape("rebase")
            .expect_err("rebase must be refused on GitLab");
        assert!(err.contains("rebase"), "{err}");
        assert!(GitHost::github().merge_request_shape("rebase").is_ok());
        assert!(GitHost::gitea("https://g.example.com")
            .merge_request_shape("rebase")
            .is_ok());
    }

    #[test]
    fn labels_body_is_a_comma_joined_string_on_gitlab() {
        let names = vec!["bug".to_string(), "p1".to_string()];
        assert_eq!(
            GitHost::gitlab("https://gitlab.com").labels_body_from_names(&names),
            serde_json::json!({ "labels": "bug,p1" })
        );
        assert_eq!(
            GitHost::github().labels_body_from_names(&names),
            serde_json::json!({ "labels": ["bug", "p1"] })
        );
        assert_eq!(
            GitHost::gitlab("https://gitlab.com").labels_body_from_names(&[]),
            serde_json::json!({ "labels": "" })
        );
    }

    #[test]
    fn milestone_body_renames_the_field_and_clears_differently() {
        let gh = GitHost::github();
        let gl = GitHost::gitlab("https://gitlab.com");
        assert_eq!(
            gh.milestone_body(Some(3)),
            serde_json::json!({"milestone": 3})
        );
        assert_eq!(
            gh.milestone_body(None),
            serde_json::json!({"milestone": null})
        );
        assert_eq!(
            gl.milestone_body(Some(3)),
            serde_json::json!({"milestone_id": 3})
        );
        // GitLab rejects null for an integer field; 0 is the documented clear.
        assert_eq!(
            gl.milestone_body(None),
            serde_json::json!({"milestone_id": 0})
        );
    }

    #[test]
    fn draft_title_detection_covers_every_gitlab_prefix() {
        assert!(is_draft_title("Draft: x"));
        assert!(is_draft_title("draft: x"));
        assert!(is_draft_title("[Draft] x"));
        assert!(is_draft_title("(Draft) x"));
        assert!(is_draft_title("WIP: x"));
        assert!(!is_draft_title("Drafting a plan"));
        assert!(!is_draft_title("x"));
        assert!(!is_draft_title(""));
    }

    // ---- capabilities: the denial paths -----------------------------------

    #[test]
    fn capabilities_are_an_allow_list_github_gets_everything() {
        let gh = GitHost::github();
        for cap in [
            HostCapability::InlineReviewComments,
            HostCapability::PrReviews,
            HostCapability::DraftToggle,
            HostCapability::CheckRuns,
            HostCapability::ActivityFeed,
            HostCapability::Notifications,
            HostCapability::RequestReviewers,
            HostCapability::AssigneesByLogin,
            HostCapability::Milestones,
            HostCapability::AiAssist,
        ] {
            assert!(gh.supports(cap), "GitHub must support {:?}", cap);
        }
    }

    #[test]
    fn gitlab_is_denied_every_github_only_capability() {
        // The regression this guards: the old guards were `if kind == Gitea`,
        // so a GitLab workspace sailed through and the command then fired the
        // GitHub token at api.github.com with GitLab ids.
        let gl = GitHost::gitlab("https://gitlab.com");
        for cap in [
            HostCapability::AiAssist,
            HostCapability::CheckRuns,
            HostCapability::DraftToggle,
            HostCapability::ActivityFeed,
            HostCapability::InlineReviewComments,
            HostCapability::RequestReviewers,
            HostCapability::Notifications,
            HostCapability::PrReviews,
            HostCapability::AssigneesByLogin,
        ] {
            assert!(!gl.supports(cap), "GitLab must NOT support {:?}", cap);
        }
        // ...but milestones do work there.
        assert!(gl.supports(HostCapability::Milestones));
    }

    #[test]
    fn web_base_is_the_browser_origin_not_the_api_base() {
        // github.com is the only host where the two differ.
        assert_eq!(GitHost::github().web_base(), "https://github.com");
        assert_eq!(
            GitHost::gitea("https://git.example.com").web_base(),
            "https://git.example.com"
        );
        assert_eq!(
            GitHost::gitlab("https://gitlab.com").web_base(),
            "https://gitlab.com"
        );
        assert_eq!(
            GitHost::gitlab("https://example.com/gitlab").web_base(),
            "https://example.com/gitlab"
        );
    }

    #[test]
    fn gitea_keeps_the_capabilities_it_already_had() {
        // Guard against the GitLab work quietly narrowing Gitea: it does serve
        // /pulls/{n}/reviews and /pulls/{n}/requested_reviewers.
        let gt = GitHost::gitea("https://g.example.com");
        assert!(gt.supports(HostCapability::PrReviews));
        assert!(gt.supports(HostCapability::RequestReviewers));
        assert!(gt.supports(HostCapability::Notifications));
        assert!(gt.supports(HostCapability::AssigneesByLogin));
        assert!(gt.supports(HostCapability::Milestones));
    }

    #[test]
    fn gitea_denials_are_unchanged_from_before_gitlab() {
        let gt = GitHost::gitea("https://g.example.com");
        assert!(!gt.supports(HostCapability::AiAssist));
        assert!(!gt.supports(HostCapability::CheckRuns));
        assert!(!gt.supports(HostCapability::DraftToggle));
        assert!(!gt.supports(HostCapability::ActivityFeed));
        assert!(!gt.supports(HostCapability::InlineReviewComments));
        // ...but Gitea keeps reviews and notifications, as before.
        assert!(gt.supports(HostCapability::PrReviews));
        assert!(gt.supports(HostCapability::Notifications));
    }

    #[test]
    fn unsupported_message_names_the_active_host() {
        let gl = GitHost::gitlab("https://gitlab.com");
        let msg = gl.unsupported(HostCapability::AiAssist);
        assert_eq!(msg, "This AI feature isn't supported on GitLab.");
        assert!(!msg.contains("Gitea"), "{msg}");
        // Each host is pointed at its own draft convention, not the other's.
        assert_eq!(
            GitHost::gitea("https://g.example.com").unsupported(HostCapability::DraftToggle),
            "The draft toggle isn't supported on Gitea — prefix the title with \"WIP:\" instead."
        );
        assert_eq!(
            gl.unsupported(HostCapability::DraftToggle),
            "The draft toggle isn't supported on GitLab — prefix the title with \"Draft:\" instead."
        );
        assert_eq!(
            gl.unsupported(HostCapability::RequestReviewers),
            "Requesting reviewers isn't supported on GitLab."
        );
        assert_eq!(
            gl.unsupported(HostCapability::Notifications),
            "Notifications aren't supported on GitLab."
        );
    }

    // ---- error labelling --------------------------------------------------

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).expect("test url")
    }

    #[test]
    fn host_label_names_github_cloud() {
        assert_eq!(
            host_label_from_url(&url("https://api.github.com/repos/o/r/pulls/1")),
            "GitHub"
        );
    }

    #[test]
    fn host_label_names_the_instance_that_answered() {
        assert_eq!(
            host_label_from_url(&url("https://git.example.com/api/v1/repos/o/r/issues")),
            "git.example.com"
        );
        assert_eq!(
            host_label_from_url(&url("https://gitlab.com/api/v4/projects/o%2Fr/issues")),
            "gitlab.com"
        );
    }

    #[test]
    fn sanitized_error_does_not_blame_github_for_another_host() {
        let msg = sanitize_host_error(
            &host_label_from_url(&url("https://gitlab.com/api/v4/user")),
            reqwest::StatusCode::UNAUTHORIZED,
        );
        assert_eq!(
            msg,
            "gitlab.com API error 401: unauthorized — check your gitlab.com token"
        );
        assert!(!msg.contains("GitHub"));
    }

    // ---- normalization ----------------------------------------------------

    #[test]
    fn normalize_issue_maps_iid_not_id() {
        // The classic GitLab bug: `id` is global, `iid` is project-scoped. The
        // UI shows and re-sends this number, so picking `id` would render the
        // wrong issue number AND address a different project's issue.
        let raw = serde_json::json!({
            "id": 987654, "iid": 12,
            "title": "T", "description": "D", "state": "opened",
            "web_url": "https://gitlab.com/g/p/-/issues/12",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
            "author": { "username": "alice", "avatar_url": "a.png" },
            "labels": ["bug", "p1"],
            "assignees": [{ "username": "bob" }],
            "milestone": { "id": 55, "iid": 2, "title": "v1", "state": "active" }
        });
        let n = normalize_issue(&raw);
        assert_eq!(n["number"], 12);
        assert_ne!(n["number"], 987654);
        assert_eq!(n["body"], "D");
        assert_eq!(n["state"], "open");
        assert_eq!(n["html_url"], "https://gitlab.com/g/p/-/issues/12");
        assert_eq!(n["user"]["login"], "alice");
        assert_eq!(n["labels"][0]["name"], "bug");
        assert_eq!(n["assignees"][0]["login"], "bob");
        // Milestone round-trips on the GLOBAL id, which is what `milestone_id`
        // matches on when written back.
        assert_eq!(n["milestone"]["number"], 55);
    }

    #[test]
    fn normalize_change_request_maps_state_and_branches() {
        let raw = serde_json::json!({
            "id": 111, "iid": 4, "title": "Draft: wip", "description": "D",
            "state": "opened", "source_branch": "feat", "target_branch": "main",
            "web_url": "https://gitlab.com/g/p/-/merge_requests/4",
            "author": { "username": "carol" }, "draft": true,
            "created_at": "c", "updated_at": "u", "merged_at": null
        });
        let n = normalize_change_request(&raw);
        assert_eq!(n["number"], 4);
        assert_eq!(n["head"]["ref"], "feat");
        assert_eq!(n["base"]["ref"], "main");
        assert_eq!(n["state"], "open");
        assert_eq!(n["merged"], false);
        assert_eq!(n["draft"], true);
    }

    #[test]
    fn normalize_change_request_flattens_merged_into_state_plus_flag() {
        let raw = serde_json::json!({
            "iid": 9, "state": "merged", "title": "t",
            "source_branch": "f", "target_branch": "m",
            "merged_at": "2026-01-01T00:00:00Z"
        });
        let n = normalize_change_request(&raw);
        // GitHub has no `merged` state — it is closed + merged:true.
        assert_eq!(n["state"], "closed");
        assert_eq!(n["merged"], true);
        assert_eq!(n["merged_at"], "2026-01-01T00:00:00Z");
    }

    #[test]
    fn normalize_change_request_infers_draft_from_title_when_flag_absent() {
        let raw = serde_json::json!({
            "iid": 1, "state": "opened", "title": "Draft: thing",
            "source_branch": "f", "target_branch": "m"
        });
        assert_eq!(normalize_change_request(&raw)["draft"], true);
        let raw2 = serde_json::json!({
            "iid": 1, "state": "opened", "title": "thing",
            "source_branch": "f", "target_branch": "m"
        });
        assert_eq!(normalize_change_request(&raw2)["draft"], false);
    }

    #[test]
    fn normalize_repo_splits_the_namespace() {
        let raw = serde_json::json!({
            "id": 3, "path": "proj", "path_with_namespace": "group/sub/proj",
            "description": "d", "visibility": "private",
            "web_url": "https://gitlab.com/group/sub/proj",
            "last_activity_at": "2026-01-01T00:00:00Z"
        });
        let n = normalize_repo(&raw);
        assert_eq!(n["full_name"], "group/sub/proj");
        assert_eq!(n["owner"]["login"], "group/sub");
        assert_eq!(n["name"], "proj");
        assert_eq!(n["private"], true);
        assert_eq!(n["updated_at"], "2026-01-01T00:00:00Z");
        // A public project is not private.
        let pub_raw = serde_json::json!({ "path_with_namespace": "g/p", "visibility": "public" });
        assert_eq!(normalize_repo(&pub_raw)["private"], false);
        // An *internal* project is private as far as the badge goes.
        let int_raw = serde_json::json!({ "path_with_namespace": "g/p", "visibility": "internal" });
        assert_eq!(normalize_repo(&int_raw)["private"], true);
    }

    #[test]
    fn normalize_label_strips_the_leading_hash_from_colors() {
        let n = normalize_label(&serde_json::json!({"id": 2, "name": "bug", "color": "#d9534f"}));
        assert_eq!(n["color"], "d9534f");
        assert_eq!(n["name"], "bug");
    }

    #[test]
    fn normalize_branch_maps_commit_id_to_sha() {
        let n = normalize_branch(&serde_json::json!({
            "name": "main", "protected": true, "commit": { "id": "deadbeef" }
        }));
        assert_eq!(n["commit"]["sha"], "deadbeef");
        assert_eq!(n["protected"], true);
    }

    #[test]
    fn normalize_comment_maps_author_to_user() {
        let n = normalize_comment(&serde_json::json!({
            "id": 5, "body": "hi", "created_at": "c",
            "author": { "username": "dan", "avatar_url": "d.png" }
        }));
        assert_eq!(n["user"]["login"], "dan");
        assert_eq!(n["body"], "hi");
    }

    #[test]
    fn normalize_array_passes_non_arrays_through() {
        let obj = serde_json::json!({ "message": "401 Unauthorized" });
        assert_eq!(normalize_array(&obj, normalize_issue), obj);
    }
}
