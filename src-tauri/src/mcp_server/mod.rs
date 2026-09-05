//! N3 — PacketBench exposes ITSELF as an MCP server so external agents (Claude
//! Code, Codex, Cursor) can READ its live state, and (opt-in) post append-only
//! coordination notes back to a flight's timeline. Reads never mutate; the
//! writes (`append_handoff`, `escalate`) are gated behind `allow_writes`
//! (default off) so a read-only posture stays a real guarantee. Slice 0 =
//! lifecycle + Streamable HTTP transport + bearer/Origin auth; Slice 1 = read
//! resources + tools + audit; Slice 2 = event-routed coordination writes.
//!
//! Transport: **Streamable HTTP** (the current MCP transport; the 2024 HTTP+SSE
//! transport is deprecated) via the official `rmcp` crate, mounted at `/mcp`.
//! The server reads from the same `~/.packetbench/state.v1.json` the Tauri core
//! owns (`storage::load_state`), so it lives here in Rust, not the sidecar.

mod reads;
mod transport;

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, Implementation, ListResourcesResult, PaginatedRequestParams,
        ReadResourceRequestParams, ReadResourceResult, Resource, ResourceContents,
        ServerCapabilities, ServerInfo,
    },
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler,
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
    allow_writes: bool,
    /// The per-tool allowlist frozen at start. `None` = no allowlist was
    /// supplied, so every tool is served (the pre-enforcement behaviour).
    allowed_tools: Option<Arc<HashSet<String>>>,
    audit: Arc<McpAuditLog>,
}

impl RunningServer {
    fn status(&self) -> McpServerStatus {
        McpServerStatus {
            running: true,
            port: Some(self.port),
            token: Some(self.token.clone()),
            url: Some(format!("http://127.0.0.1:{}/mcp", self.port)),
            allow_writes: self.allow_writes,
            // Report what is ACTUALLY being served, not what was asked for, so
            // the settings card cannot claim a restriction the router isn't
            // applying. Sorted for a stable render.
            served_tools: served_tool_names(self.allowed_tools.as_deref()),
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
    /// Whether the append-only write tool (`append_handoff`) is enabled.
    pub allow_writes: bool,
    /// The tool names this run actually serves, after the per-tool allowlist
    /// was applied. Empty when stopped.
    pub served_tools: Vec<String>,
}

impl McpServerStatus {
    fn stopped() -> Self {
        McpServerStatus {
            running: false,
            port: None,
            token: None,
            url: None,
            allow_writes: false,
            served_tools: Vec::new(),
        }
    }
}

/// Generate a high-entropy bearer token (128-bit v4 UUID, hyphen-free hex).
fn generate_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// === Audit log ===

const AUDIT_CAP: usize = 200;

/// One MCP access, surfaced to the UI so the user can see what external agents
/// have been reading.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Monotonic per-run id — lets the UI dedupe the backlog fetch against the
    /// live event stream (both can carry the same access).
    seq: u64,
    /// `"tool"` or `"resource"`.
    kind: String,
    /// Tool name or resource URI.
    name: String,
    /// Epoch milliseconds.
    at: u64,
}

/// Bounded in-memory ring of recent accesses + a Tauri event on each, so the
/// McpProviderCard can show live activity. Not persisted.
pub struct McpAuditLog {
    /// `None` in tests (no Tauri runtime); `Some` at runtime, for event emit.
    app: Option<tauri::AppHandle>,
    entries: StdMutex<VecDeque<AuditEntry>>,
    seq: std::sync::atomic::AtomicU64,
}

impl McpAuditLog {
    fn new(app: tauri::AppHandle) -> Self {
        Self {
            app: Some(app),
            entries: StdMutex::new(VecDeque::new()),
            seq: std::sync::atomic::AtomicU64::new(0),
        }
    }

