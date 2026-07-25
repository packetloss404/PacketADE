use crate::core::brand::{
    DATA_DIR_NAME, KEYRING_SERVICE, LEGACY_DATA_DIR_NAME, LEGACY_KEYRING_SERVICE,
    USER_AGENT as BRAND_USER_AGENT,
};
use crate::core::git_host::{GitHost, GitHostKind};
use std::collections::HashMap;
use reqwest::header::{ACCEPT, AUTHORIZATION, LINK, USER_AGENT};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tracing::{info, warn};
use zeroize::Zeroizing;

/// Validate that a GitHub owner or repo name contains only allowed characters.
fn validate_github_name(name: &str, field: &str) -> Result<(), String> {
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

fn token_file_path() -> Option<std::path::PathBuf> {
    super::shared::home_dir().map(|h| {
        std::path::PathBuf::from(h)
            .join(DATA_DIR_NAME)
            .join("github-token")
    })
}

/// Also check the old data dir for pre-rename installs.
fn legacy_token_file_path() -> Option<std::path::PathBuf> {
    super::shared::home_dir().map(|h| {
        std::path::PathBuf::from(h)
            .join(LEGACY_DATA_DIR_NAME)
            .join("github-token")
    })
}

fn keyring_entry() -> Option<keyring::Entry> {
    match keyring::Entry::new(KEYRING_SERVICE, "github-token") {
        Ok(entry) => Some(entry),
        Err(e) => {
            warn!("Failed to create keyring entry: {}", e);
            None
        }
    }
}

fn legacy_keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(LEGACY_KEYRING_SERVICE, "github-token").ok()
}

fn delete_keyring_credential(entry: Option<keyring::Entry>, label: &str) {
    if let Some(entry) = entry {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!(
                "Failed to delete {} GitHub token from keyring: {}",
                label, e
            ),
        }
    }
}

fn clear_persisted_token() {
    delete_keyring_credential(keyring_entry(), "current");
    delete_keyring_credential(legacy_keyring_entry(), "legacy");

    for path in [token_file_path(), legacy_token_file_path()]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_file(path);
    }
}

// ============================================================================
// G2 — multi-connection git-host config (GitHub + Gitea/Forgejo)
//
// Connection *metadata* for Gitea hosts persists to `git-hosts.json` (not a
// secret; the base URL is required to build any request). Every connection's
// *token* persists in the OS keyring keyed by connection id — so no re-prompt
// after restart, for GitHub and Gitea alike. The GitHub connection is always
// present implicitly (id "github").
// ============================================================================

pub const GITHUB_CONNECTION_ID: &str = "github";

/// A configured git-host connection. Serialized (minus the token) to
/// `git-hosts.json` for Gitea hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostConnection {
    pub id: String,
    pub kind: GitHostKind,
    /// GitHub: `https://api.github.com`. Gitea: the instance origin
    /// (e.g. `https://git.example.com`), `/api/v1` appended when building URLs.
    pub base_url: String,
    pub label: String,
}

impl GitHostConnection {
    fn github() -> Self {
        Self {
            id: GITHUB_CONNECTION_ID.to_string(),
            kind: GitHostKind::GitHub,
            base_url: "https://api.github.com".to_string(),
            label: "GitHub".to_string(),
        }
    }

    /// Resolve this connection to a `GitHost` for request building.
    fn to_host(&self) -> GitHost {
        match self.kind {
            GitHostKind::GitHub => GitHost::github(),
            GitHostKind::Gitea => GitHost::gitea(&self.base_url),
        }
    }
}

/// Keyring account name for a connection's token. The GitHub connection reuses
/// the historical `github-token` account so existing tokens carry over.
fn host_token_account(id: &str) -> String {
    if id == GITHUB_CONNECTION_ID {
        "github-token".to_string()
    } else {
        format!("git-host-token-{}", id)
    }
}

fn host_token_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &host_token_account(id)).ok()
}

fn load_host_token(id: &str) -> Option<String> {
    let raw = host_token_entry(id)?.get_password().ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn save_host_token(id: &str, token: &str) -> Result<(), String> {
    host_token_entry(id)
        .ok_or_else(|| "OS keyring unavailable".to_string())?
        .set_password(token)
        .map_err(|e| format!("Failed to store token in keyring: {}", e))
}

fn delete_host_token(id: &str) {
    if let Some(entry) = host_token_entry(id) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => warn!("Failed to delete token for '{}' from keyring: {}", id, e),
        }
    }
}

fn git_hosts_config_path() -> Option<std::path::PathBuf> {
    super::shared::home_dir().map(|h| {
        std::path::PathBuf::from(h)
            .join(DATA_DIR_NAME)
            .join("git-hosts.json")
    })
}

/// Load persisted Gitea connections (metadata only). GitHub is never persisted
/// here — it is seeded implicitly.
fn load_gitea_connections() -> Vec<GitHostConnection> {
    let Some(path) = git_hosts_config_path() else {
        return vec![];
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    serde_json::from_str::<Vec<GitHostConnection>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.kind == GitHostKind::Gitea && c.id != GITHUB_CONNECTION_ID)
        .collect()
}

fn save_gitea_connections(conns: &[GitHostConnection]) -> Result<(), String> {
    let path = git_hosts_config_path().ok_or_else(|| "no data dir".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let gitea: Vec<&GitHostConnection> = conns
        .iter()
        .filter(|c| c.kind == GitHostKind::Gitea)
        .collect();
    let json = serde_json::to_string_pretty(&gitea).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write git-hosts.json: {}", e))
}

/// Migrate any legacy GitHub token (legacy keyring service / plaintext files)
/// into the current keyring account, then remove the plaintext copies. Unlike
/// the old scrub-on-load, the token now PERSISTS in the current keyring so the
/// user isn't re-prompted after restart.
fn migrate_github_token_to_keyring() {
    if load_host_token(GITHUB_CONNECTION_ID).is_some() {
        // Already in the current keyring — just clear any leftover plaintext.
        for path in [token_file_path(), legacy_token_file_path()]
            .into_iter()
            .flatten()
        {
            let _ = std::fs::remove_file(path);
        }
        return;
    }

    let mut found: Option<String> = None;
    if let Some(entry) = legacy_keyring_entry() {
        if let Ok(token) = entry.get_password() {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                found = Some(trimmed.to_string());
            }
        }
    }
    if found.is_none() {
        for path in [token_file_path(), legacy_token_file_path()]
            .into_iter()
            .flatten()
        {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let raw = Zeroizing::new(raw);
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    found = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }

    if let Some(token) = found {
        if let Err(e) = save_host_token(GITHUB_CONNECTION_ID, &token) {
            warn!("Failed to migrate GitHub token into keyring: {}", e);
        } else {
            info!("Migrated legacy GitHub token into the OS keyring");
        }
    }

    // Plaintext files + the legacy keyring service are superseded by the current
    // keyring account.
    for path in [token_file_path(), legacy_token_file_path()]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_file(path);
    }
    delete_keyring_credential(legacy_keyring_entry(), "legacy");
}

pub struct GitHubAuthState {
    /// All connections: GitHub (implicit, always present) + persisted Gitea.
    connections: RwLock<Vec<GitHostConnection>>,
    /// Connection id → token, hydrated from the OS keyring on startup and kept
    /// there (no re-prompt after restart).
    tokens: RwLock<HashMap<String, String>>,
    /// G4: the connection the pane's commands target, set per-workspace by the
    /// frontend (`git_host_set_active`) from the resolved origin remote.
    active_connection_id: RwLock<String>,
}

impl GitHubAuthState {
    pub fn new() -> Self {
        migrate_github_token_to_keyring();

        let mut connections = vec![GitHostConnection::github()];
        connections.extend(load_gitea_connections());

        let mut tokens = HashMap::new();
        for c in &connections {
            if let Some(t) = load_host_token(&c.id) {
                tokens.insert(c.id.clone(), t);
            }
        }

        Self {
            connections: RwLock::new(connections),
            tokens: RwLock::new(tokens),
            active_connection_id: RwLock::new(GITHUB_CONNECTION_ID.to_string()),
        }
    }

    /// Resolve a connection by id.
    async fn connection(&self, id: &str) -> Option<GitHostConnection> {
        self.connections
            .read()
            .await
            .iter()
            .find(|c| c.id == id)
            .cloned()
    }
}

pub fn create_github_auth_state() -> GitHubAuthState {
    GitHubAuthState::new()
}

/// Build an authenticated client + resolved `GitHost` for a connection id. The
/// Gitea command groups (G4–G12) route through this; GitHub commands keep using
/// `github_client_from_state` (the `"github"` connection). G3 feeds the
/// per-workspace connection id here.
async fn git_host_session(
    auth: &GitHubAuthState,
    connection_id: &str,
) -> Result<(reqwest::Client, GitHost), String> {
    let conn = auth
        .connection(connection_id)
        .await
        .ok_or_else(|| format!("Unknown git-host connection '{}'.", connection_id))?;
    let token = auth
        .tokens
        .read()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("No token for '{}'. Connect first.", conn.label))?;
    let host = conn.to_host();
    let client = host.build_client(&token)?;
    Ok((client, host))
}

/// Build a client + host for whichever connection is currently active (set
/// per-workspace by the frontend). The Gitea-aware command groups (G4+) route
/// through this instead of `github_client_from_state`.
#[allow(dead_code)] // consumed as each command group is routed (G4+)
async fn active_host_session(
    auth: &GitHubAuthState,
) -> Result<(reqwest::Client, GitHost), String> {
    let id = auth.active_connection_id.read().await.clone();
    git_host_session(auth, &id).await
}

/// G4: set the connection the pane's commands target (resolved per-workspace on
/// the frontend from the repo's origin remote).
#[tauri::command]
pub async fn git_host_set_active(
    auth: State<'_, GitHubAuthState>,
    id: String,
) -> Result<(), String> {
    if auth.connection(&id).await.is_none() {
        return Err(format!("Unknown connection '{}'.", id));
    }
    *auth.active_connection_id.write().await = id;
    Ok(())
}

/// Build an authenticated client for the given host + token. GitHub construction
/// is byte-identical to the previous inline builder (Bearer + vnd.github+json +
/// brand UA); Gitea uses the `token` scheme.
fn github_client(token: &str) -> Result<reqwest::Client, String> {
    GitHost::github().build_client(token)
}

