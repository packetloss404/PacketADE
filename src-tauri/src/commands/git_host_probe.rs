//! Guided git-host setup: a **non-persisting** credential probe.
//!
//! The existing connect paths (`github_set_token`, `git_host_add_gitea`) write
//! the token to the OS keyring *first* and only then discover whether it works.
//! The setup wizard needs the opposite order — validate, then save — so that a
//! typo'd instance URL or a token missing `repo` never reaches the keyring and
//! never leaves a half-configured connection behind.
//!
//! This command is deliberately **host-agnostic**: every host-specific detail
//! (API prefix, identity path, auth header scheme, the header that reports
//! granted scopes) arrives in the request from the frontend's per-host
//! descriptor. Adding another forge — GitLab, Bitbucket — is a new descriptor
//! on the TypeScript side with no arm to add here.
//!
//! Security contract:
//!  * The token is used for exactly one outbound request and then dropped. It
//!    is never persisted, never cached in app state, never logged.
//!  * The request only ever goes to the user-supplied origin: the path is built
//!    from the descriptor, the scheme is restricted to http/https, and a URL
//!    carrying embedded credentials is rejected outright.
//!  * Nothing derived from the response body reaches the user verbatim; the
//!    `detail` string is built from the status/transport class only, and is
//!    scrubbed of the token as a belt-and-braces last step.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::warn;

/// Long enough for a slow on-prem instance, short enough that a black-holed
/// address doesn't leave the wizard spinning.
const PROBE_TIMEOUT_SECS: u64 = 15;

/// Nothing legitimate is anywhere near this long; the cap keeps a pathological
/// paste out of an HTTP header.
const MAX_TOKEN_LEN: usize = 4096;

/// Everything host-specific about a probe *except* the origin and the
/// credential — i.e. the frontend descriptor's `probe` block on its own.
///
/// Split out from [`GitHostProbeRequest`] so a caller inside Rust can pair a
/// descriptor with an origin it already trusts. Token rotation
/// (`git_host_update_connection`) does exactly that: it takes the spec from the
/// frontend but the `base_url` from the *stored* connection, so a rotation can
/// never be talked into shipping the new credential at an origin the user did
/// not already configure.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostProbeSpec {
    #[serde(default)]
    pub api_prefix: String,
    pub identity_path: String,
    pub auth_scheme: String,
    #[serde(default)]
    pub accept: Option<String>,
    #[serde(default)]
    pub scope_header: Option<String>,
    #[serde(default)]
    pub scope_path: Option<String>,
    #[serde(default)]
    pub scope_field: Option<String>,
    #[serde(default)]
    pub login_fields: Vec<String>,
}