    #[cfg(test)]
    fn detached() -> Self {
        Self {
            app: None,
            entries: StdMutex::new(VecDeque::new()),
            seq: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn record(&self, kind: &str, name: &str) {
        let entry = AuditEntry {
            seq: self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            kind: kind.to_string(),
            name: name.to_string(),
            at: now_millis(),
        };
        if let Ok(mut q) = self.entries.lock() {
            q.push_back(entry.clone());
            while q.len() > AUDIT_CAP {
                q.pop_front();
            }
        }
        if let Some(app) = &self.app {
            let _ = app.emit("mcp-server-activity", entry);
        }
    }

    fn recent(&self) -> Vec<AuditEntry> {
        self.entries
            .lock()
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Emit an event-routed write intent. The MCP server can't write persisted
    /// state directly (the frontend saves it wholesale and would clobber the
    /// write), so a write tool emits this and the frontend's `mcpWriteBridge`
    /// applies it through the owning store action (the sole writer).
    fn emit_write(&self, intent: WriteIntent) {
        if let Some(app) = &self.app {
            let _ = app.emit("mcp-server-write", intent);
        }
    }
}

/// A write the frontend should apply. `op` selects the store action; `event` is
/// the op-specific payload (for `append_coordination_event`, a partial
/// `CoordinationEvent`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteIntent {
    op: String,
    flight_id: String,
    event: Value,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// === Tauri lifecycle commands ===

/// Start the MCP server on `127.0.0.1:<port>` (pass `0` to let the OS choose a
/// free port). Idempotent: if already running, returns the current status
/// unchanged. Returns the bound port + freshly-minted bearer token.
///
/// `allowed_tools` is the per-tool allowlist, frozen for the life of the run
/// (like `port` and `allow_writes`, the card requires a stop to change it).
/// `None` means no allowlist was supplied and every tool is served. An empty
/// list is a REAL answer — "serve no tools" — not an absent one, which is why
/// this is `Option<Vec<_>>` and not a bare `Vec<_>`.
#[tauri::command]
pub async fn mcp_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpServerState>,
    port: u16,
    allow_writes: bool,
    allowed_tools: Option<Vec<String>>,
) -> Result<McpServerStatus, String> {
    let mut guard = state.inner.lock().await;
    if let Some(running) = guard.as_ref() {
        return Ok(running.status());
    }

    let allowed_tools: Option<Arc<HashSet<String>>> = allowed_tools
        .map(|names| Arc::new(names.into_iter().collect::<HashSet<String>>()));

    let token = generate_token();
    let cancel = CancellationToken::new();
    let audit = Arc::new(McpAuditLog::new(app));
    let bound_port = transport::serve(
        port,
        token.clone(),
        cancel.clone(),
        audit.clone(),
        allow_writes,
        allowed_tools.clone(),
    )
    .await
    .map_err(|e| format!("Failed to start MCP server: {e}"))?;

    let running = RunningServer {
        cancel,
        port: bound_port,
        token,
        allow_writes,
        allowed_tools,
        audit,
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

/// Recent MCP accesses (most-recent-last), for the activity viewer. Empty when
/// the server isn't running.
#[tauri::command]
pub async fn mcp_server_recent_activity(
    state: tauri::State<'_, McpServerState>,
) -> Result<Vec<AuditEntry>, String> {
    let guard = state.inner.lock().await;
    Ok(guard.as_ref().map(|r| r.audit.recent()).unwrap_or_default())
}

/// Every tool this build's MCP server can serve, as the router actually
/// defines them.
///
/// FAULT this exists to prevent: the settings card used to keep its own
/// hardcoded copy of the tool list, which had already drifted from the router
/// (it was missing `ping` and the three coordination-inbox tools). An
/// allowlist checked against a stale catalogue would silently switch off tools
/// the user never saw, so the catalogue is read from the router itself and the
/// UI cannot disagree with what is enforced.
#[tauri::command]
pub async fn mcp_server_available_tools() -> Result<Vec<McpToolInfo>, String> {
    Ok(PacketBenchMcp::tool_router()
        .list_all()
        .into_iter()
        .map(|tool| McpToolInfo {
            name: tool.name.to_string(),
            description: tool
                .description
                .as_ref()
                .map(|d| d.to_string())
                .unwrap_or_default(),
        })
        .collect())
}

/// One row of the tool catalogue the settings card renders toggles for.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

/// The tool names a run with this allowlist actually serves, sorted.
/// `None` (no allowlist) means the full router.
fn served_tool_names(allowed: Option<&HashSet<String>>) -> Vec<String> {
    let mut names: Vec<String> = PacketBenchMcp::tool_router()
        .list_all()
        .into_iter()
        .map(|tool| tool.name.to_string())
        .filter(|name| allowed.is_none_or(|set| set.contains(name)))
        .collect();
    names.sort();
    names
}

// === MCP handler ===

fn load() -> crate::core::storage::PersistedState {
    crate::core::storage::load_state()
}

/// Wrap a JSON value as an MCP tool result (pretty-printed text content).
fn json_result(value: &Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    CallToolResult::success(vec![ContentBlock::text(text)])
}

/// Args for `read_task_details`. camelCase on the wire to match MCP convention.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ReadTaskArgs {
    flight_id: String,
    task_id: String,
}

/// Args for the coordination-note writes (`append_handoff`, `escalate`).
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct CoordinationWriteArgs {
    flight_id: String,
    summary: String,
    #[serde(default)]
    agent_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ReadInboxArgs {
    flight_id: String,
    #[serde(default)]
    recipient_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct PostInboxArgs {
    flight_id: String,
    kind: String,
    recipient_kind: String,
    #[serde(default)]
    recipient_id: Option<String>,
    #[serde(default)]
    recipient_label: Option<String>,
    body: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    dedupe_key: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct AcknowledgeInboxArgs {
    flight_id: String,
    message_id: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ProjectMemorySearchArgs {
    workspace_id: String,
    query: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ProjectMemoryReadArgs {
    workspace_id: String,
    note_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ProjectMemoryCreateArgs {
    workspace_id: String,
    title: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    provenance_ids: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ProjectMemoryUpdateArgs {
    workspace_id: String,
    note_id: String,
    expected_revision: String,
    title: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    provenance_ids: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename_all = "camelCase")]
struct ProjectMemoryArchiveArgs {
    workspace_id: String,
    note_id: String,
    expected_revision: String,
}

fn local_workspace_path(workspace_id: &str) -> Result<String, McpError> {
    reads::workspace_project_path(&load(), workspace_id)
        .map(str::to_string)
        .ok_or_else(|| {
            McpError::invalid_params(
                "workspaceId must identify a persisted local workspace",
                None,
            )
        })
}

/// The MCP server handler. A fresh instance is created per session by the
/// transport's service factory; state is read on demand from disk, so the
/// handler is cheap and shares only the audit sink.
#[derive(Clone)]
pub struct PacketBenchMcp {
    tool_router: ToolRouter<PacketBenchMcp>,
    audit: Arc<McpAuditLog>,
    /// When false the server is strictly read-only — `append_handoff` is
    /// rejected. Opt-in so a user who wants read-only keeps that guarantee.
    allow_writes: bool,
    /// The per-tool allowlist this session was built with, kept so the
    /// RESOURCE surface honours the same restriction. `None` = unrestricted.
    allowed_tools: Option<HashSet<String>>,
}

/// Which tool a resource route is equivalent to, for allowlist purposes. A
/// route with no tool equivalent (`project`, `issues`, `reviews`,
/// `packetcode/health` — the last one spawns a process) is served only when
/// no allowlist is in force.
///
/// FAULT this fixes: the allowlist gated `tools/list` + `tools/call` but every
/// `resources/read` still answered, so "serve no tools" still served project
/// memory, review packets, and a process spawn to any bearer holder.
fn resource_route_tool(route: &reads::ResourceRoute<'_>) -> Option<&'static str> {
    use reads::ResourceRoute;
    match route {
        ResourceRoute::Flights | ResourceRoute::Flight(_) => Some("get_active_flight"),
        ResourceRoute::FlightTasks(_) => Some("read_task_details"),
        ResourceRoute::FlightInbox(_) => Some("read_coordination_inbox"),
        ResourceRoute::MemoryPatterns => Some("read_memory_context"),
        ResourceRoute::ProjectMemory(_) => Some("read_project_memory"),
        ResourceRoute::Workspaces => Some("list_workspaces"),
        ResourceRoute::Project
        | ResourceRoute::Issues
        | ResourceRoute::Reviews
        | ResourceRoute::PacketCodeHealth
        | ResourceRoute::Unknown => None,
    }
}

fn resource_permitted(allowed: Option<&HashSet<String>>, uri: &str) -> bool {
    let Some(allowed) = allowed else {
        return true;
    };
    match resource_route_tool(&reads::parse_resource_uri(uri)) {
        Some(tool) => allowed.contains(tool),
        None => false,
    }
}

#[tool_router]
impl PacketBenchMcp {
    /// Build a per-session handler.
    ///
    /// FAULT this fixes: `allowedTools` was persisted settings that reached
    /// nothing. Every provider tool was served to any authenticated client and
    /// the only real gate was `allow_writes`, so a user who had narrowed the
    /// tool list was reading a restriction the server did not apply.
    ///
    /// Enforcement is `ToolRouter::disable_route`, which is the fail-closed
    /// primitive for exactly this: a disabled route is hidden from
    /// `tools/list` AND rejected by `tools/call` ("tool not found"). Doing it
    /// on the router rather than inside each tool body means a tool added
    /// later is covered by construction — there is no per-tool check anyone
    /// can forget to write.
    ///
    /// `None` = no allowlist supplied, serve everything (the behaviour before
    /// enforcement existed). `Some(empty)` is an answer, not an absence: it
    /// serves nothing.
    pub fn new(
        audit: Arc<McpAuditLog>,
        allow_writes: bool,
        allowed_tools: Option<&HashSet<String>>,
    ) -> Self {
        let mut tool_router = Self::tool_router();
        if let Some(allowed) = allowed_tools {
            // Collect first: `list_all` borrows the router we are about to
            // mutate.
            let denied: Vec<String> = tool_router
                .list_all()
                .into_iter()
                .map(|tool| tool.name.to_string())
                .filter(|name| !allowed.contains(name))
                .collect();
            for name in denied {
                tool_router.disable_route(name);
            }
        }
        Self {
            tool_router,
            audit,
            allow_writes,
            allowed_tools: allowed_tools.cloned(),
        }
    }

    #[tool(description = "Health check — returns 'pong'.")]
    async fn ping(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![ContentBlock::text("pong")]))
    }

    #[tool(description = "Get the currently active flight, or null if none is selected.")]
    async fn get_active_flight(&self) -> Result<CallToolResult, McpError> {
        self.audit.record("tool", "get_active_flight");
        Ok(json_result(&reads::active_flight_json(&load())))
    }

    #[tool(
        description = "List tasks that can be launched now (pending or queued), across all flights."
    )]
    async fn list_runnable_tasks(&self) -> Result<CallToolResult, McpError> {
        self.audit.record("tool", "list_runnable_tasks");
        Ok(json_result(&reads::runnable_tasks_json(&load())))
    }

    #[tool(
        description = "Read a task's full details, including its review packet, by flight and task ID."
    )]
    async fn read_task_details(
        &self,
        Parameters(args): Parameters<ReadTaskArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.audit.record("tool", "read_task_details");
        match reads::task_details_json(&load(), &args.flight_id, &args.task_id) {
            Some(v) => Ok(json_result(&v)),
            None => Err(McpError::invalid_params("task not found", None)),
        }
    }

    #[tool(description = "Read learned memory patterns for the workspace.")]
    async fn read_memory_context(&self) -> Result<CallToolResult, McpError> {
        self.audit.record("tool", "read_memory_context");
        Ok(json_result(&reads::memory_patterns_json(&load())))
    }

    #[tool(
        description = "Search bounded project-local Markdown memory for a persisted local workspace."
    )]
    async fn search_project_memory(
        &self,
        Parameters(args): Parameters<ProjectMemorySearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let project_path = local_workspace_path(&args.workspace_id)?;
        self.audit.record("tool", "search_project_memory");
        crate::commands::project_memory::search_project_memory_inner(&project_path, &args.query)
            .map(|results| json_result(&serde_json::to_value(results).unwrap_or(Value::Null)))
            .map_err(|message| McpError::invalid_params(message, None))
    }

    #[tool(
        description = "Read one project-local Markdown memory note by workspace and stable note id."
    )]
    async fn read_project_memory(
        &self,
        Parameters(args): Parameters<ProjectMemoryReadArgs>,
    ) -> Result<CallToolResult, McpError> {
        let project_path = local_workspace_path(&args.workspace_id)?;
        self.audit.record("tool", "read_project_memory");
        let snapshot = crate::commands::project_memory::list_project_memory_inner(&project_path)
            .map_err(|message| McpError::invalid_params(message, None))?;
        let note = snapshot
            .notes
            .into_iter()
            .find(|note| note.metadata.id == args.note_id)
            .ok_or_else(|| McpError::invalid_params("project-memory note not found", None))?;
        Ok(json_result(
            &serde_json::to_value(note).unwrap_or(Value::Null),
        ))
    }

