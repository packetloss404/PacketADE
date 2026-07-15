//! N3 — PacketADE exposes ITSELF as an MCP server so external agents (Claude
//! Code, Codex, Cursor) can read its live state. Slice 0 is the walking
//! skeleton: lifecycle (start/stop/status) + Streamable HTTP transport bound to
//! loopback + bearer-token/Origin auth. Read resources & tools land in Slice 1.
//!
//! Transport: **Streamable HTTP** (the current MCP transport; the 2024 HTTP+SSE
//! transport is deprecated) via the official `rmcp` crate, mounted at `/mcp`.
//! The server reads from the same `~/.packetade/state.v1.json` the Tauri core
//! owns (`storage::load_state`), so it lives here in Rust, not the sidecar.

mod transport;

use serde::Serialize;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use rmcp::{
    handler::server::router::tool::ToolRouter,
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};

/// Managed Tauri state: the single (optional) running server. A `tokio::Mutex`
/// so the async lifecycle commands can hold it across `.await` points.
pub struct McpServerState {
    inner: Mutex<Option<RunningServer>>,
}

pub fn create_mcp_server_state() -> McpServerState {
    McpServerState {
        inner: Mutex::new(None),
    }
}

/// A live server instance. Dropping/`stop` cancels `cancel`, which both shuts
/// down `axum::serve` gracefully and cancels any in-flight MCP sessions.
struct RunningServer {
    cancel: CancellationToken,
    port: u16,
    token: String,
}

impl RunningServer {
    fn status(&self) -> McpServerStatus {
        McpServerStatus {
            running: true,
            port: Some(self.port),
            token: Some(self.token.clone()),
            url: Some(format!("http://127.0.0.1:{}/mcp", self.port)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// Bearer token external clients must send as `Authorization: Bearer <token>`.
    pub token: Option<String>,
    /// Convenience URL to paste into a client's MCP config.
    pub url: Option<String>,
}

impl McpServerStatus {
    fn stopped() -> Self {
        McpServerStatus {
            running: false,
            port: None,
            token: None,
            url: None,
        }
    }
}

/// Generate a high-entropy bearer token (128-bit v4 UUID, hyphen-free hex).
fn generate_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// === Tauri lifecycle commands ===

/// Start the MCP server on `127.0.0.1:<port>` (pass `0` to let the OS choose a
/// free port). Idempotent: if already running, returns the current status
/// unchanged. Returns the bound port + freshly-minted bearer token.
#[tauri::command]
pub async fn mcp_server_start(
    state: tauri::State<'_, McpServerState>,
    port: u16,
) -> Result<McpServerStatus, String> {
    let mut guard = state.inner.lock().await;
    if let Some(running) = guard.as_ref() {
        return Ok(running.status());
    }

    let token = generate_token();
    let cancel = CancellationToken::new();
    let bound_port = transport::serve(port, token.clone(), cancel.clone())
        .await
        .map_err(|e| format!("Failed to start MCP server: {e}"))?;

    let running = RunningServer {
        cancel,
        port: bound_port,
        token,
    };
    let status = running.status();
    *guard = Some(running);
    tracing::info!(port = bound_port, "MCP server started");
    Ok(status)
}

/// Stop the running MCP server (no-op if not running).
#[tauri::command]
pub async fn mcp_server_stop(
    state: tauri::State<'_, McpServerState>,
) -> Result<McpServerStatus, String> {
    let mut guard = state.inner.lock().await;
    if let Some(running) = guard.take() {
        running.cancel.cancel();
        tracing::info!(port = running.port, "MCP server stopped");
    }
    Ok(McpServerStatus::stopped())
}

/// Report whether the MCP server is running (and if so, on which port/token).
#[tauri::command]
pub async fn mcp_server_status(
    state: tauri::State<'_, McpServerState>,
) -> Result<McpServerStatus, String> {
    let guard = state.inner.lock().await;
    Ok(guard
        .as_ref()
        .map(RunningServer::status)
        .unwrap_or_else(McpServerStatus::stopped))
}

// === MCP handler ===

/// The MCP server handler. A fresh instance is created per session by the
/// transport's service factory. Stateless for now (reads state on demand in
/// Slice 1); Slice 0 exposes only a `ping` health-check tool.
#[derive(Clone)]
pub struct PacketAdeMcp {
    tool_router: ToolRouter<PacketAdeMcp>,
}

#[tool_router]
impl PacketAdeMcp {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "Health check — returns 'pong'.")]
    async fn ping(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![ContentBlock::text("pong")]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for PacketAdeMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(
            "PacketADE MCP server — read-only access to flights, tasks, memory, and workspaces.",
        )
    }
}