fn sanitize_github_error(status: reqwest::StatusCode) -> String {
    let reason = match status.as_u16() {
        401 => "unauthorized — check your GitHub token",
        403 => "forbidden — you may lack permissions or be rate-limited",
        404 => "not found — the resource may not exist or may be private",
        422 => "validation failed — check your request parameters",
        429 => "rate limited — try again later",
        _ if status.is_client_error() => "client error",
        _ if status.is_server_error() => "GitHub server error — try again later",
        _ => "unexpected error",
    };
    format!("GitHub API error {}: {}", status.as_u16(), reason)
}

async fn github_response_text(resp: reqwest::Response) -> Result<String, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        warn!(
            "GitHub API error {}: {}",
            status,
            resp.text().await.unwrap_or_default()
        );
        return Err(sanitize_github_error(status));
    }
    resp.text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

#[tauri::command]
pub async fn github_set_token(
    auth: State<'_, GitHubAuthState>,
    token: String,
) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("GitHub token cannot be empty".to_string());
    }
    save_host_token(GITHUB_CONNECTION_ID, trimmed)?;
    auth.tokens
        .write()
        .await
        .insert(GITHUB_CONNECTION_ID.to_string(), trimmed.to_string());
    info!("GitHub token set (persisted to keyring)");
    Ok(())
}

#[tauri::command]
pub async fn github_clear_token(auth: State<'_, GitHubAuthState>) -> Result<(), String> {
    delete_host_token(GITHUB_CONNECTION_ID);
    // Scrub any lingering legacy plaintext/keyring copies too.
    clear_persisted_token();
    auth.tokens.write().await.remove(GITHUB_CONNECTION_ID);
    info!("GitHub token cleared");
    Ok(())
}

#[tauri::command]
pub async fn github_has_token(auth: State<'_, GitHubAuthState>) -> Result<bool, String> {
    Ok(auth
        .tokens
        .read()
        .await
        .contains_key(GITHUB_CONNECTION_ID))
}

// ---- G2: multi-connection commands (GitHub + Gitea) ----

/// Connection info surfaced to the frontend (token value never leaves Rust).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostConnectionInfo {
    pub id: String,
    pub kind: GitHostKind,
    pub base_url: String,
    pub label: String,
    pub has_token: bool,
}

#[tauri::command]
pub async fn git_host_list_connections(
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<GitHostConnectionInfo>, String> {
    let conns = auth.connections.read().await;
    let tokens = auth.tokens.read().await;
    Ok(conns
        .iter()
        .map(|c| GitHostConnectionInfo {
            id: c.id.clone(),
            kind: c.kind,
            base_url: c.base_url.clone(),
            label: c.label.clone(),
            has_token: tokens.contains_key(&c.id),
        })
        .collect())
}

/// Derive a stable, unique connection id from a Gitea base URL host.
fn unique_gitea_id(base_url: &str, existing: &[GitHostConnection]) -> String {
    let host = base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or("host");
    let slug: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let base = format!("gitea-{}", slug.trim_matches('-'));
    if !existing.iter().any(|c| c.id == base) {
        return base;
    }
    (2..)
        .map(|n| format!("{}-{}", base, n))
        .find(|candidate| !existing.iter().any(|c| &c.id == candidate))
        .unwrap_or(base)
}

#[tauri::command]
pub async fn git_host_add_gitea(
    auth: State<'_, GitHubAuthState>,
    base_url: String,
    label: String,
    token: String,
) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Gitea base URL must start with http:// or https://".to_string());
    }
    let token = token.trim();
    if token.is_empty() {
        return Err("Gitea token cannot be empty".to_string());
    }
    let label = {
        let l = label.trim();
        if l.is_empty() {
            base.to_string()
        } else {
            l.to_string()
        }
    };

    let mut conns = auth.connections.write().await;
    let id = unique_gitea_id(base, &conns);
    conns.push(GitHostConnection {
        id: id.clone(),
        kind: GitHostKind::Gitea,
        base_url: base.to_string(),
        label,
    });
    save_gitea_connections(&conns)?;
    drop(conns);

    save_host_token(&id, token)?;
    auth.tokens.write().await.insert(id.clone(), token.to_string());
    info!("Added Gitea connection '{}'", id);
    Ok(id)
}

#[tauri::command]
pub async fn git_host_remove_connection(
    auth: State<'_, GitHubAuthState>,
    id: String,
) -> Result<(), String> {
    if id == GITHUB_CONNECTION_ID {
        return Err("The GitHub connection cannot be removed.".to_string());
    }
    let mut conns = auth.connections.write().await;
    let before = conns.len();
    conns.retain(|c| c.id != id);
    if conns.len() == before {
        return Err(format!("Unknown connection '{}'.", id));
    }
    save_gitea_connections(&conns)?;
    drop(conns);

    delete_host_token(&id);
    auth.tokens.write().await.remove(&id);
    info!("Removed git-host connection '{}'", id);
    Ok(())
}

#[tauri::command]
pub async fn git_host_set_token(
    auth: State<'_, GitHubAuthState>,
    id: String,
    token: String,
) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token cannot be empty".to_string());
    }
    if auth.connection(&id).await.is_none() {
        return Err(format!("Unknown connection '{}'.", id));
    }
    save_host_token(&id, token)?;
    auth.tokens.write().await.insert(id, token.to_string());
    Ok(())
}

#[tauri::command]
pub async fn git_host_has_token(
    auth: State<'_, GitHubAuthState>,
    id: String,
) -> Result<bool, String> {
    Ok(auth.tokens.read().await.contains_key(&id))
}

async fn github_client_from_state(auth: &GitHubAuthState) -> Result<reqwest::Client, String> {
    let token = auth
        .tokens
        .read()
        .await
        .get(GITHUB_CONNECTION_ID)
        .cloned()
        .ok_or_else(|| "GitHub token not set. Connect first.".to_string())?;
    github_client(&token)
}