impl GitHostProbeSpec {
    /// Pair this descriptor with an origin and a credential.
    pub fn into_request(self, base_url: String, token: String) -> GitHostProbeRequest {
        GitHostProbeRequest {
            base_url,
            api_prefix: self.api_prefix,
            identity_path: self.identity_path,
            auth_scheme: self.auth_scheme,
            accept: self.accept,
            scope_header: self.scope_header,
            scope_path: self.scope_path,
            scope_field: self.scope_field,
            login_fields: self.login_fields,
            token,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostProbeRequest {
    /// Normalized origin (may include a sub-path, e.g. `https://ex.com/gitea`).
    /// Must NOT include the API prefix — that is supplied separately.
    pub base_url: String,
    /// e.g. `/api/v1` for Gitea, `/api/v4` for GitLab, empty for api.github.com.
    #[serde(default)]
    pub api_prefix: String,
    /// Endpoint that returns the authenticated user, e.g. `/user`.
    pub identity_path: String,
    /// `bearer` | `token` | `private-token`.
    pub auth_scheme: String,
    /// Optional `Accept` header (GitHub wants `application/vnd.github+json`).
    #[serde(default)]
    pub accept: Option<String>,
    /// Response header that lists granted scopes, when the host reports them
    /// (`x-oauth-scopes` on GitHub). Absent => the host doesn't tell us.
    #[serde(default)]
    pub scope_header: Option<String>,
    /// Endpoint that reports the credential's own scopes, for hosts that expose
    /// them as a *resource* rather than a response header — GitLab serves
    /// `/personal_access_tokens/self`. Consulted only when `scope_header` did
    /// not already answer, and only after identity succeeded.
    #[serde(default)]
    pub scope_path: Option<String>,
    /// JSON field on the `scope_path` response holding the scope array
    /// (`scopes` on GitLab). Defaults to `scopes`.
    #[serde(default)]
    pub scope_field: Option<String>,
    /// Candidate JSON fields holding the account name, in priority order.
    #[serde(default)]
    pub login_fields: Vec<String>,
    /// The credential under test. Used once, never stored.
    pub token: String,
}

/// The precise failure classes the wizard renders. "Something went wrong" is
/// not one of them by design — every arm here maps to distinct remedial advice.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum GitHostProbeOutcome {
    /// Reachable, credential accepted, identity resolved.
    Ok,
    /// Reached the API; it rejected the credential (401).
    InvalidToken,
    /// Credential recognised but not permitted (403 that isn't a rate limit) —
    /// SSO not authorized, IP allowlist, disabled account.
    Forbidden,
    /// The host asked us to back off (429, or an exhausted rate-limit budget).
    RateLimited,
    /// Something answered, but it is not this host's API — wrong URL, a reverse
    /// proxy, a captive portal, or a 404 where the API should be.
    NotAHost,
    /// Nothing answered: DNS failure, connection refused, timeout.
    Unreachable,
    /// Answered, but the TLS handshake could not be verified (very common on a
    /// self-hosted instance with a private CA or a self-signed certificate).
    TlsError,
    /// The host is up but broken (5xx).
    ServerError,
    /// Reached, understood nothing. Status is included so the user can report it.
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHostProbeResult {
    pub outcome: GitHostProbeOutcome,
    pub status: Option<u16>,
    pub login: Option<String>,
    pub avatar_url: Option<String>,
    /// Granted scopes when the host reports them; `None` means "host didn't
    /// say" — which is NOT the same as "no scopes", and the UI must not
    /// pretend otherwise.
    pub scopes: Option<Vec<String>>,
    /// Short, host-derived explanation. Never contains the token or a raw body.
    pub detail: Option<String>,
    /// The URL actually contacted, so the user can see what we resolved to.
    pub endpoint: String,
}

impl GitHostProbeResult {
    fn failure(outcome: GitHostProbeOutcome, endpoint: String, detail: impl Into<String>) -> Self {
        Self {
            outcome,
            status: None,
            login: None,
            avatar_url: None,
            scopes: None,
            detail: Some(detail.into()),
            endpoint,
        }
    }
}

/// Build the identity URL from the user's origin plus the descriptor's paths.
///
/// Rejects anything that could redirect the credential somewhere the user did
/// not type: a non-HTTP scheme, embedded `user:pass@`, or a path fragment that
/// tries to escape (absolute URL, protocol-relative, `..`).
fn build_endpoint(base_url: &str, api_prefix: &str, identity_path: &str) -> Result<String, String> {
    let base = reqwest::Url::parse(base_url.trim())
        .map_err(|_| "Instance URL is not a valid URL.".to_string())?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("Instance URL must use http:// or https://.".to_string());
    }
    if base.host_str().is_none() {
        return Err("Instance URL has no host.".to_string());
    }
    if !base.username().is_empty() || base.password().is_some() {
        return Err("Remove the username/password from the instance URL.".to_string());
    }

    for part in [api_prefix, identity_path] {
        if part.is_empty() {
            continue;
        }
        if !part.starts_with('/') || part.starts_with("//") {
            return Err("Invalid API path in host descriptor.".to_string());
        }
        if part.contains("://") || part.split('/').any(|seg| seg == "..") {
            return Err("Invalid API path in host descriptor.".to_string());
        }
    }

    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    let path = format!(
        "{}{}{}",
        base.path().trim_end_matches('/'),
        api_prefix.trim_end_matches('/'),
        identity_path
    );
    url.set_path(&path);
    Ok(url.to_string())
}

/// Map a transport-level failure to a class the user can act on.
fn classify_transport_error(err: &reqwest::Error) -> (GitHostProbeOutcome, String) {
    if err.is_timeout() {
        return (
            GitHostProbeOutcome::Unreachable,
            format!("No response within {}s.", PROBE_TIMEOUT_SECS),
        );
    }
    // The TLS class is worth separating: on a self-hosted instance it is almost
    // always a private CA, which is a completely different fix from "host down".
    let chain = error_chain(err).to_lowercase();
    if chain.contains("certificate")
        || chain.contains("tls")
        || chain.contains("ssl")
        || chain.contains("handshake")
    {
        return (
            GitHostProbeOutcome::TlsError,
            "The TLS certificate could not be verified.".to_string(),
        );
    }
    if chain.contains("dns") || chain.contains("name or service") || chain.contains("resolve") {
        return (
            GitHostProbeOutcome::Unreachable,
            "The host name could not be resolved.".to_string(),
        );
    }
    if chain.contains("refused") {
        return (
            GitHostProbeOutcome::Unreachable,
            "The connection was refused.".to_string(),
        );
    }
    (
        GitHostProbeOutcome::Unreachable,
        "The host could not be contacted.".to_string(),
    )
}

/// Flatten a reqwest error and its sources. `Display` alone frequently hides
/// the interesting cause (the TLS layer) one level down.
fn error_chain(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(e) = source {
        out.push_str("; ");
        out.push_str(&e.to_string());
        source = std::error::Error::source(e);
    }
    out
}

/// Split a comma-separated scope header (`repo, read:org`) into scope names.
/// Ask a host that reports scopes as a *resource* for this credential's scopes.
///
/// GitLab has no `x-oauth-scopes` header; it serves `/personal_access_tokens/self`
/// returning `{"scopes": ["api", "read_user"], ...}`.
///
/// Deliberately best-effort. A token can be perfectly valid for the API and
/// still be unable to read its own metadata — older GitLab versions lack the
/// endpoint entirely, and a token without `read_api` is refused there. Any
/// failure returns `None`, which the caller reports as "the host didn't say"
/// rather than "no scopes". Failing the whole probe here would reject working
/// credentials over a courtesy request.
async fn fetch_scopes_from_resource(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    field: &str,
) -> Option<Vec<String>> {
    let response = client.get(endpoint).headers(headers).send().await.ok()?;
    if !response.status().is_success() {
        warn!(
            "git-host scope probe answered HTTP {} — reporting scopes as unknown",
            response.status().as_u16()
        );
        return None;
    }
    scopes_from_body(&response.text().await.ok()?, field)
}

/// Pull the scope array out of a scope-resource body. Split out from the request
/// so the parsing is testable without a server.
///
/// An empty array is treated as *unknown*, not as "no scopes": a malformed or
/// unexpected body produces the same empty vector, and the caller only warns on
/// unknown while it hard-blocks on a scope it believes is missing. Guessing
/// wrong in that direction refuses a working token.
fn scopes_from_body(body: &str, field: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let scopes: Vec<String> = value
        .get(field)?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    if scopes.is_empty() {
        None
    } else {
        Some(scopes)
    }
}

fn parse_scopes(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Last-resort guarantee that no path out of this module can echo the token.
fn scrub(detail: Option<String>, token: &str) -> Option<String> {
    let trimmed = token.trim();
    detail.map(|d| {
        if !trimmed.is_empty() && d.contains(trimmed) {
            d.replace(trimmed, "[redacted]")
        } else {
            d
        }
    })
}

#[tauri::command]
pub async fn git_host_probe_credential(
    request: GitHostProbeRequest,
) -> Result<GitHostProbeResult, String> {
    probe_credential(request).await
}

/// The probe itself, callable from Rust.
///
/// `git_host_probe_credential` is a thin `#[tauri::command]` wrapper over this
/// so that in-process callers — token rotation, above all — validate through
/// exactly the same code path the wizard does, rather than growing a second
/// validation implementation that could drift from this one.
pub async fn probe_credential(
    request: GitHostProbeRequest,
) -> Result<GitHostProbeResult, String> {
    let token = request.token.trim().to_string();
    if token.is_empty() {
        return Err("Token cannot be empty.".to_string());
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err("Token is implausibly long — check what you pasted.".to_string());
    }
    // A newline in a header value is a request-splitting primitive; reject
    // without repeating the offending value back.
    if token.chars().any(|c| c.is_control()) {
        return Err("Token contains characters that cannot be sent in an HTTP header. Re-copy it without line breaks.".to_string());
    }

    let endpoint = build_endpoint(&request.base_url, &request.api_prefix, &request.identity_path)?;

    let mut headers = reqwest::header::HeaderMap::new();
    let (header_name, header_value) = match request.auth_scheme.as_str() {
        "bearer" => ("authorization", format!("Bearer {}", token)),
        "token" => ("authorization", format!("token {}", token)),
        "private-token" => ("private-token", token.clone()),
        other => return Err(format!("Unsupported auth scheme '{}'.", other)),
    };
    let name = reqwest::header::HeaderName::from_bytes(header_name.as_bytes())
        .map_err(|_| "Invalid auth header name in host descriptor.".to_string())?;
    let mut value = reqwest::header::HeaderValue::from_str(&header_value)
        .map_err(|_| "Token cannot be encoded as an HTTP header value.".to_string())?;
    value.set_sensitive(true);
    headers.insert(name, value);
    if let Some(accept) = request.accept.as_deref() {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(accept) {
            headers.insert(reqwest::header::ACCEPT, v);
        }
    }
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(crate::core::brand::USER_AGENT),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let scope_headers = headers.clone();
    let response = match client.get(&endpoint).headers(headers).send().await {
        Ok(r) => r,
        Err(e) => {
            let (outcome, detail) = classify_transport_error(&e);
            warn!("git-host probe transport failure ({:?})", outcome);
            return Ok(GitHostProbeResult::failure(
                outcome,
                endpoint,
                scrub(Some(detail), &token).unwrap_or_default(),
            ));
        }
    };

    let status = response.status();
    let scopes = request.scope_header.as_deref().and_then(|h| {
        response
            .headers()
            .get(h)
            .and_then(|v| v.to_str().ok())
            .map(parse_scopes)
    });
    let rate_limit_exhausted = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim() == "0")
        .unwrap_or(false);

    // Deliberately not surfaced to the user — a failure body can carry private
    // repo names and, on a misconfigured proxy, echoed request material.
    warn!(
        "git-host probe answered with HTTP {} from {}",
        status.as_u16(),
        endpoint
    );

    if status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();
        let login = parsed.as_ref().and_then(|v| {
            request
                .login_fields
                .iter()
                .find_map(|field| v.get(field).and_then(|f| f.as_str()).map(str::to_string))
        });
        let Some(login) = login else {
            return Ok(GitHostProbeResult {
                status: Some(status.as_u16()),
                ..GitHostProbeResult::failure(
                    GitHostProbeOutcome::NotAHost,
                    endpoint,
                    "That address answered, but not with an account — it does not look like this host's API.",
                )
            });
        };
        let avatar_url = parsed
            .as_ref()
            .and_then(|v| v.get("avatar_url"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        // Identity is established. Hosts that expose scopes as a resource rather
        // than a header get one extra request now — never before, so a host that
        // would have rejected the credential is never asked twice.
        let mut scopes = scopes;
        if scopes.is_none() {
            if let Some(scope_path) = request.scope_path.as_deref() {
                if let Ok(scope_endpoint) =
                    build_endpoint(&request.base_url, &request.api_prefix, scope_path)
                {
                    let field = request.scope_field.as_deref().unwrap_or("scopes");
                    scopes =
                        fetch_scopes_from_resource(&client, &scope_endpoint, scope_headers, field)
                            .await;
                }
            }
        }

        return Ok(GitHostProbeResult {
            outcome: GitHostProbeOutcome::Ok,
            status: Some(status.as_u16()),
            login: Some(login),
            avatar_url,
            scopes,
            detail: None,
            endpoint,
        });
    }

    let (outcome, detail) = match status.as_u16() {
        401 => (
            GitHostProbeOutcome::InvalidToken,
            "The host rejected this token.".to_string(),
        ),
        403 if rate_limit_exhausted => (
            GitHostProbeOutcome::RateLimited,
            "The rate limit for this token is exhausted.".to_string(),
        ),
        403 => (
            GitHostProbeOutcome::Forbidden,
            "The token was recognised but is not permitted to read this account — check SSO authorization, IP allow-lists, or whether the token was revoked.".to_string(),
        ),
        404 => (
            GitHostProbeOutcome::NotAHost,
            "No API answered at that address.".to_string(),
        ),
        429 => (
            GitHostProbeOutcome::RateLimited,
            "The host asked us to slow down — try again shortly.".to_string(),
        ),
        code if (500..=599).contains(&code) => (
            GitHostProbeOutcome::ServerError,
            "The host returned a server error.".to_string(),
        ),
        code => (
            GitHostProbeOutcome::Unknown,
            format!("The host answered with an unexpected HTTP {}.", code),
        ),
    };

    Ok(GitHostProbeResult {
        outcome,
        status: Some(status.as_u16()),
        login: None,
        avatar_url: None,
        scopes,
        detail: scrub(Some(detail), &token),
        endpoint,
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn scopes_from_body_reads_a_gitlab_token_resource() {
        // Shape of GitLab's /personal_access_tokens/self response.
        let body = r#"{"id":1,"name":"pb","scopes":["api","read_user"],"active":true}"#;
        assert_eq!(
            scopes_from_body(body, "scopes"),
            Some(vec!["api".to_string(), "read_user".to_string()])
        );
    }

    #[test]
    fn scopes_from_body_treats_unusable_answers_as_unknown() {
        // Each of these must be "the host didn't say", never "no scopes" —
        // the caller warns on unknown but blocks on a scope it thinks is absent.
        assert_eq!(scopes_from_body("not json", "scopes"), None);
        assert_eq!(scopes_from_body(r#"{"scopes":[]}"#, "scopes"), None);
        assert_eq!(scopes_from_body(r#"{"other":["api"]}"#, "scopes"), None);
        assert_eq!(scopes_from_body(r#"{"scopes":"api"}"#, "scopes"), None);
        assert_eq!(scopes_from_body(r#"{"scopes":[1,2]}"#, "scopes"), None);
    }

    #[test]
    fn scope_endpoint_is_built_from_the_same_prefix_as_identity() {
        // A self-hosted GitLab under a sub-path must keep it on both requests.
        assert_eq!(
            build_endpoint("https://git.example.com/gl", "/api/v4", "/personal_access_tokens/self")
                .unwrap(),
            "https://git.example.com/gl/api/v4/personal_access_tokens/self"
        );
    }
    use super::*;

    #[test]
    fn endpoint_joins_origin_prefix_and_path() {
        assert_eq!(
            build_endpoint("https://git.example.com", "/api/v1", "/user").unwrap(),
            "https://git.example.com/api/v1/user"
        );
    }

    #[test]
    fn endpoint_preserves_a_subpath_install() {
        assert_eq!(
            build_endpoint("https://example.com/gitea/", "/api/v1", "/user").unwrap(),
            "https://example.com/gitea/api/v1/user"
        );
    }

    #[test]
    fn endpoint_supports_an_empty_prefix() {
        assert_eq!(
            build_endpoint("https://api.github.com", "", "/user").unwrap(),
            "https://api.github.com/user"
        );
    }

    #[test]
    fn endpoint_rejects_non_http_schemes() {
        assert!(build_endpoint("file:///etc/passwd", "", "/user").is_err());
        assert!(build_endpoint("ftp://example.com", "", "/user").is_err());
    }

    #[test]
    fn endpoint_rejects_embedded_credentials() {
        // A URL of this shape would ship a second secret to the host.
        assert!(build_endpoint("https://user:pw@example.com", "/api/v1", "/user").is_err());
    }

    #[test]
    fn endpoint_rejects_escaping_descriptor_paths() {
        assert!(build_endpoint("https://example.com", "//evil.example", "/user").is_err());
        assert!(build_endpoint("https://example.com", "/api/../..", "/user").is_err());
        assert!(build_endpoint("https://example.com", "https://evil.example", "/user").is_err());
    }

    #[test]
    fn scopes_split_on_commas_and_drop_blanks() {
        assert_eq!(parse_scopes("repo, read:org ,"), vec!["repo", "read:org"]);
        assert!(parse_scopes("   ").is_empty());
    }

    #[test]
    fn scrub_removes_the_token_from_any_detail() {
        let scrubbed = scrub(Some("failed for ghp_secret".to_string()), "ghp_secret");
        assert_eq!(scrubbed.as_deref(), Some("failed for [redacted]"));
    }
}
