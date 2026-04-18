//! GitHub tools for API-based agents.
//!
//! Exposes a focused subset of GitHub REST API operations (list issues,
//! get issue, list PRs) so agents can browse repos without shelling to `gh`.
//!
//! Token loading mirrors `commands/github.rs` — keyring first, then a legacy
//! file fallback at `~/.packetcode/github-token`. We intentionally inline the
//! lookup here (rather than re-using the Tauri `GitHubAuthState`) so tools
//! stay independent of the AppHandle.

use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use tracing::warn;

use crate::core::llm_types::ToolDefinition;

const MAX_OUTPUT_CHARS: usize = 8000;

/// Mirror of `commands/github.rs::load_persisted_token`, minus the migration
/// path (read-only here — agent tools don't write the token back).
fn load_github_token() -> Option<String> {
    // Keyring first.
    match keyring::Entry::new("packetcode", "github-token") {
        Ok(entry) => match entry.get_password() {
            Ok(token) => return Some(token),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!("Failed to read GitHub token from keyring: {}", e),
        },
        Err(e) => warn!("Failed to create keyring entry: {}", e),
    }

    // Legacy file fallback.
    let home = crate::core::shared::home_dir()?;
    let path = std::path::PathBuf::from(home)
        .join(".packetcode")
        .join("github-token");
    let raw = std::fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
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
        "PacketCode/1.0"
            .parse()
            .map_err(|e| format!("Invalid header: {}", e))?,
    );

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn client_or_err() -> Result<reqwest::Client, String> {
    let token = load_github_token().ok_or_else(|| {
        "GitHub token not configured. Run `github_set_token` first.".to_string()
    })?;
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

async fn handle_status(resp: reqwest::Response) -> Result<String, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        warn!("GitHub API error {}: {}", status, body);
        return Err(format!(
            "GitHub API error {}: {}",
            status.as_u16(),
            match status.as_u16() {
                401 => "unauthorized — check your GitHub token",
                403 => "forbidden — missing permissions or rate-limited",
                404 => "not found",
                429 => "rate limited",
                _ => "request failed",
            }
        ));
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

pub async fn execute_github_tool(
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
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
    let issue: serde_json::Value = serde_json::from_str(&issue_body)
        .map_err(|e| format!("Failed to parse issue: {}", e))?;

    let title = issue.get("title").and_then(|v| v.as_str()).unwrap_or("(no title)");
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
            let created = c
                .get("created_at")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cbody = c.get("body").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!("### @{} — {}\n\n{}\n\n---\n\n", author, created, cbody));
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

    let items: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse PRs response: {}", e))?;

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