    #[tool(
        description = "Create a confined project-local Markdown memory note. Requires allow_writes."
    )]
    async fn create_project_memory(
        &self,
        Parameters(args): Parameters<ProjectMemoryCreateArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.allow_writes {
            return Err(McpError::invalid_params(
                "writes are disabled; enable them in PacketBench's MCP Provider settings",
                None,
            ));
        }
        let project_path = local_workspace_path(&args.workspace_id)?;
        self.audit.record("tool", "create_project_memory");
        let note = crate::commands::project_memory::create_project_memory_inner(
            &project_path,
            crate::commands::project_memory::CreateProjectMemoryInput {
                title: args.title,
                body: args.body,
                tags: args.tags,
                provenance_ids: args.provenance_ids,
            },
        )
        .map_err(|message| McpError::invalid_params(message, None))?;
        Ok(json_result(
            &serde_json::to_value(note).unwrap_or(Value::Null),
        ))
    }

    #[tool(
        description = "Update a project-local Markdown memory note with an optimistic revision check. Requires allow_writes."
    )]
    async fn update_project_memory(
        &self,
        Parameters(args): Parameters<ProjectMemoryUpdateArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.allow_writes {
            return Err(McpError::invalid_params(
                "writes are disabled; enable them in PacketBench's MCP Provider settings",
                None,
            ));
        }
        let project_path = local_workspace_path(&args.workspace_id)?;
        self.audit.record("tool", "update_project_memory");
        let note = crate::commands::project_memory::update_project_memory_inner(
            &project_path,
            crate::commands::project_memory::UpdateProjectMemoryInput {
                id: args.note_id,
                expected_revision: args.expected_revision,
                title: args.title,
                body: args.body,
                tags: args.tags,
                provenance_ids: args.provenance_ids,
            },
        )
        .map_err(|message| McpError::invalid_params(message, None))?;
        Ok(json_result(
            &serde_json::to_value(note).unwrap_or(Value::Null),
        ))
    }

    #[tool(
        description = "Archive a project-local Markdown memory note with an optimistic revision check. Requires allow_writes."
    )]
    async fn archive_project_memory(
        &self,
        Parameters(args): Parameters<ProjectMemoryArchiveArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.allow_writes {
            return Err(McpError::invalid_params(
                "writes are disabled; enable them in PacketBench's MCP Provider settings",
                None,
            ));
        }
        let project_path = local_workspace_path(&args.workspace_id)?;
        self.audit.record("tool", "archive_project_memory");
        let note = crate::commands::project_memory::archive_project_memory_inner(
            &project_path,
            &args.note_id,
            &args.expected_revision,
        )
        .map_err(|message| McpError::invalid_params(message, None))?;
        Ok(json_result(
            &serde_json::to_value(note).unwrap_or(Value::Null),
        ))
    }

    #[tool(description = "List all workspaces.")]
    async fn list_workspaces(&self) -> Result<CallToolResult, McpError> {
        self.audit.record("tool", "list_workspaces");
        Ok(json_result(&reads::workspaces_json(&load())))
    }

    #[tool(
        description = "Read a Flight's structured coordination inbox. Optionally scope results to one recipient id."
    )]
    async fn read_coordination_inbox(
        &self,
        Parameters(args): Parameters<ReadInboxArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.audit.record("tool", "read_coordination_inbox");
        match reads::flight_inbox_json(&load(), &args.flight_id, args.recipient_id.as_deref()) {
            Some(value) => Ok(json_result(&value)),
            None => Err(McpError::invalid_params("flight not found", None)),
        }
    }

    #[tool(
        description = "Post a handoff note to a flight's coordination timeline. \
                       Append-only and human-visible (shown in the Flights view); \
                       does not change any task or flight state. Delivery is \
                       best-effort: it targets the running app instance."
    )]
    async fn append_handoff(
        &self,
        Parameters(args): Parameters<CoordinationWriteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.post_coordination_event(args, "handoff", "append_handoff")
    }

    #[tool(
        description = "Flag a flight for human attention (an escalation on its \
                       coordination timeline). Append-only and human-visible; \
                       changes no task or flight state. Use when a flight is stuck \
                       or needs a decision. Best-effort delivery."
    )]
    async fn escalate(
        &self,
        Parameters(args): Parameters<CoordinationWriteArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.post_coordination_event(args, "escalation", "escalate")
    }

    #[tool(
        description = "Post a validated, human-visible message to a Flight coordination inbox. \
                       Requires allow_writes. In assisted mode this reports to the inbox and does \
                       not silently forward the message to another agent."
    )]
    async fn post_coordination_message(
        &self,
        Parameters(args): Parameters<PostInboxArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.allow_writes {
            return Err(McpError::invalid_params(
                "writes are disabled; enable them in PacketBench's MCP Provider settings",
                None,
            ));
        }
        if let Err(message) = reads::validate_inbox_post(
            &load(),
            &args.flight_id,
            &args.kind,
            &args.recipient_kind,
            args.recipient_id.as_deref(),
            &args.body,
        ) {
            return Err(McpError::invalid_params(message, None));
        }
        self.audit.record("tool", "post_coordination_message");
        self.audit.emit_write(WriteIntent {
            op: "post_coordination_message".to_string(),
            flight_id: args.flight_id,
            event: serde_json::json!({
                "kind": args.kind,
                "recipientKind": args.recipient_kind,
                "recipientId": args.recipient_id,
                "recipientLabel": args.recipient_label,
                "body": args.body,
                "agentId": args.agent_id,
                "dedupeKey": args.dedupe_key,
            }),
        });
        Ok(CallToolResult::success(vec![ContentBlock::text(
            "Posted to the Flight coordination inbox.",
        )]))
    }

    #[tool(
        description = "Acknowledge one Flight coordination inbox message. Requires allow_writes."
    )]
    async fn acknowledge_coordination_message(
        &self,
        Parameters(args): Parameters<AcknowledgeInboxArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.allow_writes {
            return Err(McpError::invalid_params(
                "writes are disabled; enable them in PacketBench's MCP Provider settings",
                None,
            ));
        }
        if args.message_id.trim().is_empty() {
            return Err(McpError::invalid_params("messageId is required", None));
        }
        self.audit
            .record("tool", "acknowledge_coordination_message");
        self.audit.emit_write(WriteIntent {
            op: "acknowledge_coordination_message".to_string(),
            flight_id: args.flight_id,
            event: serde_json::json!({
                "messageId": args.message_id,
                "agentId": args.agent_id,
                "note": args.note,
            }),
        });
        Ok(CallToolResult::success(vec![ContentBlock::text(
            "Acknowledgement queued.",
        )]))
    }

    /// Shared body for the append-only coordination-note writes. Gates on
    /// `allow_writes`, validates against fresh state, audits, then emits the
    /// event-routed write (the frontend applies + persists it — see
    /// `src/lib/mcpWriteBridge.ts`).
    fn post_coordination_event(
        &self,
        args: CoordinationWriteArgs,
        event_type: &str,
        tool_name: &str,
    ) -> Result<CallToolResult, McpError> {
        if !self.allow_writes {
            return Err(McpError::invalid_params(
                "writes are disabled; enable them in PacketBench's MCP Provider settings",
                None,
            ));
        }
        if let Err(msg) = reads::validate_handoff(&load(), &args.flight_id, &args.summary) {
            return Err(McpError::invalid_params(
                msg,
                Some(serde_json::json!({ "flightId": args.flight_id })),
            ));
        }
        self.audit.record("tool", tool_name);
        self.audit.emit_write(WriteIntent {
            op: "append_coordination_event".to_string(),
            flight_id: args.flight_id,
            event: serde_json::json!({
                "type": event_type,
                "summary": args.summary,
                "agentId": args.agent_id,
            }),
        });
        Ok(CallToolResult::success(vec![ContentBlock::text(
            "Posted to the flight timeline.",
        )]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for PacketBenchMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(if self.allow_writes {
            "PacketBench MCP server — read access to flights, tasks, memory, and \
             workspaces, plus append-only coordination notes (append_handoff, \
             escalate) and the structured coordination inbox."
        } else {
            "PacketBench MCP server — read-only access to flights, tasks, memory, \
             and workspaces."
        })
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let state = load();
        let mut resources = vec![
            Resource::new("packetbench://project", "Project overview"),
            Resource::new("packetbench://flights", "All flights"),
            Resource::new("packetbench://issues", "Issue board"),
            Resource::new("packetbench://memory/patterns", "Memory patterns"),
            Resource::new("packetbench://workspaces", "Workspaces"),
            Resource::new("packetbench://reviews", "Review packets"),
            Resource::new(
                "packetbench://packetcode/health",
                "PacketCode integration health",
            ),
        ];
        for f in &state.flights {
            resources.push(Resource::new(
                format!("packetbench://flights/{}", f.id),
                f.title.clone(),
            ));
            resources.push(Resource::new(
                format!("packetbench://flights/{}/inbox", f.id),
                format!("{} coordination inbox", f.title),
            ));
        }
        for workspace in &state.workspaces {
            if workspace.server_id.is_none() {
                resources.push(Resource::new(
                    format!("packetbench://memory/project/{}", workspace.id),
                    format!("{} project memory", workspace.name),
                ));
            }
        }
        // Advertise only what `read_resource` would actually serve.
        resources.retain(|r| resource_permitted(self.allowed_tools.as_ref(), &r.uri));
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        use reads::ResourceRoute;
        if !resource_permitted(self.allowed_tools.as_ref(), &request.uri) {
            self.audit.record("resource-denied", &request.uri);
            return Err(McpError::invalid_request(
                "resource is not permitted by this server's tool allowlist",
                Some(serde_json::json!({ "uri": request.uri })),
            ));
        }
        self.audit.record("resource", &request.uri);
        let state = load();
        let value: Option<Value> = match reads::parse_resource_uri(&request.uri) {
            ResourceRoute::Project => Some(reads::project_overview_json(&state)),
            ResourceRoute::Flights => Some(reads::all_flights_json(&state)),
            ResourceRoute::Issues => Some(reads::all_issues_json(&state)),
            ResourceRoute::Flight(id) => reads::one_flight_json(&state, id),
            ResourceRoute::FlightTasks(id) => reads::flight_tasks_json(&state, id),
            ResourceRoute::FlightInbox(id) => reads::flight_inbox_json(&state, id, None),
            ResourceRoute::MemoryPatterns => Some(reads::memory_patterns_json(&state)),
            ResourceRoute::ProjectMemory(workspace_id) => {
                reads::workspace_project_path(&state, workspace_id).and_then(|project_path| {
                    crate::commands::project_memory::list_project_memory_inner(project_path)
                        .ok()
                        .and_then(|snapshot| serde_json::to_value(snapshot).ok())
                })
            }
            ResourceRoute::Workspaces => Some(reads::workspaces_json(&state)),
            ResourceRoute::Reviews => Some(reads::reviews_json(&state)),
            ResourceRoute::PacketCodeHealth => Some(
                match crate::commands::agent::probe_packetcode_integration(None, None).await {
                    Ok(probe) => serde_json::json!({
                        "available": true,
                        "healthy": probe.healthy,
                        "executablePath": probe.executable_path,
                        "version": probe.version,
                        "exitCode": probe.exit_code,
                        "schemaVersion": probe.schema_version,
                        "doctorStatus": probe.doctor_status,
                        "effectiveHome": probe.effective_home,
                        "homeSource": probe.home_source,
                        "providerSummary": probe.provider_summary,
                    }),
                    Err(error) => serde_json::json!({
                        "available": false,
                        "healthy": false,
                        "error": error,
                        "recovery": "Open Settings > Agents > PacketCode integration to detect, install, or set the executable and home path.",
                    }),
                },
            ),
            ResourceRoute::Unknown => None,
        };
        match value {
            Some(v) => {
                let text = serde_json::to_string_pretty(&v).unwrap_or_else(|_| "null".to_string());
                Ok(ReadResourceResult::new(vec![ResourceContents::text(
                    text,
                    request.uri.clone(),
                )]))
            }
            None => Err(McpError::resource_not_found(
                "resource not found",
                Some(serde_json::json!({ "uri": request.uri })),
            )),
        }
    }
}

#[cfg(test)]
mod allowlist_tests {
    use super::*;

    fn allow(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    fn handler(allowed: Option<&HashSet<String>>) -> PacketBenchMcp {
        PacketBenchMcp::new(Arc::new(McpAuditLog::detached()), false, allowed)
    }

    fn visible(handler: &PacketBenchMcp) -> Vec<String> {
        handler
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect()
    }

    /// The catalogue the settings card renders MUST be the router's own list.
    /// The old hardcoded frontend copy had already drifted — it never listed
    /// `ping` or the coordination-inbox tools — and an allowlist checked
    /// against a stale catalogue silently switches off working tools.
    #[test]
    fn the_catalogue_is_the_router_itself() {
        let names = served_tool_names(None);
        for expected in [
            "ping",
            "get_active_flight",
            "append_handoff",
            "read_coordination_inbox",
            "post_coordination_message",
            "acknowledge_coordination_message",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "{expected} missing from the catalogue: {names:?}"
            );
        }
        // Sorted, so the card renders in a stable order.
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    /// No allowlist = the pre-enforcement behaviour, unchanged.
    #[test]
    fn absent_allowlist_serves_every_tool() {
        let all = visible(&handler(None));
        assert_eq!(all.len(), served_tool_names(None).len());
        assert!(all.iter().any(|n| n == "get_active_flight"));
    }

    /// DENIAL PATH: a tool outside the allowlist is hidden from `tools/list`.
    /// A client that cannot see it cannot be tempted to call it.
    #[test]
    fn tools_outside_the_allowlist_are_not_advertised() {
        let allowed = allow(&["get_active_flight", "list_workspaces"]);
        let names = visible(&handler(Some(&allowed)));
        assert_eq!(names.len(), 2, "only the allowed tools survive: {names:?}");
        assert!(names.iter().any(|n| n == "get_active_flight"));
        assert!(names.iter().any(|n| n == "list_workspaces"));
        assert!(
            !names.iter().any(|n| n == "read_task_details"),
            "a denied tool must not be advertised: {names:?}"
        );
    }

    /// DENIAL PATH, the load-bearing half: hiding a tool from `tools/list` is
    /// cosmetic if the call still lands. `disable_route` is what makes both
    /// true at once — `ToolRouter::call` checks the disabled set before it
    /// looks the route up — so assert the name really landed in that set.
    /// The over-the-wire proof that the call is refused lives in
    /// `transport::tests::the_allowlist_is_enforced_over_the_wire`.
    #[test]
    fn a_denied_tool_is_disabled_not_merely_hidden() {
        let allowed = allow(&["get_active_flight"]);
        let h = handler(Some(&allowed));
        assert!(
            h.tool_router.is_disabled("ping"),
            "a denied tool must be disabled, which is what `call` rejects on"
        );
        assert!(
            !h.tool_router.has_route("ping"),
            "a denied tool must not be routable"
        );
        assert!(
            h.tool_router.has_route("get_active_flight"),
            "the gate is a filter, not a blanket failure"
        );
    }

    /// An empty allowlist is an ANSWER ("serve nothing"), not a missing one.
    /// Treating it as absent would fail open on the strictest setting there is.
    #[test]
    fn an_empty_allowlist_serves_nothing() {
        let allowed = allow(&[]);
        assert!(visible(&handler(Some(&allowed))).is_empty());
        assert!(served_tool_names(Some(&allowed)).is_empty());
    }

    /// A name nobody serves cannot conjure a tool into existence.
    #[test]
    fn unknown_names_in_the_allowlist_grant_nothing() {
        let allowed = allow(&["get_active_flight", "definitely_not_a_tool"]);
        assert_eq!(visible(&handler(Some(&allowed))), vec!["get_active_flight"]);
    }

    /// The status the card reads back must describe what is actually served,
    /// so the UI cannot report a restriction the router is not applying.
    #[test]
    fn resources_honour_the_tool_allowlist() {
        // No allowlist: everything, including the process-spawning health probe.
        assert!(resource_permitted(None, "packetbench://packetcode/health"));
        assert!(resource_permitted(None, "packetbench://memory/project/ws-1"));

        let allowed = allow(&["get_active_flight", "list_workspaces"]);
        assert!(resource_permitted(Some(&allowed), "packetbench://flights"));
        assert!(resource_permitted(Some(&allowed), "packetbench://flights/f1"));
        assert!(resource_permitted(Some(&allowed), "packetbench://workspaces"));
        for denied in [
            "packetbench://memory/patterns",
            "packetbench://memory/project/ws-1",
            "packetbench://flights/f1/inbox",
            "packetbench://flights/f1/tasks",
            "packetbench://reviews",
            "packetbench://issues",
            "packetbench://project",
            "packetbench://packetcode/health",
            "packetbench://nope",
        ] {
            assert!(
                !resource_permitted(Some(&allowed), denied),
                "{denied} must be denied under a narrowed allowlist"
            );
        }
        // "Serve no tools" serves no resources either.
        let none = allow(&[]);
        assert!(!resource_permitted(Some(&none), "packetbench://flights"));
    }

    #[test]
    fn served_tools_reports_the_effective_list() {
        let allowed = allow(&["ping", "list_workspaces"]);
        assert_eq!(
            served_tool_names(Some(&allowed)),
            vec!["list_workspaces".to_string(), "ping".to_string()]
        );
    }
}