async fn github_get_issue_with_client(
    client: &reqwest::Client,
    host: &GitHost,
    owner: &str,
    repo: &str,
    issue_number: u32,
) -> Result<String, String> {
    let resp = client
        .get(host.url(&format!("/repos/{}/{}/issues/{}", owner, repo, issue_number)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_list_repos(auth: State<'_, GitHubAuthState>) -> Result<String, String> {
    let (client, host) = active_host_session(auth.inner()).await?;
    let resp = client
        .get(host.url(&host.user_repos_path(1)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[derive(serde::Serialize)]
pub struct GhUser {
    pub login: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
}

/// Fetch the authenticated user (`GET /user`). Used to render the correct
/// "Connected · {username}" badge regardless of which org's repo is selected.
#[tauri::command]
pub async fn github_get_authenticated_user(
    auth: State<'_, GitHubAuthState>,
) -> Result<GhUser, String> {
    // G4: route to the active host (GitHub or Gitea). Both return {login,
    // avatar_url} from `/user`, so no normalization is needed.
    let (client, host) = active_host_session(auth.inner()).await?;
    let resp = client
        .get(host.url("/user"))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse user: {}", e))?;
    let login = parsed["login"]
        .as_str()
        .ok_or_else(|| "GitHub /user response missing 'login'".to_string())?
        .to_string();
    let avatar_url = parsed["avatar_url"].as_str().unwrap_or("").to_string();
    Ok(GhUser { login, avatar_url })
}

#[tauri::command]
pub async fn github_list_issues(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&format!(
        "/repos/{}/{}/issues?state=open&{}",
        owner,
        repo,
        host.page_params(50, 1)
    ));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    // GitHub's /issues endpoint returns BOTH issues and PRs; PRs carry a
    // `pull_request` object on each item. Strip them server-side so the
    // Issues tab badge and list show only real issues.
    match serde_json::from_str::<Vec<serde_json::Value>>(&body) {
        Ok(items) => {
            let filtered: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|item| item.get("pull_request").is_none())
                .collect();
            serde_json::to_string(&filtered)
                .map_err(|e| format!("Failed to serialize issues: {}", e))
        }
        // If the response is not an array (e.g. error envelope leaked through),
        // pass it through unchanged so the frontend can surface the original
        // error text.
        Err(_) => Ok(body),
    }
}

#[tauri::command]
pub async fn github_get_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let (client, host) = active_host_session(auth.inner()).await?;
    github_get_issue_with_client(&client, &host, &owner, &repo, issue_number).await
}

/// `POST /repos/{owner}/{repo}/pulls` — create a Pull Request.
///
/// v0.8-G: extended with an optional `draft` flag. When omitted (legacy
/// callers), GitHub treats the PR as a normal, ready-for-review PR. When
/// `Some(true)`, GitHub opens the PR in draft state. Repos must support
/// draft PRs (free public + paid private). If the repo doesn't, GitHub
/// returns a 422 and the error surfaces verbatim.
#[tauri::command]
pub async fn github_create_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: Option<bool>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!("https://api.github.com/repos/{}/{}/pulls", owner, repo);

    let mut payload = serde_json::json!({
        "title": title,
        "body": body,
        "head": head,
        "base": base,
    });
    if let Some(d) = draft {
        payload["draft"] = serde_json::Value::Bool(d);
    }

    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_list_prs(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&format!(
        "/repos/{}/{}/pulls?state=open&{}",
        owner,
        repo,
        host.page_params(30, 1)
    ));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_get_pr_diff(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    // G6: GitHub serves the diff from the PR resource via a media-type Accept
    // header; Gitea serves it at a `.diff` URL suffix. Route through the active
    // host's client so auth is correct for either.
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&host.pr_diff_path(&owner, &repo, pr_number));
    let mut req = client.get(url);
    if let Some(accept) = host.pr_diff_accept() {
        req = req.header(ACCEPT, accept);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    github_response_text(resp).await
}

// === v0.8-C: issue interactivity (comments, state, labels, assignees,
// milestones, repo metadata pickers, pagination) ===========================

/// Comment DTO matching GitHub's `/issues/{n}/comments` response shape with a
/// thin avatar URL projection.
#[derive(serde::Serialize)]
pub struct GhCommentUser {
    pub login: String,
    pub avatar_url: String,
}

#[derive(serde::Serialize)]
pub struct GhIssueComment {
    pub id: u64,
    pub user: GhCommentUser,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

fn parse_comment(v: &serde_json::Value) -> GhIssueComment {
    let user = v.get("user");
    GhIssueComment {
        id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        user: GhCommentUser {
            login: user
                .and_then(|u| u.get("login"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            avatar_url: user
                .and_then(|u| u.get("avatar_url"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        },
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        created_at: v
            .get("created_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: v
            .get("updated_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        html_url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

#[tauri::command]
pub async fn github_list_issue_comments(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<Vec<GhIssueComment>, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&format!(
        "/repos/{}/{}/issues/{}/comments?{}",
        owner,
        repo,
        number,
        host.page_params(100, 1)
    ));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse comments: {}", e))?;
    Ok(arr.iter().map(parse_comment).collect())
}

#[tauri::command]
pub async fn github_post_issue_comment(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    body: String,
) -> Result<GhIssueComment, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Comment body cannot be empty".to_string());
    }
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}/comments",
        owner, repo, number
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "body": trimmed }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse comment: {}", e))?;
    Ok(parse_comment(&v))
}

async fn patch_issue(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    number: u32,
    payload: serde_json::Value,
) -> Result<String, String> {
    let client = github_client_from_state(auth).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}",
        owner, repo, number
    );
    let resp = client
        .patch(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_close_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    patch_issue(
        auth.inner(),
        &owner,
        &repo,
        number,
        serde_json::json!({ "state": "closed" }),
    )
    .await
}

#[tauri::command]
pub async fn github_reopen_issue(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    patch_issue(
        auth.inner(),
        &owner,
        &repo,
        number,
        serde_json::json!({ "state": "open" }),
    )
    .await
}

#[tauri::command]
pub async fn github_set_issue_assignees(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    assignees: Vec<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    patch_issue(
        auth.inner(),
        &owner,
        &repo,
        number,
        serde_json::json!({ "assignees": assignees }),
    )
    .await
}

#[tauri::command]
pub async fn github_set_issue_labels(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    labels: Vec<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}/labels",
        owner, repo, number
    );
    let resp = client
        .put(&url)
        .json(&serde_json::json!({ "labels": labels }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_set_issue_milestone(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    milestone: Option<u64>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let payload = match milestone {
        Some(n) => serde_json::json!({ "milestone": n }),
        None => serde_json::json!({ "milestone": serde_json::Value::Null }),
    };
    patch_issue(auth.inner(), &owner, &repo, number, payload).await
}

#[tauri::command]
pub async fn github_list_repo_labels(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/labels?per_page=100",
        owner, repo
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_list_repo_milestones(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/milestones?state=open&per_page=100",
        owner, repo
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_list_repo_assignable_users(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/assignees?per_page=100",
        owner, repo
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_list_issues_page(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    state: String,
    page: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let state_clean = match state.as_str() {
        "open" | "closed" | "all" => state,
        _ => "open".to_string(),
    };
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&format!(
        "/repos/{}/{}/issues?state={}&{}",
        owner,
        repo,
        state_clean,
        host.page_params(30, page)
    ));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    // Both GitHub and Gitea emit RFC5988 Link headers with rel="next".
    let has_more = resp
        .headers()
        .get(LINK)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|link| link.contains("rel=\"next\""));
    let body = github_response_text(resp).await?;
    match serde_json::from_str::<Vec<serde_json::Value>>(&body) {
        Ok(items) => {
            let filtered: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|item| item.get("pull_request").is_none())
                .collect();
            serde_json::to_string(&serde_json::json!({
                "items": filtered,
                "has_more": has_more,
            }))
            .map_err(|e| format!("Failed to serialize issues: {}", e))
        }
        Err(_) => Ok(body),
    }
}

#[tauri::command]
pub async fn github_list_prs_page(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    state: String,
    page: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let state_clean = match state.as_str() {
        "open" | "closed" | "all" => state,
        _ => "open".to_string(),
    };
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&format!(
        "/repos/{}/{}/pulls?state={}&{}",
        owner,
        repo,
        state_clean,
        host.page_params(30, page)
    ));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_list_repos_page(
    auth: State<'_, GitHubAuthState>,
    page: u32,
) -> Result<String, String> {
    let (client, host) = active_host_session(auth.inner()).await?;
    let resp = client
        .get(host.url(&host.user_repos_path(page)))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

#[tauri::command]
pub async fn github_investigate_issue(
    auth: State<'_, GitHubAuthState>,
    project_path: String,
    owner: String,
    repo: String,
    issue_number: u32,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;

    let issue_json =
        github_get_issue_with_client(&client, &GitHost::github(), &owner, &repo, issue_number)
            .await?;
    let issue: serde_json::Value =
        serde_json::from_str(&issue_json).map_err(|e| format!("Failed to parse issue: {}", e))?;

    let title = issue["title"].as_str().unwrap_or("Unknown");
    let body = issue["body"].as_str().unwrap_or("No description");

    // v0.8-E: prompt construction moved to `core::github_ai_prompts` so all
    // GitHub AI features share one home. Behaviour here is identical to the
    // pre-v0.8-E inline format — same string, same `run_claude` invocation.
    let prompt = crate::core::github_ai_prompts::investigate_issue_prompt(title, body);

    crate::claude::binary::run_claude(&prompt, Some(&project_path)).await
}

// === v0.8-E: AI PR description + AI pre-flight code review =================
//
// Both commands run a one-shot `claude-oauth` sidecar session and stream
// assistant chunks to the frontend over the existing
// `api-agent:chunk:<sessionId>` / `api-agent:done:<sessionId>` event
// channels — the same wire shape every API-agent conversation uses, so the
// frontend listener code in `PRDescriptionButton.tsx` / `PRReviewPanel.tsx`
// is just a thin chunk-buffer + done-resolver pair.
//
// The Tauri command itself returns the freshly minted `session_id` to the
// caller and does NOT block on the assistant turn. A spawned background
// task awaits the supervisor's one-shot waiter (which resolves on the
// `done`/`error` events that fire after the model finishes) and then
// closes the sidecar session.

/// Maximum raw diff bytes shipped to the model. PR-description prompts get
/// less context than reviews; bumping either is cheap.
const PR_DESCRIPTION_DIFF_CAP_BYTES: usize = 50 * 1024;
const PR_REVIEW_DIFF_CAP_BYTES: usize = 75 * 1024;
const PR_DESCRIPTION_COMMIT_CAP: usize = 50;
const AI_PR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
const AI_PR_MODEL: &str = "claude-sonnet-4-6";
const AI_PR_PROVIDER: &str = "claude-oauth";

/// Cut `text` to at most `cap` bytes ending on a UTF-8 boundary. Returns
/// `(text, was_truncated, original_byte_len)`. Appends a graceful marker
/// when truncated so the model sees a clean stop.
fn truncate_for_model(text: &str, cap: usize) -> (String, bool, usize) {
    let original_len = text.len();
    if original_len <= cap {
        return (text.to_string(), false, original_len);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].to_string();
    s.push_str(&format!(
        "\n\n... (truncated, original size {} bytes)\n",
        original_len
    ));
    (s, true, original_len)
}

/// Spawn a background task that awaits the one-shot completion then runs
/// `forward_close`, ensuring the sidecar supervisor doesn't keep the
/// session in its owned-sessions set after the model finishes streaming.
fn spawn_oneshot_cleanup(
    manager: std::sync::Arc<crate::commands::agent_sidecar::SidecarManager>,
    session_id: String,
    receiver: tokio::sync::oneshot::Receiver<Result<String, String>>,
    feature: &'static str,
) {
    tokio::spawn(async move {
        match tokio::time::timeout(AI_PR_TIMEOUT, receiver).await {
            Ok(Ok(Ok(_))) => {}
            Ok(Ok(Err(msg))) => {
                warn!(feature, session_id = %session_id, error = %msg, "AI PR feature: sidecar reported error");
            }
            Ok(Err(_)) => {
                warn!(feature, session_id = %session_id, "AI PR feature: waiter dropped before completion");
            }
            Err(_) => {
                warn!(feature, session_id = %session_id, timeout_secs = AI_PR_TIMEOUT.as_secs(), "AI PR feature: timed out waiting for sidecar done");
            }
        }
        if let Err(e) = manager.forward_close(session_id.clone()).await {
            warn!(feature, session_id = %session_id, error = %e, "AI PR feature: forward_close failed (non-fatal)");
        }
    });
}

/// `GET /repos/{o}/{r}/compare/{base}...{head}` with `Accept:
/// application/vnd.github.v3.diff` — returns the raw unified diff blob.
async fn fetch_compare_patch(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    base: &str,
    head: &str,
) -> Result<String, String> {
    let token = auth
        .tokens
        .read()
        .await
        .get(GITHUB_CONNECTION_ID)
        .cloned()
        .ok_or_else(|| "GitHub token not set".to_string())?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/compare/{}...{}",
        owner, repo, base, head
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {}", token))
        .header(ACCEPT, "application/vnd.github.v3.diff")
        .header(USER_AGENT, BRAND_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `GET /repos/{o}/{r}/commits?sha={head}&per_page=N` — fetch the latest N
/// commits on `head`. Returns message strings only, reversed to
/// chronological order.
async fn fetch_commit_messages(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    head: &str,
    per_page: usize,
) -> Result<Vec<String>, String> {
    let client = github_client_from_state(auth).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/commits?sha={}&per_page={}",
        owner, repo, head, per_page
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse commits: {}", e))?;
    let mut msgs: Vec<String> = arr
        .iter()
        .filter_map(|v| {
            v.get("commit")
                .and_then(|c| c.get("message"))
                .and_then(|m| m.as_str())
        })
        .map(|s| s.to_string())
        .collect();
    msgs.reverse();
    Ok(msgs)
}

/// Fetch one issue's title + body. Failures (404, private, network) are
/// returned as `None` so the caller silently skips rather than failing the
/// whole command.
async fn fetch_issue_title_body(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    number: u32,
) -> Option<(String, String)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}",
        owner, repo, number
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let issue_body = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Some((title, issue_body))
}

/// `github_ai_pr_description` — kick off a one-shot `claude-oauth` sidecar
/// session that writes a structured PR description from a base..head diff,
/// the branch's recent commits, and (optionally) the linked-issue bodies.
///
/// Returns the freshly minted `session_id`. The caller subscribes to
/// `api-agent:chunk:<sessionId>` for streamed text deltas and
/// `api-agent:done:<sessionId>` for completion. The command does not wait
/// for the assistant turn to finish.
#[tauri::command]
pub async fn github_ai_pr_description(
    auth: State<'_, GitHubAuthState>,
    sidecar: State<'_, std::sync::Arc<crate::commands::agent_sidecar::SidecarManager>>,
    owner: String,
    repo: String,
    base: String,
    head: String,
    draft_title: Option<String>,
    linked_issue_numbers: Option<Vec<u32>>,
    // v0.8 race-fix: lets the frontend pre-allocate the session id (e.g.
    // via `crypto.randomUUID()`) BEFORE invoking, so listeners can be
    // attached first and no early chunks are dropped. Falls back to a
    // server-side UUID when the caller doesn't supply one.
    session_id_override: Option<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;

    let auth_inner = auth.inner();

    let (diff_result, commits_result) = tokio::join!(
        fetch_compare_patch(auth_inner, &owner, &repo, &base, &head),
        fetch_commit_messages(auth_inner, &owner, &repo, &head, PR_DESCRIPTION_COMMIT_CAP),
    );
    let diff_raw = diff_result?;
    let commit_messages = commits_result.unwrap_or_else(|e| {
        warn!(
            error = %e,
            "github_ai_pr_description: commit fetch failed, continuing without commit context"
        );
        Vec::new()
    });

    let linked_inputs: Vec<(u32, String, String)> = if let Some(nums) = linked_issue_numbers {
        let client = github_client_from_state(auth_inner).await?;
        let futures = nums.iter().map(|n| {
            let client = client.clone();
            let owner = owner.clone();
            let repo = repo.clone();
            let n = *n;
            async move {
                fetch_issue_title_body(&client, &owner, &repo, n)
                    .await
                    .map(|(t, b)| (n, t, b))
            }
        });
        let results = futures::future::join_all(futures).await;
        results.into_iter().flatten().collect()
    } else {
        Vec::new()
    };

    let (diff_text, truncated, original) =
        truncate_for_model(&diff_raw, PR_DESCRIPTION_DIFF_CAP_BYTES);

    let linked_refs: Vec<crate::core::github_ai_prompts::LinkedIssueInput<'_>> = linked_inputs
        .iter()
        .map(
            |(n, t, b)| crate::core::github_ai_prompts::LinkedIssueInput {
                number: *n,
                title: t.as_str(),
                body: b.as_str(),
            },
        )
        .collect();

    let user_turn = crate::core::github_ai_prompts::pr_description_user_turn(
        &owner,
        &repo,
        &base,
        &head,
        draft_title.as_deref(),
        &diff_text,
        truncated,
        original,
        &commit_messages,
        &linked_refs,
    );

    let manager = std::sync::Arc::clone(&*sidecar);
    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("ai-pr-description-{}", uuid::Uuid::new_v4()));
    let receiver = manager.wait_for_oneshot(&session_id).await;

    let start = manager
        .forward_start(
            session_id.clone(),
            AI_PR_PROVIDER.to_string(),
            AI_PR_MODEL.to_string(),
            crate::core::github_ai_prompts::PR_DESCRIPTION_SYSTEM_PROMPT.to_string(),
            Vec::new(),
            serde_json::Value::Null,
            false, // source_mcp_from_fs — local session
            String::new(),
            user_turn,
            None,
            None,
            Some(false),
            Some(false),
            serde_json::Value::Null,
            serde_json::Value::Null,
            None,
            None,
            None,
            None,
        )
        .await;

    if let Err(e) = start {
        drop(receiver);
        return Err(format!("Failed to start AI PR description session: {}", e));
    }

    spawn_oneshot_cleanup(
        manager,
        session_id.clone(),
        receiver,
        "github_ai_pr_description",
    );

    info!(
        owner = %owner,
        repo = %repo,
        base = %base,
        head = %head,
        session_id = %session_id,
        "AI PR description session started"
    );

    Ok(session_id)
}

/// `github_ai_pr_review` — kick off a one-shot `claude-oauth` sidecar
/// session that produces a structured pre-flight code review (Blocking /
/// Asks / Nits sections) over an existing PR's diff.
///
/// Returns the freshly minted `session_id`. See [`github_ai_pr_description`]
/// for the event-channel + lifecycle contract.
#[tauri::command]
pub async fn github_ai_pr_review(
    auth: State<'_, GitHubAuthState>,
    sidecar: State<'_, std::sync::Arc<crate::commands::agent_sidecar::SidecarManager>>,
    owner: String,
    repo: String,
    pr_number: u32,
    // v0.8 race-fix: see `github_ai_pr_description::session_id_override`.
    // Frontend pre-allocates the session id so it can subscribe BEFORE the
    // sidecar starts emitting chunks.
    session_id_override: Option<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;

    let client = github_client_from_state(auth.inner()).await?;
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body_text = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value =
        serde_json::from_str(&pr_body_text).map_err(|e| format!("Failed to parse PR: {}", e))?;
    let pr_title = pr_json
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("(untitled)")
        .to_string();
    let pr_body = pr_json
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let token = auth
        .tokens
        .read()
        .await
        .get(GITHUB_CONNECTION_ID)
        .cloned()
        .ok_or_else(|| "GitHub token not set".to_string())?;
    let raw_client = reqwest::Client::new();
    let diff_resp = raw_client
        .get(&pr_url)
        .header(AUTHORIZATION, format!("Bearer {}", token))
        .header(ACCEPT, "application/vnd.github.v3.diff")
        .header(USER_AGENT, BRAND_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let diff_raw = github_response_text(diff_resp).await?;

    let (diff_text, truncated, original) = truncate_for_model(&diff_raw, PR_REVIEW_DIFF_CAP_BYTES);

    let user_turn = crate::core::github_ai_prompts::pr_review_user_turn(
        &owner, &repo, pr_number, &pr_title, &pr_body, &diff_text, truncated, original,
    );

    let manager = std::sync::Arc::clone(&*sidecar);
    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("ai-pr-review-{}", uuid::Uuid::new_v4()));
    let receiver = manager.wait_for_oneshot(&session_id).await;

    let start = manager
        .forward_start(
            session_id.clone(),
            AI_PR_PROVIDER.to_string(),
            AI_PR_MODEL.to_string(),
            crate::core::github_ai_prompts::PR_REVIEW_SYSTEM_PROMPT.to_string(),
            Vec::new(),
            serde_json::Value::Null,
            false, // source_mcp_from_fs — local session
            String::new(),
            user_turn,
            None,
            None,
            Some(false),
            Some(false),
            serde_json::Value::Null,
            serde_json::Value::Null,
            None,
            None,
            None,
            None,
        )
        .await;

    if let Err(e) = start {
        drop(receiver);
        return Err(format!("Failed to start AI PR review session: {}", e));
    }

    spawn_oneshot_cleanup(manager, session_id.clone(), receiver, "github_ai_pr_review");

    info!(
        owner = %owner,
        repo = %repo,
        pr = pr_number,
        session_id = %session_id,
        "AI PR review session started"
    );

    Ok(session_id)
}

// === v0.8-G: PR modal upgrades =============================================
//
// These commands back the upgraded `PRModal` (branch autocomplete, reviewer
// / label / milestone pickers) and the "Publish attempts as draft PRs"
// option on async Flights. They mirror the same auth + error-sanitization
// pattern as the rest of `github.rs`.

/// One branch row, derived from `GET /repos/{owner}/{repo}/branches`. We
/// keep the schema minimal — name + SHA are enough for autocomplete and
/// for triggering downstream fetches.
#[derive(serde::Serialize)]
pub struct GitHubBranch {
    pub name: String,
    pub sha: String,
    #[serde(rename = "isProtected")]
    pub is_protected: bool,
}

/// `GET /repos/{owner}/{repo}/branches?per_page=100` — list a repository's
/// branches. GitHub returns up to 30 by default; we bump to 100 to make
/// the picker useful on busy repos without paginating. The frontend
/// further sorts/filters (recent-first via local heuristics).
#[tauri::command]
pub async fn github_list_branches(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
) -> Result<Vec<GitHubBranch>, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let (client, host) = active_host_session(auth.inner()).await?;
    let url = host.url(&format!(
        "/repos/{}/{}/branches?{}",
        owner,
        repo,
        host.page_params(100, 1)
    ));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse branches: {}", e))?;

    let mut out: Vec<GitHubBranch> = Vec::with_capacity(raw.len());
    for b in raw {
        let name = b["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        // GitHub exposes the tip SHA as commit.sha; Gitea as commit.id.
        let sha = b["commit"]["sha"]
            .as_str()
            .or_else(|| b["commit"]["id"].as_str())
            .unwrap_or("")
            .to_string();
        let is_protected = b["protected"].as_bool().unwrap_or(false);
        out.push(GitHubBranch {
            name,
            sha,
            is_protected,
        });
    }
    Ok(out)
}

/// `POST /repos/{owner}/{repo}/pulls/{number}/requested_reviewers` —
/// request review from a set of users on an existing PR. GitHub silently
/// ignores users who can't be assigned (not collaborators); errors only
/// fire on malformed input or auth failures.
#[tauri::command]
pub async fn github_set_pr_reviewers(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    reviewers: Vec<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    if reviewers.is_empty() {
        return Ok("{}".to_string());
    }
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/requested_reviewers",
        owner, repo, number
    );
    let payload = serde_json::json!({ "reviewers": reviewers });
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `PUT /repos/{owner}/{repo}/issues/{number}/labels` — set labels on a PR
/// (PRs are issues in GitHub's data model, so the issues endpoint works).
/// PUT replaces the full label set; an empty list clears all labels.
#[tauri::command]
pub async fn github_set_pr_labels(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    labels: Vec<String>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}/labels",
        owner, repo, number
    );
    let payload = serde_json::json!({ "labels": labels });
    let resp = client
        .put(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `PATCH /repos/{owner}/{repo}/issues/{number}` — set (or clear) the
/// milestone on a PR. `Some(n)` assigns, `None` clears (GitHub uses a
/// literal `null` for clearing rather than field omission).
#[tauri::command]
pub async fn github_set_pr_milestone(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    milestone: Option<u64>,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/issues/{}",
        owner, repo, number
    );
    let payload = match milestone {
        Some(n) => serde_json::json!({ "milestone": n }),
        None => serde_json::json!({ "milestone": serde_json::Value::Null }),
    };
    let resp = client
        .patch(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

// === v0.8-F: AI catch-me-up digest + AI issue triage =======================
//
// Both features go through the in-process Anthropic `LlmProvider` so they
// run regardless of which sidecar provider the user has configured (no
// CLI dependency, no sidecar dependency). The digest emits on the
// existing `api-agent:*` event channel so the digest panel can reuse
// `apiAgentChunkEvent` / `apiAgentDoneEvent` / `apiAgentErrorEvent` from
// the agent infrastructure rather than inventing a parallel event family.

const CATCH_UP_PROVIDER: &str = "anthropic";
const CATCH_UP_MODEL: &str = "claude-haiku-4-5";
const TRIAGE_BATCH_MAX: usize = 20;

/// Lightweight `YYYY-MM-DDTHH:MM:SSZ` parser. Hand-rolled to avoid
/// adding chrono as a direct dep.
fn parse_iso_millis_v0_8_f(s: &str) -> Option<i64> {
    if s.len() < 20 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000)
}

fn format_rfc3339_utc(unix_millis: i64) -> String {
    let secs = unix_millis.div_euclid(1000);
    let mut days = secs.div_euclid(86_400);
    let mut secs_of_day = secs.rem_euclid(86_400);
    if secs_of_day < 0 {
        secs_of_day += 86_400;
        days -= 1;
    }
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + (if mp >= 10 { 1 } else { 0 });
    let hour = (secs_of_day / 3600) as u32;
    let minute = ((secs_of_day % 3600) / 60) as u32;
    let second = (secs_of_day % 60) as u32;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hour, minute, second
    )
}

fn default_since_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    format_rfc3339_utc(now_ms - 7 * 24 * 60 * 60 * 1000)
}

fn since_label_for(since_iso: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    if since_iso.len() < 20 {
        return since_iso.to_string();
    }
    let parsed = parse_iso_millis_v0_8_f(since_iso);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Some(ms) = parsed {
        let delta_h = ((now_ms - ms) / 3_600_000).max(1);
        if delta_h <= 36 {
            return format!("{} hours ago", delta_h);
        }
        let delta_d = (delta_h / 24).max(1);
        return format!("{} days ago", delta_d);
    }
    since_iso.to_string()
}

/// Triage DTO returned to the frontend. `suggestedLabels` / `duplicateOf`
/// use camelCase to match `src/types/github.ts`.
#[derive(Serialize, Deserialize, Clone)]
pub struct TriageSuggestion {
    pub number: u32,
    #[serde(rename = "suggestedLabels")]
    pub suggested_labels: Vec<String>,
    pub priority: String,
    pub rationale: String,
    #[serde(rename = "duplicateOf", skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<u32>,
}

// NOTE: chunk events emit a raw `String` payload (see `ai_chunk_event`
// emit site below) — this matches the canonical `api-agent:chunk:<sid>`
// contract used by `agent_sidecar.rs` and `api_agent.rs`. There is
// deliberately no `AiChunkPayload` struct.
#[derive(Clone, Serialize)]
struct AiDonePayload {}
#[derive(Clone, Serialize)]
struct AiErrorPayload {
    message: String,
}

fn ai_chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
fn ai_done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
fn ai_error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}

fn render_activity_block(
    events: &[serde_json::Value],
    closed_issues: &[serde_json::Value],
    merged_prs: &[serde_json::Value],
    stale_open_prs: &[serde_json::Value],
) -> String {
    let mut out = String::new();

    if !merged_prs.is_empty() {
        out.push_str("# Merged PRs\n");
        for pr in merged_prs {
            let num = pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
            let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let user = pr
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let merged_at = pr.get("merged_at").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "- PR #{} by @{} ({}): {}\n",
                num, user, merged_at, title
            ));
        }
        out.push('\n');
    }

    if !closed_issues.is_empty() {
        out.push_str("# Closed issues\n");
        for iss in closed_issues {
            let num = iss.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
            let title = iss.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let closed_at = iss.get("closed_at").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!("- #{} (closed {}): {}\n", num, closed_at, title));
        }
        out.push('\n');
    }

    if !stale_open_prs.is_empty() {
        out.push_str("# Open PRs needing review (>= 1 day stale)\n");
        for pr in stale_open_prs {
            let num = pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
            let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let user = pr
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let updated_at = pr.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "- PR #{} by @{} (last touched {}): {}\n",
                num, user, updated_at, title
            ));
        }
        out.push('\n');
    }

    if !events.is_empty() {
        out.push_str("# Repo events\n");
        for ev in events.iter().take(40) {
            let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("?");
            let actor = ev
                .get("actor")
                .and_then(|a| a.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let created_at = ev.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            let what = match kind {
                "IssueCommentEvent" | "IssuesEvent" => ev
                    .pointer("/payload/issue/title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                "PullRequestEvent" | "PullRequestReviewEvent" | "PullRequestReviewCommentEvent" => {
                    ev.pointer("/payload/pull_request/title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                }
                "PushEvent" => ev
                    .pointer("/payload/ref")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                _ => "",
            };
            out.push_str(&format!(
                "- {} by @{} ({}): {}\n",
                kind, actor, created_at, what
            ));
        }
    }

    if out.is_empty() {
        out.push_str("(no activity in window)\n");
    }
    out
}

/// v0.8-F — AI catch-me-up digest. Streams a four-section markdown
/// summary of recent repo activity. Emits `api-agent:chunk:<sessionId>`
/// per text delta, then `api-agent:done:<sessionId>` on success or
/// `api-agent:error:<sessionId>` with `{ message }` on failure.
#[tauri::command]
pub async fn github_ai_catch_up(
    app_handle: AppHandle,
    auth: State<'_, GitHubAuthState>,
    session_id: String,
    owner: String,
    repo: String,
    since_iso8601: Option<String>,
) -> Result<(), String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    if session_id.trim().is_empty() {
        return Err("session_id cannot be empty".to_string());
    }

    let since = since_iso8601
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_since_iso);

    let client = github_client_from_state(auth.inner()).await?;

    async fn fetch_array(client: &reqwest::Client, url: &str) -> Vec<serde_json::Value> {
        let resp = match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!("catch_up: fetch failed for {}: {}", url, e);
                return Vec::new();
            }
        };
        if !resp.status().is_success() {
            warn!("catch_up: non-2xx for {}: {}", url, resp.status());
            return Vec::new();
        }
        match resp.text().await {
            Ok(body) => serde_json::from_str::<Vec<serde_json::Value>>(&body).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    let events_url = format!(
        "https://api.github.com/repos/{}/{}/events?per_page=100",
        owner, repo
    );
    let closed_issues_url = format!(
        "https://api.github.com/repos/{}/{}/issues?state=closed&since={}&per_page=30",
        owner, repo, since
    );
    let merged_prs_url = format!(
        "https://api.github.com/repos/{}/{}/pulls?state=closed&sort=updated&direction=desc&per_page=30",
        owner, repo
    );
    let open_prs_url = format!(
        "https://api.github.com/repos/{}/{}/pulls?state=open&sort=updated&direction=desc&per_page=30",
        owner, repo
    );

    let (events_raw, closed_issues_raw, closed_prs_raw, open_prs_raw) = tokio::join!(
        fetch_array(&client, &events_url),
        fetch_array(&client, &closed_issues_url),
        fetch_array(&client, &merged_prs_url),
        fetch_array(&client, &open_prs_url),
    );

    let since_ms = parse_iso_millis_v0_8_f(&since).unwrap_or(0);

    let events: Vec<serde_json::Value> = events_raw
        .into_iter()
        .filter(|ev| {
            ev.get("created_at")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_millis_v0_8_f)
                .map(|ms| ms >= since_ms)
                .unwrap_or(false)
        })
        .collect();

    let closed_issues: Vec<serde_json::Value> = closed_issues_raw
        .into_iter()
        .filter(|i| i.get("pull_request").is_none())
        .collect();

    let merged_prs: Vec<serde_json::Value> = closed_prs_raw
        .into_iter()
        .filter(|pr| {
            let merged_at = pr.get("merged_at").and_then(|v| v.as_str());
            match merged_at {
                Some(s) => parse_iso_millis_v0_8_f(s)
                    .map(|ms| ms >= since_ms)
                    .unwrap_or(false),
                None => false,
            }
        })
        .collect();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let one_day_ms: i64 = 24 * 60 * 60 * 1000;
    let stale_open_prs: Vec<serde_json::Value> = open_prs_raw
        .into_iter()
        .filter(|pr| {
            pr.get("updated_at")
                .and_then(|v| v.as_str())
                .and_then(parse_iso_millis_v0_8_f)
                .map(|ms| (now_ms - ms) >= one_day_ms)
                .unwrap_or(false)
        })
        .collect();

    let activity_block =
        render_activity_block(&events, &closed_issues, &merged_prs, &stale_open_prs);

    let since_label = since_label_for(&since);
    let (system_prompt, user_turn) = crate::core::github_ai_prompts::catch_up_prompt(
        &owner,
        &repo,
        &since_label,
        &activity_block,
    );

    super::validate_input_size(&user_turn, super::MAX_INPUT_SIZE, "Catch-up user turn")?;

    let api_key = crate::commands::api_keys::load_api_key("anthropic")
        .map_err(|e| format!("AI digest needs an Anthropic API key. {}", e))?;

    info!(
        owner = %owner,
        repo = %repo,
        since = %since,
        events = events.len(),
        closed_issues = closed_issues.len(),
        merged_prs = merged_prs.len(),
        stale_prs = stale_open_prs.len(),
        "github_ai_catch_up: streaming digest",
    );

    let provider = crate::core::llm_provider::get_provider(CATCH_UP_PROVIDER)
        .map_err(|e| format!("Provider unavailable: {}", e))?;

    let messages = vec![crate::core::llm_types::ChatMessage {
        role: crate::core::llm_types::ChatRole::User,
        content: crate::core::llm_types::MessageContent::text(user_turn),
    }];
    let request = crate::core::llm_types::LlmRequest {
        model: CATCH_UP_MODEL.to_string(),
        messages,
        tools: Vec::new(),
        system_prompt: Some(system_prompt),
        max_tokens: 2048,
        temperature: Some(0.3),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
    };

    let handle = app_handle.clone();
    let sid = session_id.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::core::llm_types::StreamChunk>(64);
        let provider_task =
            tokio::spawn(async move { provider.stream_chat(&api_key, request, tx).await });

        let mut error: Option<String> = None;
        let mut total: usize = 0;
        while let Some(chunk) = rx.recv().await {
            match chunk {
                crate::core::llm_types::StreamChunk::TextDelta { text } => {
                    if text.is_empty() {
                        continue;
                    }
                    total += text.len();
                    // Contract: `api-agent:chunk:<sid>` payload is a raw
                    // string, matching the sidecar / api_agent emitters.
                    // (Other v0.8-F emitters had wrapped the text in a
                    // `{delta}` envelope, which broke the AICatchUp listener
                    // until we noticed during peer review.)
                    let _ = handle.emit(&ai_chunk_event(&sid), &text);
                }
                crate::core::llm_types::StreamChunk::Error { message } => {
                    error = Some(message);
                    break;
                }
                crate::core::llm_types::StreamChunk::Done { .. } => break,
                _ => {}
            }
        }
        match provider_task.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if error.is_none() {
                    error = Some(e);
                }
            }
            Err(je) => {
                if error.is_none() {
                    error = Some(format!("Provider task panicked: {}", je));
                }
            }
        }
        if let Some(message) = error {
            warn!("github_ai_catch_up error: {}", message);
            let _ = handle.emit(&ai_error_event(&sid), AiErrorPayload { message });
            return;
        }
        if total == 0 {
            let _ = handle.emit(
                &ai_error_event(&sid),
                AiErrorPayload {
                    message: "The model returned an empty digest.".to_string(),
                },
            );
            return;
        }
        let _ = handle.emit(&ai_done_event(&sid), AiDonePayload {});
    });

    Ok(())
}

