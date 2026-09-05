//! Streamable HTTP transport wiring + loopback/bearer auth for the MCP server.
//!
//! Defence in depth for a localhost service:
//!   1. Bind `127.0.0.1` only — never `0.0.0.0` (no LAN exposure).
//!   2. `rmcp` `allowed_hosts` — rejects mismatched `Host` (DNS-rebinding guard).
//!   3. `Origin` check — reject any *present* non-loopback Origin (a browser
//!      page can't reach us even if it resolves a name to 127.0.0.1). Absent
//!      Origin is allowed so CLI clients (which omit it) still work.
//!   4. Bearer token — the actual access control; other local processes can't
//!      call us without the token shown in the UI.

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::Next,
    response::Response,
    Router,
};
use tokio_util::sync::CancellationToken;

use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

use super::{McpAuditLog, PacketBenchMcp};

/// Bind `127.0.0.1:<port>` (0 → OS-assigned), spawn the server on the ambient
/// tokio runtime, and return the actually-bound port. The server shuts down
/// gracefully when `cancel` fires.
pub async fn serve(
    port: u16,
    token: String,
    cancel: CancellationToken,
    audit: Arc<McpAuditLog>,
    allow_writes: bool,
    allowed_tools: Option<Arc<HashSet<String>>>,
) -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let bound_port = listener.local_addr()?.port();
    let router = build_router(
        token,
        bound_port,
        cancel.child_token(),
        audit,
        allow_writes,
        allowed_tools,
    );

    let shutdown = cancel.child_token();
    tauri::async_runtime::spawn(async move {
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await;
        if let Err(e) = served {
            tracing::warn!(error = %e, "MCP server exited with error");
        }
    });

    Ok(bound_port)
}

/// Build the axum router: the `rmcp` Streamable HTTP service at `/mcp`, wrapped
/// in the loopback/bearer auth layer. `service_ct` cancels in-flight MCP
/// sessions on shutdown.
pub fn build_router(
    token: String,
    port: u16,
    service_ct: CancellationToken,
    audit: Arc<McpAuditLog>,
    allow_writes: bool,
    allowed_tools: Option<Arc<HashSet<String>>>,
) -> Router {
    let service = StreamableHttpService::new(
        // The factory runs per MCP session, so the allowlist is applied to
        // every session this run serves — not just the first.
        move || {
            Ok(PacketBenchMcp::new(
                audit.clone(),
                allow_writes,
                allowed_tools.as_deref(),
            ))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_cancellation_token(service_ct)
            .with_allowed_hosts(vec![
                format!("127.0.0.1:{port}"),
                format!("localhost:{port}"),
            ]),
    );

    let guard = Arc::new(AuthGuard { token });
    // `/health` sits OUTSIDE the bearer layer (a liveness probe must not need
    // the secret) but INSIDE the Origin layer, so a web page on a real origin
    // still cannot fingerprint the running app. It reveals nothing a local
    // process could not learn from the process list.
    let protected = Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(guard, bearer_layer));
    Router::new()
        .route("/health", axum::routing::get(health))
        .merge(protected)
        .layer(axum::middleware::from_fn(origin_layer))
}

/// Liveness probe for the dark period: `curl http://127.0.0.1:<port>/health`.
async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "ok": true,
        "app": crate::core::brand::APP_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "service": "mcp",
    }))
}

struct AuthGuard {
    token: String,
}

