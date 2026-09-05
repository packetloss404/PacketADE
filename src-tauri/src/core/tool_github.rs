//! GitHub tools for API-based agents.
//!
//! Exposes a focused subset of GitHub REST API operations (list issues,
//! get issue, list PRs) so agents can browse repos without shelling to `gh`.
//!
//! Token loading mirrors `commands/github.rs` — new keyring service first, then
//! legacy keyring service. Read-only here — migration happens in
//! `commands/github.rs` on app startup. The old plaintext
//! `~/.packetbench/github-token` fallback was removed: startup migration
//! deletes that file once the keyring copy exists, so the only thing the
//! fallback could ever read is a file someone (or something) re-created — a
//! path that turned a stray plaintext file back into a live credential.
//!
//! G14 scope: these `gh_*` agent read-tools are **GitHub-scoped** by design —
//! they load the GitHub connection's token directly and have no per-workspace
//! host context. Gitea/Forgejo and GitLab agent-tool parity is a deferred
//! follow-up (see `dev/gitea-support-loop.md` → Deferred). The interactive
//! Git Hosts pane is the host-aware surface.
//!
//! Because the token here is read straight from the `github-token` keyring
//! account and every URL is a literal `https://api.github.com/...`, the
//! credential and the destination cannot diverge — the tools have no notion of
//! an "active connection" to get wrong. That is why they are safe as-is; it is
//! also why they must NOT be given one without also routing them through
//! `GitHost`.

use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use tracing::warn;

use crate::core::brand::{KEYRING_SERVICE, LEGACY_KEYRING_SERVICE, USER_AGENT as BRAND_USER_AGENT};
use crate::core::llm_types::ToolDefinition;

const MAX_OUTPUT_CHARS: usize = 8000;

/// Mirror of `commands/github.rs::load_persisted_token`, minus the migration
/// path (read-only here — agent tools don't write the token back).
fn load_github_token() -> Option<String> {
    // New keyring service.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, "github-token") {
        match entry.get_password() {
            Ok(token) => return Some(token),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!("Failed to read GitHub token from keyring: {}", e),
        }
    }

    // Legacy keyring service.
    if let Ok(entry) = keyring::Entry::new(LEGACY_KEYRING_SERVICE, "github-token") {
        if let Ok(token) = entry.get_password() {
            return Some(token);
        }
    }

    // No plaintext-file fallback: see the module doc.
    None
}

fn github_client(token: &str) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        format!("Bearer {}", token)
            .parse()
            .map_err(|e| format!("Invalid header: {}", e))?,
    );
    headers.insert(
        ACCEPT,
        "application/vnd.github+json"
            .parse()
            .map_err(|e| format!("Invalid header: {}", e))?,
    );
    headers.insert(
        USER_AGENT,
        BRAND_USER_AGENT
            .parse()
            .map_err(|e| format!("Invalid header: {}", e))?,
    );

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn client_or_err() -> Result<reqwest::Client, String> {
    let token = load_github_token()
        .ok_or_else(|| "GitHub token not configured. Run `github_set_token` first.".to_string())?;
    github_client(&token)
}

/// Validate `owner/name` and split into parts.
fn parse_repo(repo: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 {
        return Err(format!(
            "Invalid repo '{}'. Expected 'owner/name' format.",
            repo
        ));
    }
    let (owner, name) = (parts[0].trim(), parts[1].trim());
    validate_name(owner, "owner")?;
    validate_name(name, "name")?;
    Ok((owner.to_string(), name.to_string()))
}

fn validate_name(name: &str, field: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{} cannot be empty", field));
    }
    if name.len() > 100 {
        return Err(format!("{} is too long", field));
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

fn parse_state(args: &serde_json::Value) -> Result<&'static str, String> {
    match args.get("state").and_then(|v| v.as_str()) {
        None => Ok("open"),
        Some("open") => Ok("open"),
        Some("closed") => Ok("closed"),
        Some("all") => Ok("all"),
        Some(other) => Err(format!(
            "Invalid state '{}'. Allowed: open, closed, all.",
            other
        )),
    }
}

fn truncate(mut s: String) -> String {
    if s.chars().count() > MAX_OUTPUT_CHARS {
        let cut = s
            .char_indices()
            .nth(MAX_OUTPUT_CHARS)
            .map(|(i, _)| i)
            .unwrap_or(s.len());
        s.truncate(cut);
        s.push_str("\n... [truncated]");
    }
    s
}