fn truncate_chars_v0_8_f(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let kept: String = s.chars().take(max_chars).collect();
        format!("{}…", kept)
    }
}

fn strip_json_fences(s: &str) -> &str {
    let t = s.trim();
    let after_open = if let Some(rest) = t.strip_prefix("```json") {
        rest.trim_start_matches('\n').trim_start()
    } else if let Some(rest) = t.strip_prefix("```") {
        rest.trim_start_matches('\n').trim_start()
    } else {
        t
    };
    if let Some(end) = after_open.rfind("```") {
        after_open[..end].trim_end()
    } else {
        after_open
    }
}

/// v0.8-F — AI issue triage. Synchronous (non-streaming): fetches each
/// issue's title+body and the repo's label set, runs one model turn,
/// parses the JSON-only response, returns it. Frontend slices selections
/// larger than `TRIAGE_BATCH_MAX` into multiple invocations.
#[tauri::command]
pub async fn github_ai_triage(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    issue_numbers: Vec<u32>,
) -> Result<Vec<TriageSuggestion>, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    if issue_numbers.is_empty() {
        return Ok(Vec::new());
    }
    if issue_numbers.len() > TRIAGE_BATCH_MAX {
        return Err(format!(
            "Too many issues in one batch ({}). Limit is {}.",
            issue_numbers.len(),
            TRIAGE_BATCH_MAX
        ));
    }

    let client = github_client_from_state(auth.inner()).await?;

    let mut issue_payloads: Vec<serde_json::Value> = Vec::with_capacity(issue_numbers.len());
    for n in &issue_numbers {
        let body = github_get_issue_with_client(&client, &GitHost::github(), &owner, &repo, *n).await?;
        let parsed: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse issue #{}: {}", n, e))?;
        let title = parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(no title)")
            .to_string();
        let body_text = parsed
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        issue_payloads.push(serde_json::json!({
            "number": *n,
            "title": title,
            // Cap bodies so a batch of 20 long issues doesn't blow past
            // the model's context. ~1k chars per issue is plenty.
            "body": truncate_chars_v0_8_f(&body_text, 1000),
        }));
    }

    let labels_url = format!(
        "https://api.github.com/repos/{}/{}/labels?per_page=100",
        owner, repo
    );
    let labels_body = match client.get(&labels_url).send().await {
        Ok(resp) => github_response_text(resp).await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    let label_names: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&labels_body)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|l| {
            l.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let issues_block = serde_json::to_string_pretty(&issue_payloads)
        .map_err(|e| format!("Failed to render issues block: {}", e))?;

    let (system_prompt, user_turn) =
        crate::core::github_ai_prompts::triage_prompt(&owner, &repo, &label_names, &issues_block);

    super::validate_input_size(&user_turn, super::MAX_INPUT_SIZE, "Triage user turn")?;

    let api_key = crate::commands::api_keys::load_api_key("anthropic")
        .map_err(|e| format!("AI triage needs an Anthropic API key. {}", e))?;

    info!(
        owner = %owner,
        repo = %repo,
        issue_count = issue_numbers.len(),
        label_count = label_names.len(),
        "github_ai_triage: running",
    );

    let provider = crate::core::llm_provider::get_provider(CATCH_UP_PROVIDER)
        .map_err(|e| format!("Provider unavailable: {}", e))?;

    let messages = vec![crate::core::llm_types::ChatMessage {
        role: crate::core::llm_types::ChatRole::User,
        content: crate::core::llm_types::MessageContent::text(user_turn),
    }];
    let request = crate::core::llm_types::LlmRequest {
        model: CATCH_UP_MODEL.to_string(),
        messages,
        tools: Vec::new(),
        system_prompt: Some(system_prompt),
        max_tokens: 4096,
        temperature: Some(0.1),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::core::llm_types::StreamChunk>(64);
    let provider_task =
        tokio::spawn(async move { provider.stream_chat(&api_key, request, tx).await });

    let mut buf = String::new();
    let mut stream_error: Option<String> = None;
    while let Some(chunk) = rx.recv().await {
        match chunk {
            crate::core::llm_types::StreamChunk::TextDelta { text } => {
                buf.push_str(&text);
            }
            crate::core::llm_types::StreamChunk::Error { message } => {
                stream_error = Some(message);
                break;
            }
            crate::core::llm_types::StreamChunk::Done { .. } => break,
            _ => {}
        }
    }
    match provider_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            if stream_error.is_none() {
                stream_error = Some(e);
            }
        }
        Err(je) => {
            if stream_error.is_none() {
                stream_error = Some(format!("Provider task panicked: {}", je));
            }
        }
    }
    if let Some(msg) = stream_error {
        return Err(msg);
    }
    if buf.trim().is_empty() {
        return Err("The model returned an empty triage response.".to_string());
    }

    let trimmed = buf.trim();
    let stripped = strip_json_fences(trimmed);

    let suggestions: Vec<TriageSuggestion> = serde_json::from_str(stripped).map_err(|e| {
        warn!(
            "github_ai_triage: JSON parse failed: {} — raw response (truncated): {}",
            e,
            truncate_chars_v0_8_f(stripped, 500)
        );
        format!("Triage response was not valid JSON: {}", e)
    })?;

    Ok(suggestions)
}