/// Reject any *present* non-loopback Origin (403). Applied to every route.
async fn origin_layer(req: Request<Body>, next: Next) -> Result<Response, StatusCode> {
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        if !origin_is_loopback(origin) {
            tracing::warn!(
                target: "packetbench::auth",
                service = "mcp-server",
                path = %req.uri().path(),
                origin = %origin,
                outcome = "forbidden_origin",
                "MCP request rejected: non-loopback Origin"
            );
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(next.run(req).await)
}

/// Reject missing/invalid bearer tokens (401). Applied to `/mcp` only.
async fn bearer_layer(
    State(guard): State<Arc<AuthGuard>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let provided = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !bearer_matches(provided, &guard.token) {
        tracing::warn!(
            target: "packetbench::auth",
            service = "mcp-server",
            path = %req.uri().path(),
            method = %req.method(),
            outcome = if provided.is_some() { "bad_token" } else { "no_token" },
            "MCP request rejected: bearer token missing or wrong"
        );
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
}

/// True when an `Origin` header value points at loopback (so a browser page on
/// a real origin is rejected, but our own webview / CLI clients pass).
pub fn origin_is_loopback(origin: &str) -> bool {
    // `null` is what sandboxed/file: origins send — treat as non-loopback.
    // Note: `url` returns IPv6 hosts bracketed, so loopback ::1 is `[::1]`.
    match reqwest::Url::parse(origin) {
        Ok(url) => matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("[::1]")
        ),
        Err(_) => false,
    }
}

/// Constant-time-ish compare of an `Authorization: Bearer <token>` header
/// against the expected token. Absent header or wrong scheme → false.
pub fn bearer_matches(provided: Option<&str>, expected: &str) -> bool {
    let Some(header) = provided else {
        return false;
    };
    // RFC 7235: the auth-scheme is case-insensitive ("Bearer" / "bearer").
    let Some((scheme, token)) = header.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    constant_time_eq(token.as_bytes(), expected.as_bytes())
}

/// Length-then-bytes comparison that doesn't short-circuit on the first
/// differing byte once lengths match. (The token is high-entropy and this is
/// loopback-only, so this is belt-and-suspenders, not load-bearing.)
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_origins_accepted() {
        assert!(origin_is_loopback("http://127.0.0.1:3100"));
        assert!(origin_is_loopback("http://localhost:3100"));
        assert!(origin_is_loopback("http://localhost"));
        assert!(origin_is_loopback("https://127.0.0.1"));
        assert!(origin_is_loopback("http://[::1]:3100"));
    }

    #[test]
    fn non_loopback_origins_rejected() {
        assert!(!origin_is_loopback("https://evil.example.com"));
        assert!(!origin_is_loopback("http://10.0.0.5:3100"));
        // Rebinding / userinfo tricks must not resolve to loopback.
        assert!(!origin_is_loopback("http://127.0.0.1.evil.com"));
        assert!(!origin_is_loopback("http://localhost@evil.com"));
        assert!(!origin_is_loopback("null"));
        assert!(!origin_is_loopback("not a url"));
    }

    #[test]
    fn bearer_requires_exact_token() {
        assert!(bearer_matches(Some("Bearer secret123"), "secret123"));
        // Scheme is case-insensitive per RFC 7235.
        assert!(bearer_matches(Some("bearer secret123"), "secret123"));
        assert!(!bearer_matches(Some("Bearer secret123"), "different"));
        assert!(!bearer_matches(Some("secret123"), "secret123")); // no scheme
        assert!(!bearer_matches(Some("Basic secret123"), "secret123")); // wrong scheme
        assert!(!bearer_matches(Some("Bearer "), "secret123"));
        assert!(!bearer_matches(None, "secret123"));
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    /// End-to-end: an unauthenticated request is rejected (401) and an
    /// authenticated `initialize` handshake is accepted (not 401).
    #[tokio::test]
    async fn auth_gates_the_transport() {
        let token = "test-token-abc".to_string();
        let cancel = CancellationToken::new();
        let audit = Arc::new(super::McpAuditLog::detached());
        let port = serve(0, token.clone(), cancel.clone(), audit, false, None)
            .await
            .expect("server binds");
        let base = format!("http://127.0.0.1:{port}/mcp");
        let client = reqwest::Client::new();

        let init_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" }
            }
        });

        // No token → 401 (rejected by our auth layer before rmcp).
        let unauthed = client
            .post(&base)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .json(&init_body)
            .send()
            .await
            .expect("request sent");
        assert_eq!(unauthed.status(), StatusCode::UNAUTHORIZED);

        // /health needs no token (liveness probe) …
        let health = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await
            .expect("health sent");
        assert_eq!(health.status(), StatusCode::OK);
        let body: serde_json::Value = health.json().await.expect("health json");
        assert_eq!(body["ok"], serde_json::json!(true));
        assert_eq!(body["app"], serde_json::json!("PacketBench"));
        // … but is still Origin-guarded so a browser page cannot fingerprint us.
        let cross_origin = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .header(header::ORIGIN, "https://evil.example.com")
            .send()
            .await
            .expect("health sent");
        assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);

        // With token → passes auth and reaches rmcp (must not be 401).
        let authed = client
            .post(&base)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .json(&init_body)
            .send()
            .await
            .expect("request sent");
        assert_ne!(authed.status(), StatusCode::UNAUTHORIZED);
        assert!(
            authed.status().is_success(),
            "initialize should succeed, got {}",
            authed.status()
        );

        cancel.cancel();
    }

    /// Pull the JSON-RPC payload out of a Streamable HTTP response body, which
    /// `rmcp` may return either as bare JSON or as a single SSE `data:` frame
    /// depending on the negotiated content type.
    fn parse_rpc(body: &str) -> serde_json::Value {
        // SSE streams interleave empty `data:` keepalives with the real frame,
        // so take the first one that actually parses rather than the first one
        // that merely has the prefix.
        for line in body.lines() {
            let Some(rest) = line.strip_prefix("data:") else {
                continue;
            };
            let rest = rest.trim();
            if rest.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(rest) {
                return value;
            }
        }
        serde_json::from_str(body).unwrap_or_else(|e| panic!("body is not JSON-RPC ({e}): {body:?}"))
    }

    /// End-to-end proof of the per-tool allowlist, over the real transport.
    ///
    /// FAULT this covers: `allowedTools` was persisted settings that reached
    /// nothing — every provider tool was served to any authenticated client.
    /// Both halves are asserted here because either one alone is worthless: a
    /// tool hidden from `tools/list` but still callable is not restricted, and
    /// a tool that errors on call but is advertised invites the attempt.
    #[tokio::test]
    async fn the_allowlist_is_enforced_over_the_wire() {
        let token = "allowlist-token".to_string();
        let cancel = CancellationToken::new();
        let audit = Arc::new(super::McpAuditLog::detached());
        // `get_active_flight` is allowed; `ping` and everything else is not.
        let allowed: HashSet<String> = ["get_active_flight".to_string()].into_iter().collect();
        let port = serve(
            0,
            token.clone(),
            cancel.clone(),
            audit,
            false,
            Some(Arc::new(allowed)),
        )
        .await
        .expect("server binds");
        let base = format!("http://127.0.0.1:{port}/mcp");
        let client = reqwest::Client::new();

        let post = |body: serde_json::Value, session: Option<String>| {
            let mut req = client
                .post(&base)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream");
            if let Some(id) = session {
                req = req.header("mcp-session-id", id);
            }
            req.json(&body).send()
        };

        // 1. initialize — the session id comes back as a response header.
        let init = post(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "0" }
                }
            }),
            None,
        )
        .await
        .expect("initialize sent");
        assert!(init.status().is_success(), "initialize: {}", init.status());
        let session = init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .expect("server issues a session id");
        let _ = init.text().await;

        // 2. notifications/initialized completes the handshake.
        let _ = post(
            serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            Some(session.clone()),
        )
        .await
        .expect("initialized sent");

        // 3. tools/list must not advertise a denied tool.
        let listed = post(
            serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            Some(session.clone()),
        )
        .await
        .expect("tools/list sent")
        .text()
        .await
        .expect("body read");
        let listed = parse_rpc(&listed);
        let names: Vec<String> = listed["result"]["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            names,
            vec!["get_active_flight".to_string()],
            "only the allowed tool may be advertised"
        );

        // 4. ...and calling the denied tool by name is refused anyway.
        let called = post(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "ping", "arguments": {} }
            }),
            Some(session.clone()),
        )
        .await
        .expect("tools/call sent")
        .text()
        .await
        .expect("body read");
        let called = parse_rpc(&called);
        assert!(
            called.get("error").is_some(),
            "a denied tool must not execute, got: {called}"
        );

        // 5. The allowed tool still works, so this is a filter and not an
        //    outage dressed up as security.
        let ok = post(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": { "name": "get_active_flight", "arguments": {} }
            }),
            Some(session),
        )
        .await
        .expect("tools/call sent")
        .text()
        .await
        .expect("body read");
        let ok = parse_rpc(&ok);
        assert!(
            ok.get("error").is_none(),
            "the allowed tool must still run, got: {ok}"
        );

        cancel.cancel();
    }
}