/// Log the raw failure body (never surfaced — it can echo tokens and private
/// repo data) and return a sanitized message that names whichever host actually
/// answered.
///
/// This used to hardcode "GitHub API error" and its own copy of the
/// status→reason table. `b3de2bdf` fixed the same defect in
/// `commands/github.rs` by deriving the label from the response URL; the two
/// helpers now share one implementation in `core::git_host` rather than
/// drifting apart the way the two review-comment guards did. These tools are
/// still GitHub-scoped (see the module doc), so today the label always resolves
/// to "GitHub" — but it is derived, not asserted, so a self-hosted GitHub
/// Enterprise base or a future host-aware variant cannot silently mislabel.
async fn handle_status(resp: reqwest::Response) -> Result<String, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let label = crate::core::git_host::host_label_from_url(resp.url());
        let body = resp.text().await.unwrap_or_default();
        warn!("{} API error {}: {}", label, status, body);
        return Err(crate::core::git_host::sanitize_host_error(&label, status));
    }
    resp.text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))
}

// -------------------- tool definitions --------------------

pub fn github_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "gh_list_issues".to_string(),
            description:
                "List issues in a GitHub repository. Returns a markdown bullet list of '#N <title> (<state>) — <url>'."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "Repository in 'owner/name' format (e.g. 'rust-lang/rust')."
                    },
                    "state": {
                        "type": "string",
                        "enum": ["open", "closed", "all"],
                        "description": "Filter by issue state. Default: 'open'."
                    }
                },
                "required": ["repo"]
            }),
        },
        ToolDefinition {
            name: "gh_get_issue".to_string(),
            description:
                "Fetch a single GitHub issue with title, body, and comments rendered as markdown."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "Repository in 'owner/name' format."
                    },
                    "number": {
                        "type": "integer",
                        "description": "Issue number."
                    }
                },
                "required": ["repo", "number"]
            }),
        },
        ToolDefinition {
            name: "gh_list_prs".to_string(),
            description:
                "List pull requests in a GitHub repository. Returns a markdown bullet list of '#N <title> (<state>) — <url>'."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "Repository in 'owner/name' format."
                    },
                    "state": {
                        "type": "string",
                        "enum": ["open", "closed", "all"],
                        "description": "Filter by PR state. Default: 'open'."
                    }
                },
                "required": ["repo"]
            }),
        },
    ]
}

// -------------------- dispatcher --------------------

pub async fn execute_github_tool(name: &str, args: &serde_json::Value) -> Result<String, String> {
    match name {
        "gh_list_issues" => execute_list_issues(args).await,
        "gh_get_issue" => execute_get_issue(args).await,
        "gh_list_prs" => execute_list_prs(args).await,
        _ => Err(format!("Unknown GitHub tool: {}", name)),
    }
}

// -------------------- handlers --------------------

async fn execute_list_issues(args: &serde_json::Value) -> Result<String, String> {
    let repo = args
        .get("repo")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'repo' parameter")?;
    let (owner, name) = parse_repo(repo)?;
    let state = parse_state(args)?;
    let client = client_or_err()?;

    let url = format!(
        "https://api.github.com/repos/{}/{}/issues?state={}&per_page=50",
        owner, name, state
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = handle_status(resp).await?;

    let items: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse issues response: {}", e))?;

    if items.is_empty() {
        return Ok(format!("No {} issues found in {}.", state, repo));
    }

    let mut out = format!("# {} issues in {}\n\n", state, repo);
    for item in items {
        // GitHub returns PRs from this endpoint too — skip them.
        if item.get("pull_request").is_some() {
            continue;
        }
        let n = item.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let st = item.get("state").and_then(|v| v.as_str()).unwrap_or("");
        let url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
        out.push_str(&format!("- #{} {} ({}) — {}\n", n, title, st, url));
    }

    Ok(truncate(out))
}

async fn execute_get_issue(args: &serde_json::Value) -> Result<String, String> {
    let repo = args
        .get("repo")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'repo' parameter")?;
    let number = args
        .get("number")
        .and_then(|v| v.as_u64())
        .ok_or("Missing or invalid 'number' parameter")?;
    let (owner, name) = parse_repo(repo)?;
    let client = client_or_err()?;

    let issue_url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}",
        owner, name, number
    );
    let issue_resp = client
        .get(&issue_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let issue_body = handle_status(issue_resp).await?;
    let issue: serde_json::Value =
        serde_json::from_str(&issue_body).map_err(|e| format!("Failed to parse issue: {}", e))?;

    let title = issue
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("(no title)");
    let state = issue.get("state").and_then(|v| v.as_str()).unwrap_or("");
    let user = issue
        .get("user")
        .and_then(|u| u.get("login"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let html_url = issue.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
    let body = issue
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("(no description)");

    let mut out = format!(
        "# #{} {}\n\n**State:** {}  \n**Author:** @{}  \n**URL:** {}\n\n## Description\n\n{}\n",
        number, title, state, user, html_url, body
    );

    // Fetch comments.
    let comments_url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}/comments?per_page=50",
        owner, name, number
    );
    let comments_resp = client
        .get(&comments_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let comments_body = handle_status(comments_resp).await?;
    let comments: Vec<serde_json::Value> = serde_json::from_str(&comments_body)
        .map_err(|e| format!("Failed to parse comments: {}", e))?;

    if comments.is_empty() {
        out.push_str("\n## Comments\n\n_(none)_\n");
    } else {
        out.push_str(&format!("\n## Comments ({})\n\n", comments.len()));
        for c in comments {
            let author = c
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let created = c.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            let cbody = c.get("body").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "### @{} — {}\n\n{}\n\n---\n\n",
                author, created, cbody
            ));
        }
    }

    Ok(truncate(out))
}