// === v0.8-A (re-shipped): PR lifecycle actions ============================
//
// Backs the `PRActionBar` component. Four commands map to GitHub's REST
// (merge / close / reopen) and GraphQL (draft toggle) surfaces.
//
//   - `github_merge_pr`            → PUT  /repos/{o}/{r}/pulls/{n}/merge
//   - `github_close_pr`            → PATCH /repos/{o}/{r}/pulls/{n}  {state:"closed"}
//   - `github_reopen_pr`           → PATCH /repos/{o}/{r}/pulls/{n}  {state:"open"}
//   - `github_convert_pr_to_draft` → REST  GET /pulls/{n} for node_id,
//                                    then GraphQL
//                                    convertPullRequestToDraft /
//                                    markPullRequestReadyForReview.
//
// All four route through `github_client_from_state`, so the same token-not-
// set error path the rest of the file uses applies here.

#[derive(serde::Serialize)]
pub struct GitHubMergeResult {
    pub sha: String,
    pub merged: bool,
    pub message: String,
}

fn validate_merge_method(method: &str) -> Result<&'static str, String> {
    match method {
        "merge" => Ok("merge"),
        "squash" => Ok("squash"),
        "rebase" => Ok("rebase"),
        other => Err(format!(
            "Invalid merge method '{}'. Expected merge | squash | rebase.",
            other
        )),
    }
}

/// `PUT /repos/{owner}/{repo}/pulls/{number}/merge` — merge an open PR.
#[tauri::command]
pub async fn github_merge_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    merge_method: String,
) -> Result<GitHubMergeResult, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let method = validate_merge_method(&merge_method)?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/merge",
        owner, repo, number
    );
    let resp = client
        .put(&url)
        .json(&serde_json::json!({ "merge_method": method }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse merge response: {}", e))?;
    Ok(GitHubMergeResult {
        sha: v
            .get("sha")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        merged: v.get("merged").and_then(|x| x.as_bool()).unwrap_or(false),
        message: v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

async fn patch_pr_state(
    auth: &GitHubAuthState,
    owner: &str,
    repo: &str,
    number: u32,
    state: &str,
) -> Result<String, String> {
    let client = github_client_from_state(auth).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, number
    );
    let resp = client
        .patch(&url)
        .json(&serde_json::json!({ "state": state }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    github_response_text(resp).await
}

/// `PATCH /repos/{owner}/{repo}/pulls/{number}` with `state=closed`.
#[tauri::command]
pub async fn github_close_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    patch_pr_state(auth.inner(), &owner, &repo, number, "closed").await
}

/// `PATCH /repos/{owner}/{repo}/pulls/{number}` with `state=open`.
#[tauri::command]
pub async fn github_reopen_pr(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
) -> Result<String, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    patch_pr_state(auth.inner(), &owner, &repo, number, "open").await
}

/// Toggle a PR between draft and ready-for-review. REST returns the PR's
/// GraphQL `node_id`; we then call `convertPullRequestToDraft` or
/// `markPullRequestReadyForReview` depending on the requested target state.
#[tauri::command]
pub async fn github_convert_pr_to_draft(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    number: u32,
    draft: bool,
) -> Result<bool, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;

    // Step 1: REST fetch to resolve the GraphQL node_id for this PR.
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value = serde_json::from_str(&pr_body)
        .map_err(|e| format!("Failed to parse PR response: {}", e))?;
    let node_id = pr_json
        .get("node_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "PR response missing node_id".to_string())?;

    // Step 2: GraphQL mutation. The two mutations have identical input shape
    // ({pullRequestId}) and both return {pullRequest{isDraft}}.
    let (mutation_name, response_key) = if draft {
        ("convertPullRequestToDraft", "convertPullRequestToDraft")
    } else {
        (
            "markPullRequestReadyForReview",
            "markPullRequestReadyForReview",
        )
    };
    let query = format!(
        "mutation($id: ID!) {{ {mutation}(input: {{pullRequestId: $id}}) {{ pullRequest {{ isDraft }} }} }}",
        mutation = mutation_name,
    );
    let gql_body = serde_json::json!({
        "query": query,
        "variables": { "id": node_id },
    });
    let gql_resp = client
        .post("https://api.github.com/graphql")
        .json(&gql_body)
        .send()
        .await
        .map_err(|e| format!("GraphQL request failed: {}", e))?;
    let gql_text = github_response_text(gql_resp).await?;
    let gql_json: serde_json::Value = serde_json::from_str(&gql_text)
        .map_err(|e| format!("Failed to parse GraphQL response: {}", e))?;

    // GraphQL surfaces errors in the response body rather than HTTP status.
    if let Some(errors) = gql_json.get("errors").and_then(|x| x.as_array()) {
        if !errors.is_empty() {
            let msg = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|x| x.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!("GitHub GraphQL error: {}", msg));
        }
    }

    let is_draft = gql_json
        .get("data")
        .and_then(|d| d.get(response_key))
        .and_then(|m| m.get("pullRequest"))
        .and_then(|p| p.get("isDraft"))
        .and_then(|x| x.as_bool())
        .unwrap_or(draft);

    Ok(is_draft)
}

// === v0.8-B: CI / check-run status (re-shipped) ===========================
//
// Aggregates the modern Checks API (`/commits/{sha}/check-runs`) with the
// legacy combined-status API (`/commits/{sha}/status`) into a single DTO.
// The frontend (`PrCheckPill.tsx`, `PRChecksTab.tsx`) consumes the camelCase
// shape declared in `src/types/github.ts`.

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCheckRunDto {
    pub id: i64,
    pub name: String,
    /// `queued | in_progress | completed`. Legacy combined-status entries
    /// are flattened into this shape: `pending → in_progress`, anything
    /// else → `completed`.
    pub status: String,
    /// `success | failure | neutral | cancelled | skipped | timed_out |
    /// action_required` — only present when `status == "completed"`.
    pub conclusion: Option<String>,
    pub html_url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub app_name: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrChecksDto {
    pub combined_state: String,
    pub total: i64,
    pub passing: i64,
    pub failing: i64,
    pub pending: i64,
    pub runs: Vec<GitHubCheckRunDto>,
}

/// Best-effort RFC3339 → unix-millis parser. Accepts the shape GitHub emits:
/// `YYYY-MM-DDTHH:MM:SSZ` and variants with fractional seconds / offsets.
/// Returns `None` on any parse problem so duration_ms gracefully degrades.
fn parse_rfc3339_to_ms(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    // days-from-civil (Hinnant): inverse of `format_rfc3339_utc` above.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m_adj = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m_adj + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000)
}

fn duration_ms_between(started: Option<&str>, completed: Option<&str>) -> Option<i64> {
    let s = parse_rfc3339_to_ms(started?)?;
    let c = parse_rfc3339_to_ms(completed?)?;
    let d = c - s;
    if d < 0 {
        None
    } else {
        Some(d)
    }
}

/// Roll up bucket counts into a single combined state. Mirrors the docstring
/// in PrCheckPill: failure-class wins, then pending-class, then success,
/// then neutral, then "none" for empty.
fn rollup_combined_state(total: i64, passing: i64, failing: i64, pending: i64) -> &'static str {
    if total == 0 {
        return "none";
    }
    if failing > 0 {
        return "failure";
    }
    if pending > 0 {
        return "pending";
    }
    if passing > 0 {
        return "success";
    }
    "neutral"
}

/// Aggregate Checks API + legacy combined-status for a PR's head commit.
#[tauri::command]
pub async fn github_get_pr_checks(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<GitHubPrChecksDto, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;

    // --- Step A: PR head SHA -------------------------------------------------
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value = serde_json::from_str(&pr_body)
        .map_err(|e| format!("Failed to parse PR response: {}", e))?;
    let head_sha = pr_json
        .get("head")
        .and_then(|h| h.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| "PR response missing head.sha".to_string())?
        .to_string();

    // --- Step B: check-runs --------------------------------------------------
    let runs_url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}/check-runs?per_page=100",
        owner, repo, head_sha
    );
    let runs_resp = client
        .get(&runs_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let runs_body = github_response_text(runs_resp).await?;
    let runs_json: serde_json::Value = serde_json::from_str(&runs_body)
        .map_err(|e| format!("Failed to parse check-runs response: {}", e))?;
    let empty_vec: Vec<serde_json::Value> = Vec::new();
    let raw_runs = runs_json
        .get("check_runs")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty_vec);

    let mut runs: Vec<GitHubCheckRunDto> = Vec::with_capacity(raw_runs.len());
    for r in raw_runs.iter() {
        let id = r.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let name = r
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = r
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed")
            .to_string();
        let conclusion = r
            .get("conclusion")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let html_url = r
            .get("html_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let started_at = r
            .get("started_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let completed_at = r
            .get("completed_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let app_name = r
            .get("app")
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let duration_ms = duration_ms_between(started_at.as_deref(), completed_at.as_deref());
        runs.push(GitHubCheckRunDto {
            id,
            name,
            status,
            conclusion,
            html_url,
            started_at,
            completed_at,
            duration_ms,
            app_name,
        });
    }

    // --- Step C: legacy combined status -------------------------------------
    let status_url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}/status",
        owner, repo, head_sha
    );
    let status_resp = client
        .get(&status_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status_body = github_response_text(status_resp).await?;
    let status_json: serde_json::Value = serde_json::from_str(&status_body)
        .map_err(|e| format!("Failed to parse status response: {}", e))?;
    let raw_statuses = status_json
        .get("statuses")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty_vec);

    for s in raw_statuses.iter() {
        let id = s.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
        let context = s
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or("status")
            .to_string();
        let state = s.get("state").and_then(|v| v.as_str()).unwrap_or("pending");
        // Flatten legacy state into the modern (status, conclusion) pair.
        let (mapped_status, mapped_conclusion): (&str, Option<&str>) = match state {
            "success" => ("completed", Some("success")),
            "failure" | "error" => ("completed", Some("failure")),
            "pending" => ("in_progress", None),
            other => ("completed", Some(other)),
        };
        let html_url = s
            .get("target_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let created_at = s
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let updated_at = s
            .get("updated_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let duration_ms = duration_ms_between(created_at.as_deref(), updated_at.as_deref());
        runs.push(GitHubCheckRunDto {
            id,
            name: context,
            status: mapped_status.to_string(),
            conclusion: mapped_conclusion.map(|s| s.to_string()),
            html_url,
            started_at: created_at,
            completed_at: updated_at,
            duration_ms,
            app_name: Some("legacy-status".to_string()),
        });
    }

    // --- Bucket + rollup -----------------------------------------------------
    let mut passing: i64 = 0;
    let mut failing: i64 = 0;
    let mut pending: i64 = 0;
    for r in runs.iter() {
        if r.status != "completed" {
            pending += 1;
            continue;
        }
        match r.conclusion.as_deref() {
            Some("success") => passing += 1,
            Some("failure") | Some("cancelled") | Some("timed_out") | Some("action_required") => {
                failing += 1
            }
            _ => {}
        }
    }
    let total = runs.len() as i64;
    let combined_state = rollup_combined_state(total, passing, failing, pending).to_string();

    Ok(GitHubPrChecksDto {
        combined_state,
        total,
        passing,
        failing,
        pending,
        runs,
    })
}

// === v0.8-13: PR reviews surface (read-only) ===============================
//
// Two commands fetch the existing review history for a PR so the frontend
// can render an overview of formal reviews plus per-file inline comment
// threads. Adding new comments is out of scope for v0.8 (v1.1).
//
// Both commands return camelCase DTOs (matching the rest of the v0.8
// surface) so the React side can `invoke<...>()` directly.

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhReviewUser {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub id: u64,
    pub user: GhReviewUser,
    pub body: String,
    /// `APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING`
    pub state: String,
    pub submitted_at: Option<String>,
    pub html_url: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewComment {
    pub id: u64,
    /// The review this comment belongs to (when posted as part of a formal
    /// review). Top-level inline comments may omit this.
    pub pull_request_review_id: Option<u64>,
    /// When this comment is a reply to another comment, the parent's id.
    pub in_reply_to_id: Option<u64>,
    pub user: GhReviewUser,
    pub body: String,
    pub path: String,
    /// Line number on the diff (HEAD side). May be null for outdated
    /// comments on lines that no longer exist.
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    /// `LEFT | RIGHT` — which side of the diff the comment is anchored to.
    pub side: Option<String>,
    pub created_at: String,
    pub html_url: String,
}

fn parse_review_user(v: Option<&serde_json::Value>) -> GhReviewUser {
    GhReviewUser {
        login: v
            .and_then(|u| u.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        avatar_url: v
            .and_then(|u| u.get("avatar_url"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn parse_pr_review(v: &serde_json::Value) -> PullRequestReview {
    PullRequestReview {
        id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        user: parse_review_user(v.get("user")),
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        state: v
            .get("state")
            .and_then(|x| x.as_str())
            .unwrap_or("COMMENTED")
            .to_string(),
        submitted_at: v
            .get("submitted_at")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        html_url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn parse_pr_review_comment(v: &serde_json::Value) -> PullRequestReviewComment {
    PullRequestReviewComment {
        id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
        pull_request_review_id: v.get("pull_request_review_id").and_then(|x| x.as_u64()),
        in_reply_to_id: v.get("in_reply_to_id").and_then(|x| x.as_u64()),
        user: parse_review_user(v.get("user")),
        body: v
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        path: v
            .get("path")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        line: v.get("line").and_then(|x| x.as_u64()).map(|n| n as u32),
        original_line: v
            .get("original_line")
            .and_then(|x| x.as_u64())
            .map(|n| n as u32),
        side: v
            .get("side")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        created_at: v
            .get("created_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        html_url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/// `GET /repos/{owner}/{repo}/pulls/{pr_number}/reviews` — list formal PR
/// reviews (Approved / Changes Requested / Commented / Dismissed /
/// Pending).
#[tauri::command]
pub async fn github_list_pr_reviews(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<Vec<PullRequestReview>, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/reviews?per_page=100",
        owner, repo, pr_number
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse PR reviews: {}", e))?;
    Ok(arr.iter().map(parse_pr_review).collect())
}

/// `GET /repos/{owner}/{repo}/pulls/{pr_number}/comments` — list inline
/// review comments (line-anchored). These are the threaded conversations
/// the frontend groups by `path` and then chains by `in_reply_to_id`.
#[tauri::command]
pub async fn github_list_pr_review_comments(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
) -> Result<Vec<PullRequestReviewComment>, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/comments?per_page=100",
        owner, repo, pr_number
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse PR review comments: {}", e))?;
    Ok(arr.iter().map(parse_pr_review_comment).collect())
}

/// `POST /repos/{owner}/{repo}/pulls/{n}/comments` — author a new inline review
/// comment anchored to a line of the diff. `side` is `RIGHT` (new file) or
/// `LEFT` (old file); `line` is the file line number on that side. The PR head
/// sha needed for `commit_id` is resolved here, so the caller only supplies the
/// anchor.
#[tauri::command]
pub async fn github_post_pr_review_comment(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
    path: String,
    line: u32,
    side: String,
    body: String,
) -> Result<PullRequestReviewComment, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Comment body cannot be empty".to_string());
    }
    // GitHub only accepts LEFT/RIGHT; default anything else to RIGHT (new file).
    let side_norm = if side.eq_ignore_ascii_case("LEFT") {
        "LEFT"
    } else {
        "RIGHT"
    };
    let client = github_client_from_state(auth.inner()).await?;

    // Resolve the PR head sha for `commit_id` (mirrors github_get_pr_diff).
    let pr_url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}",
        owner, repo, pr_number
    );
    let pr_resp = client
        .get(&pr_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let pr_body = github_response_text(pr_resp).await?;
    let pr_json: serde_json::Value = serde_json::from_str(&pr_body)
        .map_err(|e| format!("Failed to parse PR response: {}", e))?;
    let head_sha = pr_json
        .get("head")
        .and_then(|h| h.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| "PR response missing head.sha".to_string())?
        .to_string();

    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/comments",
        owner, repo, pr_number
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "body": trimmed,
            "commit_id": head_sha,
            "path": path,
            "line": line,
            "side": side_norm,
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse comment: {}", e))?;
    Ok(parse_pr_review_comment(&v))
}

/// `POST /repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies` — reply
/// to an existing inline review comment thread.
#[tauri::command]
pub async fn github_reply_to_pr_review_comment(
    auth: State<'_, GitHubAuthState>,
    owner: String,
    repo: String,
    pr_number: u32,
    comment_id: u64,
    body: String,
) -> Result<PullRequestReviewComment, String> {
    validate_github_name(&owner, "owner")?;
    validate_github_name(&repo, "repo")?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Comment body cannot be empty".to_string());
    }
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/pulls/{}/comments/{}/replies",
        owner, repo, pr_number, comment_id
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "body": trimmed }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let text = github_response_text(resp).await?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse comment: {}", e))?;
    Ok(parse_pr_review_comment(&v))
}

// === Notifications inbox ===================================================
//
// The GitHub notifications API returns the authenticated user's notification
// threads across all repos. Each thread has a `subject` (the Issue/PR/etc.
// it concerns) whose `url` is an *API* url; we derive a browser `html_url`
// from it so the frontend can open the subject in the system browser.

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubNotification {
    /// Thread id (used to mark the thread read).
    pub id: String,
    pub unread: bool,
    /// Why this notification was received (e.g. `mention`, `review_requested`,
    /// `assign`, `subscribed`, `state_change`).
    pub reason: String,
    pub updated_at: String,
    pub title: String,
    /// `Issue | PullRequest | Commit | Release | Discussion | ...`
    pub subject_type: String,
    /// Browser url for the subject, derived from the API `subject.url`.
    /// Falls back to the repository url when no subject url is present.
    pub html_url: String,
    pub repository: String,
}

/// Convert a GitHub *API* url into its browser (`html_url`) equivalent.
///
/// The notifications API only exposes API urls on `subject.url` (e.g.
/// `https://api.github.com/repos/o/r/pulls/12`). We rewrite the host and the
/// `pulls` → `pull` path segment so the link opens in a browser. Unknown
/// shapes fall back to the repository html url.
fn notification_subject_html_url(
    subject_type: &str,
    subject_url: Option<&str>,
    repo_full_name: &str,
) -> String {
    let repo_html = format!("https://github.com/{}", repo_full_name);
    // Releases resolve by tag in the browser, not by the numeric API id, so the
    // notification alone can't yield a canonical release page — send the user to
    // the repo's releases list instead of a 404-ing `/releases/{id}` URL.
    if subject_type.eq_ignore_ascii_case("Release") {
        return format!("{}/releases", repo_html);
    }
    let Some(url) = subject_url else {
        return repo_html;
    };
    let Some(rest) = url.strip_prefix("https://api.github.com/repos/") else {
        return repo_html;
    };
    // `rest` looks like "o/r/pulls/12", "o/r/issues/5", or "o/r/commits/{sha}".
    // Map the API path segments to their browser equivalents (issues map 1:1;
    // pulls→pull, commits→commit are the two that differ). Unknown shapes fall
    // through to the rewritten path.
    let html = rest
        .replacen("/pulls/", "/pull/", 1)
        .replacen("/commits/", "/commit/", 1);
    format!("https://github.com/{}", html)
}

fn parse_notification(v: &serde_json::Value) -> GithubNotification {
    let repository = v
        .get("repository")
        .and_then(|r| r.get("full_name"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let subject = v.get("subject");
    let subject_url = subject
        .and_then(|s| s.get("url"))
        .and_then(|x| x.as_str());
    let subject_type = subject
        .and_then(|s| s.get("type"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    GithubNotification {
        id: v
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        unread: v.get("unread").and_then(|x| x.as_bool()).unwrap_or(false),
        reason: v
            .get("reason")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: v
            .get("updated_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        title: subject
            .and_then(|s| s.get("title"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        subject_type: subject_type.to_string(),
        html_url: notification_subject_html_url(subject_type, subject_url, &repository),
        repository,
    }
}

/// `GET /notifications` — list the authenticated user's notification threads.
/// When `all` is false (or omitted) only unread threads are returned.
#[tauri::command]
pub async fn github_list_notifications(
    auth: State<'_, GitHubAuthState>,
    all: Option<bool>,
) -> Result<Vec<GithubNotification>, String> {
    let client = github_client_from_state(auth.inner()).await?;
    let all = all.unwrap_or(false);
    let url = format!(
        "https://api.github.com/notifications?all={}&per_page=50",
        all
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let body = github_response_text(resp).await?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse notifications: {}", e))?;
    Ok(arr.iter().map(parse_notification).collect())
}

/// `PATCH /notifications/threads/{thread_id}` — mark a single notification
/// thread as read. Returns `Ok(())` on success.
#[tauri::command]
pub async fn github_mark_notification_read(
    auth: State<'_, GitHubAuthState>,
    thread_id: String,
) -> Result<(), String> {
    validate_github_name(&thread_id, "thread_id")?;
    let client = github_client_from_state(auth.inner()).await?;
    let url = format!(
        "https://api.github.com/notifications/threads/{}",
        thread_id
    );
    let resp = client
        .patch(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    // On success GitHub returns 205 (reset content) with an empty body, so we
    // check the status directly rather than reading a JSON body.
    if !resp.status().is_success() {
        let status = resp.status();
        warn!(
            "GitHub API error {}: {}",
            status,
            resp.text().await.unwrap_or_default()
        );
        return Err(sanitize_github_error(status));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_github_name_accepts_valid() {
        assert!(validate_github_name("valid-repo", "repo").is_ok());
    }

    #[test]
    fn validate_github_name_rejects_empty() {
        assert!(validate_github_name("", "repo").is_err());
    }

    #[test]
    fn validate_github_name_rejects_too_long() {
        let long = "a".repeat(101);
        assert!(validate_github_name(&long, "repo").is_err());
    }

    #[test]
    fn validate_github_name_rejects_invalid_chars() {
        assert!(validate_github_name("repo;drop", "repo").is_err());
    }

    #[test]
    fn strip_json_fences_handles_plain() {
        assert_eq!(strip_json_fences("[]"), "[]");
        assert_eq!(strip_json_fences("  [1,2]  "), "[1,2]");
    }

    #[test]
    fn strip_json_fences_handles_fenced() {
        assert_eq!(strip_json_fences("```json\n[1,2]\n```"), "[1,2]");
        assert_eq!(strip_json_fences("```\n[1,2]\n```"), "[1,2]");
    }

    #[test]
    fn truncate_chars_v0_8_f_respects_char_count() {
        assert_eq!(truncate_chars_v0_8_f("hello", 10), "hello");
        assert_eq!(truncate_chars_v0_8_f("helloworld", 5), "hello…");
    }

    #[test]
    fn format_rfc3339_utc_known_value() {
        let ms: i64 = 1_705_322_096_000;
        assert_eq!(format_rfc3339_utc(ms), "2024-01-15T12:34:56Z");
    }

    #[test]
    fn default_since_iso_returns_valid_rfc3339() {
        let s = default_since_iso();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