async fn execute_list_prs(args: &serde_json::Value) -> Result<String, String> {
    let repo = args
        .get("repo")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'repo' parameter")?;
    let (owner, name) = parse_repo(repo)?;
    let state = parse_state(args)?;
    let client = client_or_err()?;

    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls?state={}&per_page=50",
        owner, name, state
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = handle_status(resp).await?;

    let items: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse PRs response: {}", e))?;

    if items.is_empty() {
        return Ok(format!("No {} pull requests found in {}.", state, repo));
    }

    let mut out = format!("# {} pull requests in {}\n\n", state, repo);
    for item in items {
        let n = item.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let st = item.get("state").and_then(|v| v.as_str()).unwrap_or("");
        let url = item.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
        out.push_str(&format!("- #{} {} ({}) — {}\n", n, title, st, url));
    }

    Ok(truncate(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_repo_accepts_owner_name() {
        let (o, n) = parse_repo("rust-lang/rust").unwrap();
        assert_eq!(o, "rust-lang");
        assert_eq!(n, "rust");
    }

    #[test]
    fn parse_repo_rejects_missing_slash() {
        assert!(parse_repo("rust-lang").is_err());
    }

    #[test]
    fn parse_repo_rejects_too_many_parts() {
        assert!(parse_repo("a/b/c").is_err());
    }

    #[test]
    fn parse_state_defaults_to_open() {
        assert_eq!(parse_state(&serde_json::json!({})).unwrap(), "open");
    }

    #[test]
    fn parse_state_rejects_garbage() {
        assert!(parse_state(&serde_json::json!({"state": "weird"})).is_err());
    }

    #[test]
    fn truncate_passes_through_short_strings() {
        assert_eq!(truncate("hello".to_string()), "hello");
    }

    #[test]
    fn truncate_marks_long_strings() {
        let big = "a".repeat(MAX_OUTPUT_CHARS + 100);
        let out = truncate(big);
        assert!(out.ends_with("[truncated]"));
    }

    // Regression: `handle_status` used to hardcode "GitHub API error" and its
    // own status→reason table, duplicating the one `b3de2bdf` centralized.
    #[test]
    fn errors_are_named_from_the_response_url_not_hardcoded() {
        let url = reqwest::Url::parse("https://api.github.com/repos/o/r/issues").unwrap();
        let label = crate::core::git_host::host_label_from_url(&url);
        assert_eq!(label, "GitHub");
        assert_eq!(
            crate::core::git_host::sanitize_host_error(&label, reqwest::StatusCode::UNAUTHORIZED),
            "GitHub API error 401: unauthorized — check your GitHub token"
        );
        // The shared helper is not GitHub-specific, so a non-GitHub responder
        // is named correctly rather than blamed on GitHub.
        let other = reqwest::Url::parse("https://gitlab.com/api/v4/projects/o%2Fr").unwrap();
        let msg = crate::core::git_host::sanitize_host_error(
            &crate::core::git_host::host_label_from_url(&other),
            reqwest::StatusCode::UNAUTHORIZED,
        );
        assert!(!msg.contains("GitHub"), "{msg}");
    }

    #[test]
    fn definitions_have_three_tools() {
        let defs = github_tool_definitions();
        assert_eq!(defs.len(), 3);
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"gh_list_issues"));
        assert!(names.contains(&"gh_get_issue"));
        assert!(names.contains(&"gh_list_prs"));
    }
}
