//! The packetcode ACP engine bridge — PacketBench's third agent transport.
//!
//! Alongside the PTY-backed CLIs and the Node agent sidecar, PacketBench can
//! drive a separately-installed `packetcode` engine (the sibling TUI product at
//! `D:\projects\packetcode`, never bundled) over Agent Client Protocol v1.
//!
//! The bridge resolves the engine binary, gates on a minimum version via
//! `packetcode doctor --json`, spawns `packetcode acp`, and speaks ACP v1 —
//! NDJSON JSON-RPC 2.0 over stdio. Session updates and permission requests are
//! handed to an [`AcpEvents`] sink; PacketBench's sink ([`events::ApiAgentSink`])
//! translates them onto the `api-agent:{kind}:{sessionId}` contract so the
//! frontend cannot tell which transport served a conversation.
//!
//! This module is the protocol layer ONLY. It knows nothing about the
//! `api-agent:*` event vocabulary — every translation lives in [`events`], and
//! every conversation-level routing decision in [`routing`]. Keeping
//! [`AcpBridge::dispatch`] free of PacketBench semantics is what lets the
//! integration suite in `tests/acp_stream.rs` drive the real code paths against
//! a mock engine with a plain collecting sink.

pub mod events;
pub mod install;
pub mod mcp;
pub mod routing;

pub use mcp::{AcpMcpCandidate, AcpMcpPlan, AcpMcpPosture, AcpMcpPostureKind, AcpMcpServer};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tracing::{debug, warn};

/// Oldest engine this client is tested against.
pub const MINIMUM_ENGINE_VERSION: &str = "0.1.0";
/// The ACP protocol version this client speaks, sent in `initialize` and
/// compared against what the engine answers.
///
/// A single constant rather than a literal in the handshake frame because the
/// value sent and the value checked have to be the same thing: they were two
/// unrelated numbers before, one hardcoded in the `json!` and one merely
/// recorded from the reply and never looked at. An engine that answered a
/// different version was accepted in complete silence — which is the failure
/// mode a version field exists to prevent.
pub const CLIENT_PROTOCOL_VERSION: u64 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The engine's own budget for starting a session's MCP fleet:
/// `context.WithTimeout(ctx, 30*time.Second)` in packetcode's
/// `packetACPFactory.startMCP` (cmd/packetcode/acp.go). Mirrored here only so
/// [`NEW_SESSION_TIMEOUT`] can be derived from it rather than guessed; keep the
/// two in step if the engine ever changes its cap.
const ENGINE_MCP_STARTUP_CEILING: Duration = Duration::from_secs(30);
/// `session/new` must outlast the engine's WORST legal case, not its typical
/// one. The engine spends up to [`ENGINE_MCP_STARTUP_CEILING`] starting this
/// session's MCP servers and only then builds the provider registry and
/// persists the session, so a client budget equal to that ceiling always loses
/// the race whenever MCP startup runs long — and loses it in the worst
/// possible way: the engine finishes moments later and registers a live
/// session PacketBench has already given up on. Three times the ceiling leaves
/// room for the work layered on top while still failing fast enough to be a
/// visible error rather than a hang. (`session/load` carries its own, larger
/// [`LOAD_TIMEOUT`] for the same class of reason.)
///
/// Expressed as a multiple rather than a literal so the two cannot drift apart
/// unnoticed; `session_new_budget_clears_the_engine_ceiling` pins the rule.
const NEW_SESSION_TIMEOUT: Duration = ENGINE_MCP_STARTUP_CEILING.saturating_mul(3);
/// `session/load` replays a whole transcript before resolving.
const LOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// `session/prompt` runs an entire agent turn; give it room.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// How long a graceful stop waits for the engine to exit after its stdin is
/// closed. Closing stdin is the only way a packetcode engine is asked to shut
/// down: its ACP loop returns when the stdin scanner hits EOF, and only then
/// does `Server.shutdown` (packetcode/internal/acp/server.go) cancel the live
/// turns and run `Runtime.Close` for every session — which is what releases
/// each session's resources, and the MCP child processes it spawned. Seconds,
/// not minutes: a wedged engine must never hold up app exit.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Bound on each forced-termination step, so a stop always returns even when
/// the OS is slow to reap.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Primary environment override for the engine binary.
const ENGINE_PATH_ENV: &str = "PACKETBENCH_ACP_ENGINE";
/// Legacy override honoured for convenience: the standalone packetcode GUI
/// prototype this bridge was ported from used this name, and developers still
/// have it exported.
const LEGACY_ENGINE_PATH_ENV: &str = "PACKETCODE_GUI_ENGINE";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub minimum_version: String,
    pub compatible: bool,
    /// Whether [`install::acp_install_engine`] can install the engine on this
    /// platform — true wherever packetcode publishes an install script
    /// (Windows, macOS, Linux), false elsewhere, and never a hardcoded
    /// constant. It gates a button, nothing more: the install downloads and
    /// runs a remote script and therefore only ever happens on an explicit
    /// click. See [`install`] for the safety rules that make that acceptable.
    pub install_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DoctorReport {
    #[allow(dead_code)]
    schema_version: Option<u64>,
    status: Option<String>,
    version: Option<String>,
}

/// The permission-mode vocabulary this client knows, in the engine's
/// escalation order (packetcode/internal/acp/server.go `PermissionModes`).
/// Used as the conservative fallback for engines that advertise no
/// `permissionModes` list, so they keep offering exactly what they did before
/// capability negotiation existed.
pub const PERMISSION_MODES: [&str; 5] = ["ask", "accept-edits", "auto", "read-only", "bypass"];

/// The engine's `agentCapabilities._packetcode` vendor extension block.
///
/// `advertised` is the load-bearing field: an engine that sent no
/// `_packetcode` object at all (an older packetcode, or a third-party ACP
/// agent) leaves every boolean `false`, and the frontend must NOT read those
/// as "feature missing" — the call-time method-not-found fallbacks still
/// decide. Only when `advertised` is true are the booleans authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketcodeCapabilities {
    /// Whether the engine sent an `agentCapabilities._packetcode` object.
    pub advertised: bool,
    /// Gates `_packetcode/sessions/list`.
    pub sessions_list: bool,
    /// Gates `_packetcode/sessions/rename`.
    pub sessions_rename: bool,
    /// Gates `_packetcode/sessions/usage` and prompt-result enrichment.
    pub sessions_usage: bool,
    /// Gates `_packetcode/models/list`.
    pub models_list: bool,
    /// Gates `_packetcode/commands/list`, which backs the composer's "/" menu.
    ///
    /// `Option` rather than `bool` because this flag arrived AFTER the vendor
    /// block itself: an engine that advertised `_packetcode` but predates the
    /// flag sends nothing, and reading that absence as `false` would hide a
    /// menu that works. `None` therefore means "the engine did not say", and
    /// the caller falls back to [`Self::advertised`] exactly as before;
    /// `Some(false)` is the engine disowning the method, which is new
    /// information and must be honoured.
    pub commands_list: Option<bool>,
    /// Gates `_packetcode/project/files`, which backs the composer's "@" menu.
    /// Same three-state rule as [`Self::commands_list`].
    pub project_files: Option<bool>,
    /// Gates the CONFIGURED half of `_packetcode/mcp/list` — the query with no
    /// session id, which reports the `[mcp.<name>]` servers the engine would
    /// start for a session that inherits them. That list is what the consent
    /// disclosure shows, so without this flag there is nothing to disclose.
    pub mcp_list: bool,
    /// A wire-behaviour promise, not a feature toggle: this engine reads an
    /// OMITTED `mcpServers` on session/new and session/load as "use your own
    /// configured servers". Omitting is the ONLY way to ask for them, since
    /// `[]` means "no MCP servers at all" on every engine — and engines that
    /// never made this promise reject the omission with invalid-params. So
    /// unlike the other flags this one is never assumed: false means the
    /// client must keep sending `[]`, with no call-time fallback available.
    pub mcp_defaults: bool,
    /// Modes `session/new` will accept. The engine trims this to the
    /// operator's configured ceiling; anything above it fails -32602, so the
    /// picker must offer exactly this set. Never empty: an engine that
    /// advertises nothing (or garbage) yields all five.
    pub permission_modes: Vec<String>,
    /// Mode a `session/new` without an override resolves to, when the engine
    /// says. `None` means "unknown" — the UI must not guess "ask".
    pub default_permission_mode: Option<String>,
}

impl Default for PacketcodeCapabilities {
    fn default() -> Self {
        Self {
            advertised: false,
            sessions_list: false,
            sessions_rename: false,
            sessions_usage: false,
            models_list: false,
            commands_list: None,
            project_files: None,
            mcp_list: false,
            mcp_defaults: false,
            permission_modes: PERMISSION_MODES.iter().map(|m| m.to_string()).collect(),
            default_permission_mode: None,
        }
    }
}

/// What the engine advertised in its ACP `initialize` response. Retained from
/// the handshake so the UI can offer only what the engine will actually
/// accept, instead of discovering that from -32601/-32602 errors at call time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    pub protocol_version: u64,
    /// Spec capability: whether `session/load` may be used to resume.
    pub load_session: bool,
    /// Spec capability (`sessionCapabilities.close`): whether the engine can
    /// release a session's runtime on request. False for engines that predate
    /// it — eviction there still drops the client-side transcript, but the
    /// engine keeps its runtime until a re-load supersedes it.
    pub session_close: bool,
    pub packetcode: PacketcodeCapabilities,
}

/// Parses an ACP `initialize` result into [`EngineCapabilities`].
///
/// Every field is optional and unknown fields are ignored: the engine may be
/// newer than this client, older than the capability block, or (in the limit)
/// answer something malformed. Missing or unusable input degrades to the
/// conservative defaults rather than failing the handshake.
fn parse_capabilities(result: &Value) -> EngineCapabilities {
    let agent = result.get("agentCapabilities").filter(|v| v.is_object());
    let ext = agent
        .and_then(|a| a.get("_packetcode"))
        .filter(|v| v.is_object());
    // Two-state: absent means the engine did not advertise the feature, and
    // for these flags that is indistinguishable from "no" by design — the
    // whole block being absent is what `advertised` already reports.
    let flag = |name: &str| {
        ext.and_then(|e| e.get(name))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    // Three-state, for flags added after the vendor block shipped: `None`
    // ("the engine did not say") must stay distinguishable from `Some(false)`
    // ("the engine says it does not serve this"), or an engine that predates
    // the flag would have a working menu hidden. Only a real boolean counts;
    // a string or number is not the engine saying anything.
    let opt_flag = |name: &str| ext.and_then(|e| e.get(name)).and_then(Value::as_bool);

    // An absent, non-array, or empty list means "the engine did not say":
    // keep all five so pre-capability engines behave exactly as before.
    let permission_modes = ext
        .and_then(|e| e.get("permissionModes"))
        .and_then(Value::as_array)
        .map(|items| {
            let mut modes: Vec<String> = Vec::with_capacity(items.len());
            for mode in items.iter().filter_map(Value::as_str) {
                let mode = mode.trim();
                if !mode.is_empty() && !modes.iter().any(|m| m == mode) {
                    modes.push(mode.to_string());
                }
            }
            modes
        })
        .filter(|modes| !modes.is_empty())
        .unwrap_or_else(|| PERMISSION_MODES.iter().map(|m| m.to_string()).collect());

    // A default outside the advertised set is nonsense; drop it rather than
    // let the UI preselect a mode session/new would reject.
    let default_permission_mode = ext
        .and_then(|e| e.get("defaultPermissionMode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|mode| !mode.is_empty() && permission_modes.iter().any(|m| m == mode))
        .map(String::from);

    EngineCapabilities {
        protocol_version: result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or(1),
        load_session: agent
            .and_then(|a| a.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // SessionCapabilities is object-shaped, not boolean-shaped: the spec
        // says `{}` means supported while an absent or null field means the
        // agent does not advertise it. Anything else (a stray `true`, a
        // number) is not the shape the spec defines, so it is not taken as
        // support.
        session_close: agent
            .and_then(|a| a.get("sessionCapabilities"))
            .and_then(|s| s.get("close"))
            .map(Value::is_object)
            .unwrap_or(false),
        packetcode: PacketcodeCapabilities {
            advertised: ext.is_some(),
            sessions_list: flag("sessionsList"),
            sessions_rename: flag("sessionsRename"),
            sessions_usage: flag("sessionsUsage"),
            models_list: flag("modelsList"),
            commands_list: opt_flag("commandsList"),
            project_files: opt_flag("projectFiles"),
            mcp_list: flag("mcpList"),
            mcp_defaults: flag("mcpDefaults"),
            permission_modes,
            default_permission_mode,
        },
    }
}

/// Sink for agent-initiated traffic. PacketBench's implementation translates
/// these onto `api-agent:*` Tauri events; tests collect them directly.
pub trait AcpEvents: Send + Sync + 'static {
    /// Params of a `session/update` notification.
    fn on_update(&self, params: Value);
    /// Params of a `session/request_permission` request, with `requestId` added.
    fn on_permission_request(&self, payload: Value);
}

/// The ACP protocol client: owns the engine's stdin, the reader/dispatch task,
/// and request/response bookkeeping. Knows nothing about Tauri, so integration
/// tests can drive it against a mock engine without an AppHandle.
pub struct AcpBridge {
    next_request_id: AtomicU64,
    /// Pending client->agent requests awaiting a response.
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    /// Agent->client permission requests awaiting the user's answer, keyed by
    /// the canonical JSON of the request id. The real engine uses STRING ids
    /// ("packetcode-permission-1"), so the raw id Value is stored and echoed
    /// back verbatim in the reply frame.
    permission_waiters: Mutex<HashMap<String, PendingPermission>>,
    /// The engine's stdin, or `None` once [`AcpBridge::close_stdin`] has
    /// dropped it to ask the engine to shut down. Writes after that fail
    /// cleanly instead of pretending the pipe is still there.
    stdin: Mutex<Option<ChildStdin>>,
}

/// One unanswered `session/request_permission`. The session id is kept next to
/// the raw JSON-RPC id because sessions run concurrently: cancelling one
/// session must answer only ITS outstanding requests and leave another
/// session's request waiting for the user.
///
/// `session_id` is `None` for a malformed request that named no session. Such
/// a waiter is deliberately unmatchable by any session-scoped sweep — an empty
/// id must never behave as a wildcard — while staying answerable by request
/// id, and it is still cleared when the engine goes away.
struct PendingPermission {
    session_id: Option<String>,
    raw_id: Value,
}

impl AcpBridge {
    /// Wraps an engine's stdio and spawns the reader task.
    /// Must be called from within a tokio runtime.
    pub fn start(
        stdin: ChildStdin,
        stdout: tokio::process::ChildStdout,
        sink: Arc<dyn AcpEvents>,
    ) -> Arc<Self> {
        let bridge = Arc::new(Self {
            next_request_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            permission_waiters: Mutex::new(HashMap::new()),
            stdin: Mutex::new(Some(stdin)),
        });
        let reader = bridge.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                reader.dispatch(&line, sink.as_ref()).await;
            }
            // Engine went away: fail pending requests now instead of letting
            // callers sit out their full timeout, and drop stale waiters.
            for (_, tx) in reader.pending.lock().await.drain() {
                let _ = tx.send(Err("engine closed the connection".into()));
            }
            reader.permission_waiters.lock().await.clear();
        });
        bridge
    }

    /// Routes one incoming NDJSON line: a response, a notification, or a
    /// server->client request. Unparseable or unrecognized lines are ignored.
    async fn dispatch(&self, line: &str, sink: &dyn AcpEvents) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        let has_id = msg.get("id").is_some();
        let method = msg.get("method").and_then(Value::as_str);
        match (has_id, method) {
            // Response to one of our requests.
            (true, None) => {
                let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                    return;
                };
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let result = match msg.get("error") {
                        Some(err) => Err(err.to_string()),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(result);
                }
            }
            // Notification from the agent.
            (false, Some("session/update")) => {
                if let Some(params) = msg.get("params") {
                    sink.on_update(params.clone());
                }
            }
            // Request from the agent — today only permission prompts. The id
            // may be a string or a number; it is stored and echoed verbatim.
            (true, Some("session/request_permission")) => {
                let Some(rpc_id) = msg.get("id").cloned() else {
                    return;
                };
                // Blank or absent is stored as None, never "": an empty
                // string would otherwise be swept by a stray
                // `cancel_session("")` and answer a request nobody meant.
                let session_id = msg
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(String::from);
                self.permission_waiters.lock().await.insert(
                    rpc_id.to_string(),
                    PendingPermission {
                        session_id,
                        raw_id: rpc_id.clone(),
                    },
                );
                if let Some(params) = msg.get("params") {
                    let mut payload = params.clone();
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("requestId".into(), rpc_id);
                    }
                    sink.on_permission_request(payload);
                }
            }
            _ => {}
        }
    }

    async fn write_line(&self, frame: &Value) -> Result<(), String> {
        let mut line = frame.to_string();
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("engine stdin is closed")?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("engine write failed: {e}"))
    }

    /// Flushes and closes the engine's stdin — the shutdown signal a
    /// packetcode engine actually listens for (see [`SHUTDOWN_GRACE`]).
    /// Idempotent: a second call is a no-op, and every later write fails with
    /// "engine stdin is closed" instead of blocking on a dead pipe.
    pub async fn close_stdin(&self) {
        if let Some(mut stdin) = self.stdin.lock().await.take() {
            // Flush what is buffered, then drop the handle: the drop is what
            // actually closes the pipe and lets the engine's scanner return.
            let _ = stdin.shutdown().await;
        }
    }

    /// Sends a request and awaits its response. The stdin lock is held only
    /// for the write, never across the await on the response — cancel and
    /// permission replies must be able to go out while a prompt is in flight.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_line(&frame).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match timeout(wait, rx).await {
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{method} timed out"))
            }
            Ok(Err(_)) => Err(format!("{method}: engine closed the channel")),
            Ok(Ok(result)) => result,
        }
    }

    /// Sends a notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    /// Removes every waiter belonging to `session_id` and returns their raw
    /// JSON-RPC ids, so the caller can decide whether they still deserve a
    /// reply. Scoped by session on purpose: other sessions' turns are still
    /// running and still need the user's answer.
    ///
    /// A blank `session_id` matches nothing, including waiters recorded from a
    /// request that named no session (those hold `None`).
    async fn take_session_waiters(&self, session_id: &str) -> Vec<Value> {
        if session_id.trim().is_empty() {
            return Vec::new();
        }
        let mut waiters = self.permission_waiters.lock().await;
        let doomed: Vec<String> = waiters
            .iter()
            .filter(|(_, pending)| pending.session_id.as_deref() == Some(session_id))
            .map(|(key, _)| key.clone())
            .collect();
        doomed
            .into_iter()
            .filter_map(|key| waiters.remove(&key).map(|pending| pending.raw_id))
            .collect()
    }

    /// Runs one `session/prompt` turn and reaps the session's unanswered
    /// permission waiters once it resolves, whatever the outcome.
    ///
    /// Permission requests only ever arise inside a turn, and the engine runs
    /// at most one turn per session (internal/acp/server.go keeps a per-session
    /// `active` flag), so once the prompt request resolves — end_turn,
    /// cancelled, an engine-side error, or our own timeout — anything still
    /// parked for this session belongs to the turn that just ended and will
    /// never be answered. Without this, a turn that ends by any route OTHER
    /// than a reply or a cancel (agent-side context cancel, engine internal
    /// error, an error event) leaks its waiter for the life of the process,
    /// and a later cancel answers a request the engine no longer has pending.
    ///
    /// The waiters are dropped WITHOUT a reply: the engine has already stopped
    /// waiting on them, so a late "cancelled" response would be nothing but an
    /// unknown-id line in its log.
    pub async fn prompt(
        &self,
        session_id: &str,
        text: &str,
        wait: Duration,
    ) -> Result<Value, String> {
        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": text }]
                }),
                wait,
            )
            .await;
        self.take_session_waiters(session_id).await;
        result
    }

    /// Cancels a session turn: sends `session/cancel` and answers THIS
    /// session's outstanding permission requests with a `cancelled` outcome
    /// (the ACP contract on cancellation). Late `permission_reply` calls for
    /// those requests then fail cleanly instead of double-answering the agent.
    /// Other sessions' requests are left pending — they belong to turns that
    /// are still running and still need the user's answer.
    ///
    /// A blank session id is rejected outright rather than broadcast: the
    /// engine has no such session, and sweeping on "" would be a wildcard over
    /// waiters that merely failed to name one.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        if session_id.trim().is_empty() {
            return Err("session/cancel needs a session id".to_string());
        }
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await?;
        for id in self.take_session_waiters(session_id).await {
            let _ = self
                .write_line(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "cancelled" } }
                }))
                .await;
        }
        Ok(())
    }

    /// Answers a pending agent permission request with the selected option.
    /// `request_id` is the raw JSON-RPC id from the permission event.
    pub async fn permission_reply(
        &self,
        request_id: &Value,
        option_id: &str,
    ) -> Result<(), String> {
        let Some(pending) = self
            .permission_waiters
            .lock()
            .await
            .remove(&request_id.to_string())
        else {
            return Err(format!("no pending permission request {request_id}"));
        };
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": pending.raw_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
        }))
        .await
    }
}

/// Managed Tauri state for the ACP transport.
///
/// `sessions` is PacketBench's addition to the ported bridge: the bidirectional
/// conversation-id ↔ ACP-session-id map plus the per-conversation translation
/// bookkeeping the `api-agent:*` sink needs. It is deliberately outside
/// `inner` so it survives an engine restart — a conversation keeps its
/// identity even if the engine is stopped and started underneath it.
#[derive(Default)]
pub struct AcpState {
    inner: Arc<Mutex<Option<Engine>>>,
    /// Binary path the last probe validated; acp_start spawns exactly this.
    resolved_binary: Arc<Mutex<Option<String>>>,
    /// What the running engine advertised in `initialize`. `None` until the
    /// handshake completes (and again after acp_stop).
    capabilities: Arc<Mutex<Option<EngineCapabilities>>>,
    /// Held for the duration of a user-initiated engine install, so a second
    /// click cannot start a run that races the first over the same
    /// destination file. See [`install`].
    installing: Arc<Mutex<()>>,
    /// Conversation-level bookkeeping shared with [`events::ApiAgentSink`].
    pub sessions: Arc<events::AcpSessions>,
}

struct Engine {
    child: Child,
    bridge: Arc<AcpBridge>,
}

/// The engine's binary name, without any platform extension.
const ENGINE_BINARY_STEM: &str = "packetcode";

/// Resolves the engine binary. **Precedence, highest first:**
///
/// 1. **Explicit user override** — the path pinned in Settings → Provider
///    Endpoints, then [`ENGINE_PATH_ENV`], then
///    [`LEGACY_ENGINE_PATH_ENV`]. Read the same way on every platform, and
///    taken verbatim: it is the escape hatch for a custom install, so it is
///    deliberately not filtered by an existence or executable-bit check — a
///    wrong path should fail loudly at spawn rather than silently fall through
///    to some other engine the user did not ask for.
/// 2. **`PATH`** — see [`path_search`], which honours `PATHEXT` on Windows and
///    requires an executable bit on Unix.
/// 3. **The documented default install directories** for this platform — see
///    [`install_dir_candidates`]. These exist because neither installer puts
///    itself on `PATH`: `install.ps1` explicitly warns that it does not, and
///    `install.sh`'s sudo-free `$HOME/.local/bin` target is frequently absent
///    from a GUI app's inherited `PATH` even when a terminal has it.
///
/// Falls back to the bare name, which lets the OS have the last word (and
/// produces a clean "not found" from the probe when it too fails).
///
/// Returns an absolute path whenever one was verified, so the binary the probe
/// validated is byte-identical to the one later spawned (a bare name would let
/// Windows' `CreateProcess` prefer the application directory over `PATH`).
fn resolve_engine_binary() -> String {
    resolve_from(
        engine_path_override(),
        || path_search(ENGINE_BINARY_STEM),
        default_install_binary,
    )
}

/// The precedence rule itself, as a pure function of the three tiers, so the
/// ordering is testable without touching the environment or the filesystem.
///
/// The lower tiers are closures rather than values because each one stats the
/// filesystem — a PATH walk on Windows is one `stat` per directory per PATHEXT
/// entry — and a resolution that already has its answer must not pay for it.
fn resolve_from(
    override_path: Option<String>,
    path_hit: impl FnOnce() -> Option<std::path::PathBuf>,
    installed: impl FnOnce() -> Option<std::path::PathBuf>,
) -> String {
    if let Some(exe) = override_path {
        return exe;
    }
    if let Some(hit) = path_hit() {
        return hit.to_string_lossy().to_string();
    }
    if let Some(default) = installed() {
        return default.to_string_lossy().to_string();
    }
    ENGINE_BINARY_STEM.to_string()
}

/// The user's explicit engine-path override: the path pinned in Settings →
/// Provider Endpoints first, then the environment variables.
///
/// Saved-before-environment matches `resolve_custom_compat_base_url`, and for
/// the same reason: a value the user just typed into the app must not be
/// silently outranked by an ambient export they may not even remember making.
/// The env vars remain the dev/CI escape hatch, and are the only override on
/// an install where nothing has been pinned.
///
/// Blank and whitespace-only values are treated as unset in both tiers, so an
/// empty export cannot make the app try to spawn `""`.
fn engine_path_override() -> Option<String> {
    if let Some(saved) = crate::core::storage::load_saved_acp_engine_path() {
        return Some(saved);
    }
    for var in [ENGINE_PATH_ENV, LEGACY_ENGINE_PATH_ENV] {
        if let Ok(exe) = std::env::var(var) {
            let exe = exe.trim();
            if !exe.is_empty() {
                return Some(exe.to_string());
            }
        }
    }
    None
}

/// Whether `path` is a file this process could actually execute.
///
/// On Unix `is_file()` is not enough: `PATH` and the install directories
/// routinely hold non-executable files, and an entry named `packetcode` that
/// merely exists is not the engine. The executable bit is what distinguishes
/// them, and skipping the check would have PacketBench "resolve" a path that
/// then fails at spawn with a permission error.
///
/// On Windows the bit does not exist; executability is decided by the
/// extension, which [`path_search`] handles via `PATHEXT`.
fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Any of user/group/other: which bit applies depends on ownership, and
        // a binary placed by `install -m 0755` carries all three.
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn path_search(name: &str) -> Option<std::path::PathBuf> {
    let paths = std::env::var_os("PATH")?;
    // On Windows, honor PATHEXT so .cmd/.bat shims resolve, and skip
    // extensionless files (not executable there anyway). Everywhere else the
    // bare name is the only candidate and the executable bit decides.
    let candidates: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|e| e.trim().to_lowercase())
            .filter(|e| e.starts_with('.'))
            .map(|e| format!("{name}{e}"))
            .collect()
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&paths) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if is_executable_file(&full) {
                return Some(full);
            }
        }
    }
    None
}

/// The install locations packetcode's own installers document, in the order
/// they are searched. Every entry is cited from the packetcode repo; nothing
/// here is guessed:
///
/// * **Windows** — `%LOCALAPPDATA%\Programs\PacketCode\bin\packetcode.exe`.
///   That is `install.ps1`'s `$InstallDir` default, and the README notes the
///   script "does not silently modify `PATH`", so a client must check the
///   location explicitly.
/// * **macOS / Linux** — `$HOME/.local/bin/packetcode`, then
///   `/usr/local/bin/packetcode`. `install.sh` defaults `INSTALL_DIR` to
///   `/usr/local/bin`, while the README and `docs/manual.md` document
///   `INSTALL_DIR="$HOME/.local/bin"` as the sudo-free variant — which is also
///   what PacketBench's own in-app installer passes, since a GUI app cannot
///   answer a sudo prompt. `$HOME/.local/bin` is checked first precisely
///   because it is the one most often missing from `PATH`; `/usr/local/bin` is
///   normally on `PATH` already and so is usually resolved a tier earlier.
///
/// Taking `home` and `local_appdata` as arguments keeps this a pure function
/// of the environment, so the per-platform expectations are testable.
fn install_dir_candidates(
    home: Option<&str>,
    local_appdata: Option<&str>,
) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        if let Some(local) = local_appdata.map(str::trim).filter(|v| !v.is_empty()) {
            out.push(
                std::path::PathBuf::from(local)
                    .join("Programs")
                    .join("PacketCode")
                    .join("bin")
                    .join("packetcode.exe"),
            );
        }
    } else {
        if let Some(home) = home.map(str::trim).filter(|v| !v.is_empty()) {
            out.push(
                std::path::PathBuf::from(home)
                    .join(".local")
                    .join("bin")
                    .join(ENGINE_BINARY_STEM),
            );
        }
        out.push(std::path::PathBuf::from("/usr/local/bin").join(ENGINE_BINARY_STEM));
    }
    out
}

/// First documented install location that actually holds a runnable engine.
fn default_install_binary() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let local_appdata = std::env::var("LOCALAPPDATA").ok();
    install_dir_candidates(home.as_deref(), local_appdata.as_deref())
        .into_iter()
        .find(|c| is_executable_file(c))
}

fn version_at_least(found: &str, minimum: &str) -> bool {
    // Source builds report "dev"; trust them as current — the ACP capability
    // handshake is the real compatibility check for unversioned engines.
    if found.trim_start_matches('v').starts_with("dev") {
        return true;
    }
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-', '+'])
            .take(3)
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let f = parse(found);
    let m = parse(minimum);
    if f.is_empty() {
        return false;
    }
    for i in 0..3 {
        let a = f.get(i).copied().unwrap_or(0);
        let b = m.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}

/// Strips Windows' verbatim (`\\?\`) prefix from a canonicalized path.
///
/// `std::fs::canonicalize` on Windows returns verbatim paths, which the engine
/// does not accept — but the UNC form must be folded back to `\\server\share`
/// rather than merely having the first four characters removed. Trimming
/// `\\?\UNC\srv\share` to `UNC\srv\share` yields a RELATIVE path that resolves
/// against whatever the engine's cwd happens to be; that is the bug this
/// helper exists to prevent.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Absolute, engine-acceptable form of a working directory. Single source of
/// truth for `session/new` and `session/load`, which must agree byte-for-byte
/// or a resumed session lands in a different directory than it started in.
fn canonical_cwd(cwd: &str) -> Result<String, String> {
    let abs = std::fs::canonicalize(cwd).map_err(|e| format!("cwd {cwd}: {e}"))?;
    Ok(strip_verbatim_prefix(&abs.to_string_lossy()))
}

#[tauri::command]
pub async fn acp_probe(state: State<'_, AcpState>) -> Result<EngineProbe, String> {
    run_probe(&state).await
}

/// Probes the engine and remembers the binary that answered, so a later
/// [`start_engine`] spawns byte-identically what was validated.
pub async fn run_probe(state: &AcpState) -> Result<EngineProbe, String> {
    let probe = probe_engine().await?;
    if let Some(path) = probe.path.clone() {
        *state.resolved_binary.lock().await = Some(path);
    }
    Ok(probe)
}

/// Stateless engine probe. Used by the auth-status badge, which only needs to
/// know whether an engine is installed and new enough and has no `AcpState`
/// to hand.
pub async fn probe_engine() -> Result<EngineProbe, String> {
    let bin = resolve_engine_binary();
    let mut command = Command::new(&bin);
    command
        .args(["doctor", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows: without CREATE_NO_WINDOW this flashes a console window on every
    // probe — and this probe runs on mount of BOTH agent views (the Agents
    // view's per-provider auth badge reaches it through
    // `acp::routing::auth_status`, and PacketCodeEngineGate probes on mount).
    // The `taskkill` and installer spawns in this module already hide theirs.
    crate::commands::shared::hide_window_async(&mut command);
    let output = timeout(PROBE_TIMEOUT, command.output()).await;

    let output = match output {
        Err(_) => {
            return Ok(probe_result(
                true,
                Some(bin),
                None,
                None,
                false,
                Some("doctor --json timed out".into()),
            ))
        }
        Ok(Err(e)) => {
            let detail = format!("could not run {bin}: {e}");
            return Ok(probe_result(false, None, None, None, false, Some(detail)));
        }
        Ok(Ok(o)) => o,
    };

    let report: DoctorReport = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("doctor --json returned invalid JSON: {e}"))?;
    let version = report.version.clone();
    let compatible = version
        .as_deref()
        .map(|v| version_at_least(v, MINIMUM_ENGINE_VERSION))
        .unwrap_or(false);

    Ok(probe_result(
        true,
        Some(bin),
        version,
        report.status,
        compatible,
        None,
    ))
}

fn probe_result(
    found: bool,
    path: Option<String>,
    version: Option<String>,
    status: Option<String>,
    compatible: bool,
    detail: Option<String>,
) -> EngineProbe {
    EngineProbe {
        found,
        path,
        version,
        status,
        minimum_version: MINIMUM_ENGINE_VERSION.into(),
        compatible,
        install_supported: install::install_supported(),
        // Where PacketBench cannot install the engine, say how to do it by hand
        // rather than leaving the UI with a disabled button and no
        // explanation. A real diagnostic always wins: it is the more specific
        // answer to "why is there no engine".
        detail: detail.or_else(|| {
            (!install::install_supported()).then(|| install::MANUAL_INSTALL_HINT.to_string())
        }),
    }
}

#[tauri::command]
pub async fn acp_start(
    app: tauri::AppHandle,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    start_default_engine(&app, &state).await
}

/// Starts the resolved engine with PacketBench's `api-agent:*` sink. Shared by
/// the `acp_start` command and the lazy start inside the api-agent routing
/// layer, so a conversation started before anyone probed still works.
pub async fn start_default_engine(
    app: &tauri::AppHandle,
    state: &AcpState,
) -> Result<(), String> {
    // Spawn exactly what the probe validated; fall back to a fresh resolution
    // only if no probe ran (direct dev invocation).
    let bin = state
        .resolved_binary
        .lock()
        .await
        .clone()
        .unwrap_or_else(resolve_engine_binary);
    let sink = Arc::new(events::ApiAgentSink::new(
        app.clone(),
        state.sessions.clone(),
    ));
    start_engine(state, &bin, &["acp"], sink).await
}

/// Spawns `program args..`, wires up an [`AcpBridge`], and performs the ACP
/// initialize handshake. Split out of the Tauri command (with explicit
/// program/args/sink) so integration tests can run the real start path
/// against a mock engine without an AppHandle.
pub async fn start_engine(
    state: &AcpState,
    program: &str,
    args: &[&str],
    sink: Arc<dyn AcpEvents>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Windows: the engine is a long-lived child, so without CREATE_NO_WINDOW
    // its console window stays on screen for the whole session rather than
    // merely flashing.
    crate::commands::shared::hide_window_async(&mut command);
    // The engine starts one MCP subprocess per configured server per session.
    // Giving it its own process group is what makes those grandchildren
    // reapable on Unix: `kill_process_tree` signals `-pid`, which is the group
    // only because the child leads one. Without this the group would be
    // PacketBench's, and signalling it would kill the app itself.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn {program} {}: {e}", args.join(" ")))?;

    let stdin = child.stdin.take().ok_or("no stdin on engine process")?;
    let stdout = child.stdout.take().ok_or("no stdout on engine process")?;

    let bridge = AcpBridge::start(stdin, stdout, sink);
    let handshake = bridge
        .request(
            "initialize",
            json!({
                "protocolVersion": CLIENT_PROTOCOL_VERSION,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
                // Brand-derived, never hardcoded: see core::brand.
                "clientInfo": {
                    "name": crate::core::brand::APP_NAME_LOWER,
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
            REQUEST_TIMEOUT,
        )
        .await?;
    // Keep what the engine advertised: the UI offers only the permission modes
    // and extensions this engine will actually accept, instead of discovering
    // them from -32601/-32602 errors at call time.
    let capabilities = parse_capabilities(&handshake);
    // Warn, never refuse. ACP is additive within a major version and every
    // optional method here already degrades on -32601, so a client that
    // hard-failed on an unfamiliar number would break pairings that work.
    // Silence is the thing to avoid: without this line a version mismatch
    // surfaces only as unexplained downstream parse failures.
    if capabilities.protocol_version != CLIENT_PROTOCOL_VERSION {
        warn!(
            engine = capabilities.protocol_version,
            client = CLIENT_PROTOCOL_VERSION,
            "ACP engine speaks a different protocol version; continuing, but frame shapes may \
             have changed"
        );
    }
    *state.capabilities.lock().await = Some(capabilities);
    *guard = Some(Engine { child, bridge });
    Ok(())
}

/// Whether the engine process is up and its handshake completed.
pub async fn is_running(state: &AcpState) -> bool {
    state.inner.lock().await.is_some()
}

/// Whether a bridge error is the engine answering method-not-found. The
/// bridge stringifies the whole JSON-RPC error object rather than parsing it,
/// so this sniffs the serialized text. Every optional `_packetcode/*` vendor
/// extension routes its "engine predates this feature" case through here and
/// degrades instead of failing.
fn is_method_not_found(err: &str) -> bool {
    err.contains("-32601") || err.contains("Method not found")
}

/// Capabilities the running engine advertised. Before the handshake (or after
/// a stop) this yields the conservative defaults — all five permission modes,
/// nothing advertised — which is exactly how a pre-capability engine is
/// treated, so callers never need a second set of fallbacks.
pub async fn capabilities_of(state: &AcpState) -> EngineCapabilities {
    state.capabilities.lock().await.clone().unwrap_or_default()
}

#[tauri::command]
pub async fn acp_capabilities(state: State<'_, AcpState>) -> Result<EngineCapabilities, String> {
    Ok(capabilities_of(&state).await)
}

/// Clones the bridge handle out of the state so protocol awaits never hold
/// the state lock (holding it across a prompt is what used to deadlock
/// cancel and permission replies).
async fn bridge_of(state: &AcpState) -> Result<Arc<AcpBridge>, String> {
    state
        .inner
        .lock()
        .await
        .as_ref()
        .map(|e| e.bridge.clone())
        .ok_or_else(|| "engine not started".to_string())
}

/// The `mcpServers` field for session/new and session/load, or `None` to
/// leave it out.
///
/// ACP has no "no preference" value here: `[]` is a positive instruction to
/// run the session with NO MCP servers, and a populated list means "exactly
/// these". Only the field's ABSENCE asks a capable engine for its own
/// configured fleet — the `[mcp.<name>]` blocks in the user's config.toml.
///
/// Absence therefore starts local subprocesses that this app never launched
/// itself, which is why the posture is a decision carried in from the caller
/// (PacketBench's frozen MCP trust snapshot — see [`mcp`]) rather than a
/// default. It is intersected with the engine's `mcpDefaults` promise by
/// [`resolve_posture`] before it reaches here.
fn mcp_servers_param(posture: &AcpMcpPosture) -> Option<Value> {
    posture.wire()
}

/// Builds the `session/new` params object. Optional per-session provider,
/// model, and permission-mode overrides ride in the engine's "_packetcode"
/// vendor-extension params object. The extension is omitted entirely when the
/// caller wants the engine defaults, so older engines see a spec-only call;
/// engines too old for a given field ignore it (plain JSON decode).
fn new_session_params(
    cwd_abs: &str,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    mcp: &AcpMcpPosture,
) -> Value {
    let mut params = json!({ "cwd": cwd_abs });
    if let Some(servers) = mcp_servers_param(mcp) {
        params
            .as_object_mut()
            .expect("session/new params are an object")
            .insert("mcpServers".into(), servers);
    }
    let provider = provider
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let permission_mode = permission_mode
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    if provider.is_some() || model.is_some() || permission_mode.is_some() {
        let mut ext = serde_json::Map::new();
        if let Some(p) = provider {
            ext.insert("provider".into(), json!(p));
        }
        if let Some(m) = model {
            ext.insert("model".into(), json!(m));
        }
        if let Some(mode) = permission_mode {
            ext.insert("permissionMode".into(), json!(mode));
        }
        params
            .as_object_mut()
            .expect("session/new params are an object")
            .insert("_packetcode".into(), Value::Object(ext));
    }
    params
}

/// Whether this session may inherit the engine's configured MCP servers: the
/// user asked for it AND the engine promised it understands the omission.
/// Both halves are required — asking an engine that never advertised
/// `mcpDefaults` fails the entire session/new with invalid-params.
async fn may_inherit_mcp(state: &AcpState, requested: bool) -> bool {
    requested && capabilities_of(state).await.packetcode.mcp_defaults
}

/// Intersects a requested posture with what the running engine will accept.
///
/// This is the ONLY path from a caller's wish to a wire frame, and it is the
/// choke point that makes the `mcpDefaults` guard unbypassable:
/// [`AcpMcpPosture::InheritEngineDefaults`] against an engine that never made
/// the promise is downgraded to [`AcpMcpPosture::None`], because omitting the
/// field there is not a degraded session — it is `-32602` and no session at
/// all. Downgrading loses MCP; sending it loses the conversation.
///
/// [`AcpMcpPosture::Explicit`] and [`AcpMcpPosture::None`] pass through
/// untouched: both send the field, which every engine understands.
async fn resolve_posture(state: &AcpState, requested: AcpMcpPosture) -> AcpMcpPosture {
    match requested {
        AcpMcpPosture::InheritEngineDefaults => {
            if may_inherit_mcp(state, true).await {
                AcpMcpPosture::InheritEngineDefaults
            } else {
                warn!(
                    "ACP engine does not advertise mcpDefaults; refusing to omit mcpServers and \
                     starting this session with no MCP servers"
                );
                AcpMcpPosture::None
            }
        }
        other => other,
    }
}

pub async fn new_session_on(
    state: &AcpState,
    cwd: &str,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    mcp: AcpMcpPosture,
) -> Result<String, String> {
    let abs = canonical_cwd(cwd)?;
    let mcp = resolve_posture(state, mcp).await;
    let params = new_session_params(&abs, provider, model, permission_mode, &mcp);
    let result = bridge_of(state)
        .await?
        .request("session/new", params, NEW_SESSION_TIMEOUT)
        .await?;
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| "session/new returned no sessionId".into())
}

/// `session/load` params. Same MCP contract as session/new: a resumed session
/// runs the posture the conversation FROZE at session start, which is why
/// callers pass the stored [`AcpMcpPosture`] rather than re-deriving one —
/// re-deriving would let a Settings edit between start and resume silently
/// change what a live conversation runs.
fn load_session_params(session_id: &str, cwd_abs: &str, mcp: &AcpMcpPosture) -> Value {
    let mut params = json!({ "sessionId": session_id, "cwd": cwd_abs });
    if let Some(servers) = mcp_servers_param(mcp) {
        params
            .as_object_mut()
            .expect("session/load params are an object")
            .insert("mcpServers".into(), servers);
    }
    params
}

/// Resumes a persisted session via ACP `session/load`, making it resident on
/// the engine again so the next `session/prompt` runs with its history as
/// context.
///
/// The engine replays the stored transcript as `session/update` notifications
/// before this request resolves. None of that replay reaches the frontend:
/// callers that hold a conversation go through
/// [`routing::load_session`](super::routing::load_session) or
/// [`routing::start_session`](super::routing::start_session), which bracket
/// this call with the conversation's replay window — see
/// `events::translate_update` for what that window suppresses and why a
/// partial replay would be a dishonest transcript rather than a useful one.
pub async fn load_session_on(
    state: &AcpState,
    session_id: &str,
    cwd: &str,
    mcp: AcpMcpPosture,
) -> Result<(), String> {
    let abs = canonical_cwd(cwd)?;
    let mcp = resolve_posture(state, mcp).await;
    bridge_of(state)
        .await?
        .request(
            "session/load",
            load_session_params(session_id, &abs, &mcp),
            LOAD_TIMEOUT,
        )
        .await?;
    Ok(())
}

/// Makes a persisted engine session resident again.
///
/// `sessionId` may be a PacketBench conversation id or a raw engine session id
/// from [`acp_list_sessions`] — see
/// [`routing::load_session`](routing::load_session) for the id and posture
/// rules. `cwd` is the working directory to resume in; the engine's own
/// `SessionSummary::working_dir` is the honest value for a directory row.
///
/// This does NOT bind a conversation to the session. Binding happens at
/// session start, where `start_api_agent_session`'s `acpEngineSessionId`
/// selects `session/load` over `session/new`; this command exists for surfaces
/// that need a session resident (or need to know whether it CAN be made
/// resident) before any conversation is committed to.
#[tauri::command]
pub async fn acp_load_session(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    routing::load_session(&app, &state, &session_id, &cwd).await
}

/// Per-session token/cost usage, as served by the engine's
/// `_packetcode/sessions/usage` extension and attached to successful
/// `session/prompt` results under `_packetcode.usage`. Parsed defensively:
/// the engine may be newer and grow fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    #[serde(default)]
    pub context_tokens: u64,
    #[serde(default)]
    pub total_input: u64,
    #[serde(default)]
    pub total_output: u64,
    #[serde(default)]
    pub cost_usd: f64,
}

/// Outcome of one prompt turn. `usage` is present only when the engine
/// enriched the result (`_packetcode.usage`); older engines yield `None` and
/// the frontend falls back to an explicit usage query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOutcome {
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsage>,
}

pub async fn prompt_on(
    state: &AcpState,
    session_id: &str,
    text: &str,
) -> Result<PromptOutcome, String> {
    let result = bridge_of(state)
        .await?
        .prompt(session_id, text, PROMPT_TIMEOUT)
        .await?;
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("end_turn")
        .to_string();
    // Vendor enrichment is best-effort: a malformed usage object degrades to
    // None rather than failing a turn that already completed.
    let usage = result
        .pointer("/_packetcode/usage")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    Ok(PromptOutcome { stop_reason, usage })
}

/// Usage for one session via the engine's `_packetcode/sessions/usage` ACP
/// extension. Engines that predate the extension answer method-not-found;
/// that is not an error — the statusline simply has nothing to show.
pub async fn session_usage_on(
    state: &AcpState,
    session_id: &str,
) -> Result<Option<SessionUsage>, String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/sessions/usage",
            json!({ "sessionId": session_id }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(result) => serde_json::from_value(result)
            .map(Some)
            .map_err(|e| format!("bad usage payload: {e}")),
        Err(err) if is_method_not_found(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_session_usage(
    session_id: String,
    state: State<'_, AcpState>,
) -> Result<Option<SessionUsage>, String> {
    let engine_id = state.sessions.engine_id_or_raw(&session_id);
    session_usage_on(&state, &engine_id).await
}

pub async fn cancel_on(state: &AcpState, session_id: &str) -> Result<(), String> {
    bridge_of(state).await?.cancel_session(session_id).await
}

/// Releases a session's engine-side runtime via the spec's `session/close`.
///
/// This is what makes client-side eviction real: without it, every session the
/// user ever opened keeps a provider registry, a tool registry, a backup
/// manager, its whole transcript, and one MCP child process per configured
/// server alive inside the engine until the engine dies.
///
/// Engines predating the method answer `-32601`, which degrades to `Ok`
/// exactly like the optional vendor extensions: eviction then still frees the
/// client's copy of the transcript, and the stale engine-side runtime is
/// superseded the next time the session is loaded. `session/close` on an
/// engine that has it is idempotent, so a doubled or racing eviction is fine.
/// How many engine sessions may stay resident at once.
///
/// Salvaged from the retired `packetcode-gui` repository, which carried this
/// policy before it was archived — see `backlog.md`. Five is its number, and
/// the point is bounding engine-side growth, not tuning: each resident session
/// holds a context manager, its whole transcript, and one MCP child process
/// per configured server alive inside the engine.
pub const MAX_IDLE_RESIDENT: usize = 5;

/// Closes least-recently-used engine sessions until at most
/// [`MAX_IDLE_RESIDENT`] remain resident.
///
/// Nothing is lost. The frontend holds each conversation's engine session id
/// and passes it back as `resume`, so re-selecting an evicted conversation
/// simply loads it again via `session/load`. Dropping the in-memory binding is
/// therefore the whole of the client-side eviction.
///
/// Best-effort by design: a failed close is logged and the binding is still
/// dropped. The alternative — keeping a conversation bound to a session we
/// could not close — leaks on both sides at once.
pub async fn evict_idle_sessions(state: &AcpState) {
    for (conversation_id, engine_session) in
        state.sessions.idle_eviction_candidates(MAX_IDLE_RESIDENT)
    {
        // Re-check under the current lock: a turn may have started on this
        // conversation between building the candidate list and getting here.
        if state.sessions.is_engaged(&conversation_id) {
            continue;
        }
        if let Err(error) = close_session_on(state, &engine_session).await {
            warn!(
                conversation_id = %conversation_id,
                engine_session = %engine_session,
                error = %error,
                "ACP idle eviction: session/close failed; dropping the binding anyway"
            );
        }
        state.sessions.forget(&conversation_id);
        debug!(
            conversation_id = %conversation_id,
            "ACP idle eviction: session closed and unbound; re-selecting will session/load it"
        );
    }
}

pub async fn close_session_on(state: &AcpState, session_id: &str) -> Result<(), String> {
    let response = bridge_of(state)
        .await?
        .request(
            "session/close",
            json!({ "sessionId": session_id }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(_) => Ok(()),
        Err(err) if is_method_not_found(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

pub async fn permission_reply_on(
    state: &AcpState,
    request_id: &Value,
    option_id: &str,
) -> Result<(), String> {
    bridge_of(state)
        .await?
        .permission_reply(request_id, option_id)
        .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub name: String,
    pub updated_at: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default)]
    pub cost_usd: f64,
}

/// Whether `_packetcode/sessions/list` is worth asking for.
///
/// An engine that advertised the vendor block and said `sessionsList: false`
/// is taken at its word. The call-time `-32601` fallback below is not enough
/// on its own: an engine that knows it does not serve the method is free to
/// answer with any error it likes (invalid request, unsupported, a plain
/// string), and every one of those reaches the frontend as "history
/// unavailable" instead of the disk listing that was available all along.
/// Engines that advertised nothing keep the old behaviour exactly — ask, and
/// fall back on method-not-found.
fn should_ask_engine_for_sessions(caps: &PacketcodeCapabilities) -> bool {
    !caps.advertised || caps.sessions_list
}

/// Session history for the engine's own sidebar-style listing. Prefers the
/// engine's `_packetcode/sessions/list` ACP extension; falls back to reading
/// `~/.packetcode/sessions/*.json` when the engine predates it, or said in the
/// handshake that it does not serve it.
///
/// Extracted from the command body so the whole surface is testable without a
/// Tauri `State`.
pub async fn list_sessions_on(state: &AcpState) -> Result<Vec<SessionSummary>, String> {
    if !should_ask_engine_for_sessions(&capabilities_of(state).await.packetcode) {
        return list_sessions_from_disk();
    }
    let listed = match bridge_of(state).await {
        Ok(bridge) => {
            bridge
                .request("_packetcode/sessions/list", json!({}), REQUEST_TIMEOUT)
                .await
        }
        Err(e) => Err(e),
    };
    match listed {
        Ok(result) => {
            let sessions = result.get("sessions").cloned().unwrap_or(json!([]));
            serde_json::from_value(sessions).map_err(|e| format!("bad sessions payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => list_sessions_from_disk(),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_list_sessions(state: State<'_, AcpState>) -> Result<Vec<SessionSummary>, String> {
    list_sessions_on(&state).await
}

/// Renames a persisted session via the engine's `_packetcode/sessions/rename`
/// ACP extension. Engines that predate the extension answer method-not-found;
/// that is silently ignored — titles then simply stay engine-generated.
pub async fn rename_session_on(
    state: &AcpState,
    session_id: &str,
    name: &str,
) -> Result<(), String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/sessions/rename",
            json!({ "sessionId": session_id, "name": name }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(_) => Ok(()),
        Err(err) if is_method_not_found(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_rename_session(
    session_id: String,
    name: String,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    let engine_id = state.sessions.engine_id_or_raw(&session_id);
    rename_session_on(&state, &engine_id, &name).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub default: bool,
}

/// Provider/model choices via the engine's `_packetcode/models/list` ACP
/// extension. Engines that predate the extension answer method-not-found;
/// that is not an error — the picker simply has nothing to offer.
///
/// Extracted from the command body so the whole surface is testable without a
/// Tauri `State`.
pub async fn list_models_on(state: &AcpState) -> Result<Vec<ModelOption>, String> {
    let response = bridge_of(state)
        .await?
        .request("_packetcode/models/list", json!({}), REQUEST_TIMEOUT)
        .await;
    match response {
        Ok(result) => {
            let models = result.get("models").cloned().unwrap_or(json!([]));
            serde_json::from_value(models).map_err(|e| format!("bad models payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_list_models(state: State<'_, AcpState>) -> Result<Vec<ModelOption>, String> {
    list_models_on(&state).await
}

/// One MCP server as reported by the engine's `_packetcode/mcp/list`
/// extension. Fields are additive on the wire; unknown ones are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    /// "running", "failed", "disabled" (configured with `enabled = false`),
    /// or "configured" (known from configuration, not started in this scope).
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub tool_count: u32,
    /// "agent" for the engine's own configuration, "client" for servers an
    /// ACP client supplied. This client never supplies any of its own.
    #[serde(default)]
    pub source: String,
    /// The executable the engine would run. Load-bearing for disclosure: this
    /// is the arbitrary local subprocess the user is being asked about.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub error: String,
}

/// MCP servers via the engine's `_packetcode/mcp/list` extension.
///
/// With a session id: that session's LIVE fleet — what actually started, with
/// tool counts and startup errors. Without one: the engine's CONFIGURED
/// servers, which is what a session that inherits them would start. The
/// second form is the disclosure surface — it can be read before any session
/// exists, so the user sees the command list before anything is spawned.
///
/// Engines predating the extension answer method-not-found, which degrades to
/// an empty list rather than an error: nothing to show, no failure to report.
pub async fn list_mcp_servers_on(
    state: &AcpState,
    session_id: Option<&str>,
) -> Result<Vec<McpServerStatus>, String> {
    let params = match session_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => json!({ "sessionId": id }),
        None => json!({}),
    };
    let response = bridge_of(state)
        .await?
        .request("_packetcode/mcp/list", params, REQUEST_TIMEOUT)
        .await;
    match response {
        Ok(result) => {
            let servers = result.get("servers").cloned().unwrap_or(json!([]));
            serde_json::from_value(servers).map_err(|e| format!("bad MCP payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_list_mcp_servers(
    session_id: Option<String>,
    state: State<'_, AcpState>,
) -> Result<Vec<McpServerStatus>, String> {
    let engine_id = session_id.map(|id| state.sessions.engine_id_or_raw(&id));
    list_mcp_servers_on(&state, engine_id.as_deref()).await
}

/// What an ACP session started right now, with this trust decision, would run.
///
/// The second half of the disclosure surface. [`acp_list_mcp_servers`] with no
/// session id answers "what would the ENGINE start"; this answers "what would
/// PACKETBENCH hand it, given what the user has trusted" — every configured
/// server, whether it is included, and the machine-readable reason when it is
/// not. Nothing is spawned: this only reads configuration.
///
/// Inputs are the same two the sidecar path already takes, so a UI builds one
/// trust decision and spends it on whichever transport serves the
/// conversation:
///
/// * `enabled_mcp_server_ids` — the per-conversation server allowlist. `None`
///   means the user has made no selection, which yields
///   [`AcpMcpPostureKind::None`]: unlike the sidecar, ACP cannot filter tools
///   at call time, so "not told" cannot mean "all of them".
/// * `mcp_trust_snapshot` — the frozen per-server authority. `None` likewise
///   yields [`AcpMcpPostureKind::None`].
/// * `inherit_engine_defaults` — the separate, explicit consent to the
///   ENGINE's own fleet (what [`acp_list_mcp_servers`] disclosed). It is
///   reported as refused when the running engine never advertised
///   `mcpDefaults`, since omitting the field there fails the whole session.
///
/// The first two answers need no engine. `inherit_engine_defaults` is answered
/// from the handshake, so ask it AFTER `acp_start`: with no engine running
/// there are no advertised capabilities, and the honest answer to "will this
/// engine accept an omitted mcpServers" is then the conservative one — the
/// plan comes back `inheritRefused: true`.
#[tauri::command]
pub async fn acp_mcp_plan(
    project_path: String,
    enabled_mcp_server_ids: Option<Vec<String>>,
    mcp_trust_snapshot: Option<Vec<crate::core::mcp_bridge::McpTrustSnapshot>>,
    inherit_engine_defaults: Option<bool>,
    state: State<'_, AcpState>,
) -> Result<AcpMcpPlan, String> {
    let mut plan = mcp::plan_for_session(
        &project_path,
        enabled_mcp_server_ids.as_deref(),
        mcp_trust_snapshot.as_deref(),
    )
    .await;
    if inherit_engine_defaults.unwrap_or(false) {
        // Explicit beats inherit wherever PacketBench has trusted configs of its
        // own: naming the exact servers is the honest form of the same
        // consent, and it keeps PacketBench's and packetcode's MCP surfaces from
        // drifting apart silently.
        if plan.posture == AcpMcpPostureKind::None {
            if may_inherit_mcp(&state, true).await {
                plan.posture = AcpMcpPostureKind::InheritEngineDefaults;
            } else {
                plan.inherit_refused = true;
            }
        }
    }
    Ok(plan)
}

/// One invocable slash command from the engine's `_packetcode/commands/list`
/// extension. `source` is "builtin", "user", or "project"; `argumentHint` is a
/// short usage tail such as "[arguments]" and is absent for commands that take
/// none. Today's engine reports only markdown commands from
/// `~/.packetcode/commands` and `<cwd>/.packetcode/commands` — its built-in
/// slash commands are TUI affordances with no ACP equivalent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

/// Slash commands available in `cwd`, via the engine's
/// `_packetcode/commands/list` ACP extension. Engines that predate the
/// extension answer method-not-found; that is not an error — the composer's
/// "/" menu simply has nothing to offer and stops advertising itself.
pub async fn list_commands_on(state: &AcpState, cwd: &str) -> Result<Vec<SlashCommand>, String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/commands/list",
            json!({ "cwd": cwd }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(result) => {
            let commands = result.get("commands").cloned().unwrap_or(json!([]));
            serde_json::from_value(commands).map_err(|e| format!("bad commands payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_list_commands(
    cwd: String,
    state: State<'_, AcpState>,
) -> Result<Vec<SlashCommand>, String> {
    list_commands_on(&state, &cwd).await
}

/// How many @-mention candidates one search asks the engine for. The menu
/// shows a scrollable list, so this is a legibility bound rather than a
/// protocol one; the engine clamps anything larger itself.
const FILE_MENTION_LIMIT: u32 = 20;

/// Project files matching `query`, via the engine's
/// `_packetcode/project/files` ACP extension. Paths are project-relative and
/// slash-separated, ranked best-match first by the engine. Engines that
/// predate the extension answer method-not-found; that is not an error — the
/// composer's "@" menu simply has nothing to offer.
pub async fn search_files_on(
    state: &AcpState,
    cwd: &str,
    query: &str,
) -> Result<Vec<String>, String> {
    let response = bridge_of(state)
        .await?
        .request(
            "_packetcode/project/files",
            json!({ "cwd": cwd, "query": query, "limit": FILE_MENTION_LIMIT }),
            REQUEST_TIMEOUT,
        )
        .await;
    match response {
        Ok(result) => {
            let files = result.get("files").cloned().unwrap_or(json!([]));
            serde_json::from_value(files).map_err(|e| format!("bad files payload: {e}"))
        }
        Err(err) if is_method_not_found(&err) => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn acp_search_files(
    cwd: String,
    query: String,
    state: State<'_, AcpState>,
) -> Result<Vec<String>, String> {
    search_files_on(&state, &cwd, &query).await
}

/// The ENGINE's home directory, not PacketBench's.
///
/// `PACKETCODE_HOME` / `~/.packetcode` belongs to the sibling packetcode TUI
/// product, which is what writes the `sessions/*.json` files read below. It is
/// NOT PacketBench's legacy data dir (`core::brand::LEGACY_DATA_DIR_NAME`, which
/// happens to have the same name and is migrated away on startup). Do not
/// "fix" this to `.packetbench` — that directory is a different product's and
/// pointing at PacketBench's own would make the disk fallback read nothing.
fn packetcode_home() -> Option<std::path::PathBuf> {
    if let Ok(home) = std::env::var("PACKETCODE_HOME") {
        if !home.trim().is_empty() {
            return Some(std::path::PathBuf::from(home));
        }
    }
    let user_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::PathBuf::from(user_home).join(".packetcode"))
}

fn list_sessions_from_disk() -> Result<Vec<SessionSummary>, String> {
    #[derive(Deserialize)]
    struct DiskCost {
        #[serde(default)]
        total_usd: f64,
    }
    #[derive(Deserialize)]
    struct DiskSession {
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        updated_at: String,
        #[serde(default)]
        provider: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        working_dir: String,
        #[serde(default)]
        messages: Vec<serde::de::IgnoredAny>,
        #[serde(default)]
        cost: Option<DiskCost>,
    }

    let Some(dir) = packetcode_home().map(|h| h.join("sessions")) else {
        return Ok(Vec::new());
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        let Ok(s) = serde_json::from_slice::<DiskSession>(&data) else {
            continue;
        };
        out.push(SessionSummary {
            session_id: s.id,
            name: s.name,
            updated_at: s.updated_at,
            provider: s.provider,
            model: s.model,
            working_dir: s.working_dir,
            message_count: s.messages.len() as u64,
            cost_usd: s.cost.map(|c| c.total_usd).unwrap_or(0.0),
        });
    }
    // Newest first, same as the engine's ordering.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// How long a group SIGTERM is given to work before SIGKILL follows it.
///
/// Short by design — the caller has already spent [`SHUTDOWN_GRACE`] asking
/// politely — but deliberately not zero: sending both signals back to back
/// makes the SIGTERM decorative, and SIGTERM is the one an MCP server is
/// actually likely to handle and flush state on. Unix only; `taskkill /F` has
/// no graceful counterpart worth waiting for, so this is defined
/// unconditionally only so the shutdown-budget test can assert the worst case
/// on any host.
#[cfg_attr(not(unix), allow(dead_code))]
const GROUP_TERM_GRACE: Duration = Duration::from_millis(300);

/// Best-effort kill of a child and everything it spawned.
///
/// `Child::kill` (and `kill_on_drop`) terminate only the child itself, so on
/// EITHER platform the engine's MCP grandchildren outlive it. This mirrors
/// `commands::agent_sidecar::supervisor::kill_process_tree`, which solved the
/// same problem for the Node sidecar:
///
/// * **Windows** — `taskkill /T /F`, the only way to walk the child tree.
/// * **Unix** — signal the child's PROCESS GROUP. The engine is spawned with
///   `process_group(0)` (see [`start_engine`]), so its pid is also its pgid and
///   `kill(-pid, …)` reaches every descendant that did not deliberately leave
///   the group. SIGTERM first, then SIGKILL for whatever ignored it. Without
///   the group, this arm previously returned `false` and the MCP children were
///   simply never reaped.
///
/// Returns whether a tree kill was actually attempted, so callers know whether
/// waiting for the child to fall over is worth the time.
async fn kill_process_tree(child: &Child) -> bool {
    let Some(pid) = child.id() else {
        return false;
    };
    // 0 means "my own group" and 1 is init; negating either would be
    // catastrophic, and neither can be a real child of ours.
    if pid <= 1 {
        return false;
    }
    #[cfg(unix)]
    {
        let group = -(pid as i32);
        // SAFETY: `kill` takes no pointers and cannot corrupt this process's
        // memory. The worst case is a stale pid, which fails with ESRCH and is
        // ignored — and the negation is guarded by the `pid <= 1` check above.
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        tokio::time::sleep(GROUP_TERM_GRACE).await;
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
        true
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::commands::shared::hide_window_async(&mut cmd);
        cmd.status().await.is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

pub async fn stop_on(state: &AcpState) -> Result<(), String> {
    stop_engine(state, SHUTDOWN_GRACE).await
}

/// Shuts the engine down, escalating only as far as it has to:
///
/// 1. close stdin — the engine's ACP loop returns on EOF and runs its own
///    `Server.shutdown`, cancelling live turns and closing every session
///    runtime (and with it the MCP children those sessions spawned);
/// 2. wait up to `grace` for it to exit by itself;
/// 3. tree-kill it, because nothing else reaps its descendants — `taskkill
///    /T /F` on Windows, a SIGTERM-then-SIGKILL to its process group on Unix;
/// 4. kill the engine process directly, as the last resort.
///
/// Killing outright would deny the engine any chance to release what it owned.
/// Every step here is bounded, so a wedged engine costs at most
/// `grace + GROUP_TERM_GRACE + 2 * KILL_GRACE` and can never block app exit;
/// `grace` is a parameter purely so tests can exercise the fallback path
/// quickly.
///
/// Best-effort by nature. It only runs when this process gets to run code at
/// all: an explicit stop, or Tauri's `RunEvent::Exit`. A crash, a
/// `taskkill /F`, or an OS-forced logoff kills the app before any of this, and
/// `kill_on_drop` then kills the engine the same abrupt way — leaving MCP
/// grandchildren orphaned. There is no client-side fix for that.
pub async fn stop_engine(state: &AcpState, grace: Duration) -> Result<(), String> {
    let engine = state.inner.lock().await.take();
    *state.capabilities.lock().await = None;
    state.sessions.clear();
    let Some(mut engine) = engine else {
        return Ok(());
    };

    engine.bridge.close_stdin().await;
    if timeout(grace, engine.child.wait()).await.is_ok() {
        return Ok(());
    }
    if kill_process_tree(&engine.child).await
        && timeout(KILL_GRACE, engine.child.wait()).await.is_ok()
    {
        return Ok(());
    }
    // Bounded even here: `kill` awaits the reap, and a stop that cannot
    // complete must still return. `kill_on_drop` remains the final backstop.
    let _ = timeout(KILL_GRACE, engine.child.kill()).await;
    Ok(())
}

#[tauri::command]
pub async fn acp_stop(state: State<'_, AcpState>) -> Result<(), String> {
    stop_on(&state).await
}

#[cfg(test)]
mod tests {
    use super::{
        engine_path_override, install_dir_candidates, is_executable_file, load_session_params,
        new_session_params, parse_capabilities, resolve_from, should_ask_engine_for_sessions,
        strip_verbatim_prefix, version_at_least, AcpMcpPosture, AcpMcpServer,
        PacketcodeCapabilities, CLIENT_PROTOCOL_VERSION, ENGINE_BINARY_STEM,
        ENGINE_MCP_STARTUP_CEILING, ENGINE_PATH_ENV,
        GROUP_TERM_GRACE, KILL_GRACE, LEGACY_ENGINE_PATH_ENV, LOAD_TIMEOUT, NEW_SESSION_TIMEOUT,
        PERMISSION_MODES, REQUEST_TIMEOUT, SHUTDOWN_GRACE,
    };
    use serde_json::{json, Value};
    use std::path::PathBuf;

    fn modes(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn version_gate() {
        assert!(version_at_least("0.1.0", "0.1.0"));
        assert!(version_at_least("0.2.0", "0.1.0"));
        assert!(version_at_least("v1.0.0", "0.9.9"));
        assert!(version_at_least("0.1.1-dev", "0.1.0"));
        assert!(version_at_least("dev", "0.1.0"));
        assert!(!version_at_least("0.0.9", "0.1.0"));
        assert!(!version_at_least("garbage", "0.1.0"));
    }

    /// The UNC case is the one a naive four-character trim breaks: it turns an
    /// absolute network path into a relative one, which the engine would then
    /// resolve against its own cwd.
    #[test]
    fn verbatim_prefix_is_stripped_without_breaking_unc() {
        assert_eq!(strip_verbatim_prefix(r"\\?\D:\projects\app"), r"D:\projects\app");
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\app"),
            r"\\server\share\app"
        );
        // Already-plain paths pass through untouched, on every platform.
        assert_eq!(strip_verbatim_prefix(r"D:\projects\app"), r"D:\projects\app");
        assert_eq!(strip_verbatim_prefix("/home/u/app"), "/home/u/app");
        assert_eq!(strip_verbatim_prefix(r"\\server\share"), r"\\server\share");
    }

    #[test]
    fn session_new_budget_clears_the_engine_ceiling() {
        // The bug this encodes: session/new used the generic 30s budget, which
        // is EXACTLY the engine's own MCP-startup cap. Any session whose MCP
        // startup ran long therefore always lost the race — and the engine
        // then registered a live session the client had already abandoned.
        // The client budget must clear that ceiling with room for the
        // provider/registry/session-persist work layered on top of it.
        assert!(
            NEW_SESSION_TIMEOUT >= ENGINE_MCP_STARTUP_CEILING * 2,
            "session/new must comfortably outlast the engine's {ENGINE_MCP_STARTUP_CEILING:?} \
             MCP startup cap, got {NEW_SESSION_TIMEOUT:?}"
        );
        assert!(NEW_SESSION_TIMEOUT > REQUEST_TIMEOUT);
        // Still bounded below session/load, which replays a whole transcript.
        assert!(NEW_SESSION_TIMEOUT < LOAD_TIMEOUT);
    }

    #[test]
    fn shutdown_budget_is_bounded() {
        // A graceful stop runs on the app-exit path, so its worst case is
        // wall-clock the user waits for the window to go away: stdin close,
        // then at most one tree kill and one direct kill.
        let worst_case = SHUTDOWN_GRACE + GROUP_TERM_GRACE + KILL_GRACE * 2;
        assert!(
            worst_case <= super::Duration::from_secs(15),
            "a wedged engine would delay app exit by {worst_case:?}"
        );
        assert!(SHUTDOWN_GRACE > KILL_GRACE, "escalate, do not front-load");
    }

    #[test]
    fn session_params_omit_extension_when_unset() {
        let params = new_session_params("/w", None, None, None, &AcpMcpPosture::None);
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": [] }));
        // Blank-only overrides are treated as unset.
        let params = new_session_params(
            "/w",
            Some("  ".into()),
            None,
            Some("".into()),
            &AcpMcpPosture::None,
        );
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": [] }));
    }

    /// The DEFAULT posture is the safe one: a caller that supplies nothing at
    /// all gets an explicit empty list, so no `[mcp.<name>]` subprocess is
    /// started. This is the property that keeps every unported call site — and
    /// every future one — from silently turning MCP on.
    #[test]
    fn a_caller_that_supplies_no_posture_starts_no_servers() {
        let params = new_session_params("/w", None, None, None, &AcpMcpPosture::default());
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": [] }));
        let params = load_session_params("s-1", "/w", &AcpMcpPosture::default());
        assert_eq!(
            params,
            json!({ "sessionId": "s-1", "cwd": "/w", "mcpServers": [] })
        );
    }

    /// Each leg of the three-way `mcpServers` contract, as it lands in the
    /// actual `session/new` and `session/load` params.
    #[test]
    fn each_posture_produces_its_own_session_params() {
        // Inherit: the field is ABSENT — the only way to ask a capable engine
        // for its own configured fleet.
        let params = new_session_params(
            "/w",
            None,
            None,
            None,
            &AcpMcpPosture::InheritEngineDefaults,
        );
        assert_eq!(params, json!({ "cwd": "/w" }));
        assert!(params.get("mcpServers").is_none());
        let params = load_session_params("s-1", "/w", &AcpMcpPosture::InheritEngineDefaults);
        assert_eq!(params, json!({ "sessionId": "s-1", "cwd": "/w" }));

        // None: an explicit empty list, on both calls.
        let params = new_session_params("/w", None, None, None, &AcpMcpPosture::None);
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": [] }));
        let params = load_session_params("s-1", "/w", &AcpMcpPosture::None);
        assert_eq!(
            params,
            json!({ "sessionId": "s-1", "cwd": "/w", "mcpServers": [] })
        );

        // Explicit: exactly this fleet, in the shape packetcode parses.
        let explicit = AcpMcpPosture::Explicit(vec![AcpMcpServer {
            name: "github".into(),
            command: "/opt/gh-mcp".into(),
            args: vec!["serve".into()],
            env: Default::default(),
        }]);
        let expected = json!([{
            "type": "stdio",
            "name": "github",
            "command": "/opt/gh-mcp",
            "args": ["serve"],
            "env": [],
        }]);
        let params = new_session_params("/w", None, None, None, &explicit);
        assert_eq!(params, json!({ "cwd": "/w", "mcpServers": expected }));
        let params = load_session_params("s-1", "/w", &explicit);
        assert_eq!(
            params,
            json!({ "sessionId": "s-1", "cwd": "/w", "mcpServers": expected })
        );
    }

    #[test]
    fn session_params_carry_packetcode_overrides() {
        let params = new_session_params(
            "/w",
            Some("anthropic".into()),
            Some("claude-fable-5".into()),
            Some("accept-edits".into()),
            &AcpMcpPosture::None,
        );
        assert_eq!(
            params["_packetcode"],
            json!({
                "provider": "anthropic",
                "model": "claude-fable-5",
                "permissionMode": "accept-edits",
            })
        );
        // A mode alone still rides the extension object.
        let params =
            new_session_params("/w", None, None, Some("bypass".into()), &AcpMcpPosture::None);
        assert_eq!(params["_packetcode"], json!({ "permissionMode": "bypass" }));
    }

    #[test]
    fn capabilities_from_modern_engine() {
        // A current engine started under a "read-only" ceiling: the vendor
        // block is present, so its flags are authoritative and the advertised
        // mode list is exactly what session/new will accept.
        let caps = parse_capabilities(&json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": false },
                "mcpCapabilities": { "http": false },
                // Advertised the spec's way: "{}" means supported.
                "sessionCapabilities": { "close": {} },
                "_packetcode": {
                    "sessionsList": true,
                    "sessionsRename": true,
                    "sessionsUsage": true,
                    "modelsList": false,
                    "commandsList": true,
                    "projectFiles": false,
                    "mcpList": true,
                    "mcpDefaults": true,
                    "permissionModes": ["ask", "read-only"],
                    "defaultPermissionMode": "read-only",
                    "somethingNewerThanThisClient": 7
                }
            },
            "agentInfo": { "name": "packetcode", "version": "0.2.0" },
            "authMethods": []
        }));
        assert_eq!(caps.protocol_version, 1);
        assert!(caps.load_session);
        assert!(caps.session_close);
        assert!(caps.packetcode.advertised);
        assert!(caps.packetcode.sessions_list);
        assert!(caps.packetcode.sessions_rename);
        assert!(caps.packetcode.sessions_usage);
        assert!(!caps.packetcode.models_list);
        // Said yes and said no are both the engine SAYING something, and must
        // arrive as such rather than collapsing into the `advertised` proxy.
        assert_eq!(caps.packetcode.commands_list, Some(true));
        assert_eq!(caps.packetcode.project_files, Some(false));
        assert!(caps.packetcode.mcp_list);
        assert!(caps.packetcode.mcp_defaults);
        assert_eq!(caps.packetcode.permission_modes, modes(&["ask", "read-only"]));
        assert_eq!(
            caps.packetcode.default_permission_mode.as_deref(),
            Some("read-only")
        );
    }

    /// The verbatim `initialize` result of packetcode v0.5.1-90-g1377d4f,
    /// captured from the real engine over stdio. A fixture rather than a
    /// hand-written approximation: the point is to fail if this client ever
    /// stops reading what the shipping engine actually sends.
    #[test]
    fn capabilities_from_the_real_engine_handshake() {
        let caps = parse_capabilities(&json!({
            "agentCapabilities": {
                "_packetcode": {
                    "commandsList": true,
                    "defaultPermissionMode": "ask",
                    "mcpDefaults": true,
                    "mcpList": true,
                    "modelsList": true,
                    "permissionModes": ["ask", "read-only"],
                    "projectFiles": true,
                    "sessionsList": true,
                    "sessionsRename": true,
                    "sessionsUsage": true
                },
                "loadSession": true,
                "mcpCapabilities": { "http": false, "sse": false },
                "promptCapabilities": { "audio": false, "embeddedContext": false, "image": false },
                "sessionCapabilities": { "close": {} }
            },
            "agentInfo": {
                "name": "packetcode",
                "title": "PacketCode",
                "version": "v0.5.1-90-g1377d4f"
            },
            "authMethods": [],
            "protocolVersion": 1
        }));

        assert_eq!(caps.protocol_version, CLIENT_PROTOCOL_VERSION);
        assert!(caps.load_session);
        assert!(caps.session_close);
        assert!(caps.packetcode.advertised);
        assert!(caps.packetcode.sessions_list);
        assert!(caps.packetcode.sessions_rename);
        assert!(caps.packetcode.sessions_usage);
        assert!(caps.packetcode.models_list);
        assert!(caps.packetcode.mcp_list);
        assert!(caps.packetcode.mcp_defaults);
        assert_eq!(caps.packetcode.commands_list, Some(true));
        assert_eq!(caps.packetcode.project_files, Some(true));
        // The operator's ceiling, NOT the five-mode fallback: this engine
        // answers -32602 for anything above "ask", so `resolve_permission_mode`
        // has to see exactly these two.
        assert_eq!(caps.packetcode.permission_modes, modes(&["ask", "read-only"]));
        assert_eq!(caps.packetcode.default_permission_mode.as_deref(), Some("ask"));
    }

    #[test]
    fn flags_added_after_the_vendor_block_stay_unknown_when_unsent() {
        // An engine that advertised `_packetcode` before `commandsList` and
        // `projectFiles` existed. Absent must read as "did not say" so the
        // caller keeps using `advertised` as the proxy — reading it as "no"
        // would hide a "/" and "@" menu that work perfectly well.
        let caps = parse_capabilities(&json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "_packetcode": { "sessionsList": true, "modelsList": true }
            }
        }));
        assert!(caps.packetcode.advertised);
        assert_eq!(caps.packetcode.commands_list, None);
        assert_eq!(caps.packetcode.project_files, None);
    }

    #[test]
    fn capabilities_from_pre_capability_engine() {
        // An engine that predates the vendor block: nothing is advertised, so
        // every extension flag stays false (the call-time -32601 fallbacks
        // still apply) and all five permission modes remain on offer.
        let caps = parse_capabilities(&json!({
            "protocolVersion": 1,
            "agentCapabilities": { "loadSession": true },
            "agentInfo": { "name": "packetcode", "version": "0.1.0" }
        }));
        assert!(caps.load_session);
        // No sessionCapabilities block at all: the engine cannot release
        // sessions, so eviction frees only this client's copy.
        assert!(!caps.session_close);
        assert!(!caps.packetcode.advertised);
        assert!(!caps.packetcode.sessions_list);
        assert!(!caps.packetcode.sessions_rename);
        assert!(!caps.packetcode.sessions_usage);
        assert!(!caps.packetcode.models_list);
        // No promise, no omission: the client must keep sending mcpServers: []
        // to this engine, so it can never inherit a configured fleet.
        assert!(!caps.packetcode.mcp_list);
        assert!(!caps.packetcode.mcp_defaults);
        assert_eq!(caps.packetcode.permission_modes, modes(&PERMISSION_MODES));
        assert_eq!(caps.packetcode.default_permission_mode, None);
        // Identical to the state used before the handshake completes.
        assert_eq!(caps.packetcode, PacketcodeCapabilities::default());
    }

    #[test]
    fn sessions_list_is_asked_for_unless_the_engine_disowned_it() {
        // Advertised absent: never call, so an engine free to answer with any
        // error it likes cannot cost the sidebar its disk fallback.
        let mut caps = PacketcodeCapabilities {
            advertised: true,
            sessions_list: false,
            ..PacketcodeCapabilities::default()
        };
        assert!(!should_ask_engine_for_sessions(&caps));
        // Advertised present: ask.
        caps.sessions_list = true;
        assert!(should_ask_engine_for_sessions(&caps));
        // Advertised nothing (older engine, or another agent entirely): ask,
        // and let the -32601 fallback decide — the flags carry no information.
        assert!(should_ask_engine_for_sessions(
            &PacketcodeCapabilities::default()
        ));
    }

    #[test]
    fn capabilities_from_garbage_are_conservative() {
        for garbage in [
            Value::Null,
            json!("not an object"),
            json!({}),
            json!({ "agentCapabilities": 42 }),
            json!({ "agentCapabilities": { "loadSession": "yes", "_packetcode": [] } }),
        ] {
            let caps = parse_capabilities(&garbage);
            assert_eq!(caps.protocol_version, 1, "for {garbage}");
            assert!(!caps.load_session, "for {garbage}");
            assert!(!caps.session_close, "for {garbage}");
            assert!(!caps.packetcode.advertised, "for {garbage}");
            assert_eq!(
                caps.packetcode.permission_modes,
                modes(&PERMISSION_MODES),
                "for {garbage}"
            );
        }

        // Vendor block present but its contents are unusable: the block still
        // counts as advertised (so the flags are authoritative and default to
        // false), while an empty/garbage mode list falls back to all five and
        // a default outside the advertised set is dropped.
        let caps = parse_capabilities(&json!({
            "agentCapabilities": {
                "_packetcode": {
                    "sessionsList": "true",
                    "permissionModes": [1, null, "  ", "ask", "ask"],
                    "defaultPermissionMode": "bypass"
                }
            }
        }));
        assert!(caps.packetcode.advertised);
        assert!(!caps.packetcode.sessions_list);
        assert_eq!(caps.packetcode.permission_modes, modes(&["ask"]));
        assert_eq!(caps.packetcode.default_permission_mode, None);

        let caps = parse_capabilities(&json!({
            "agentCapabilities": { "_packetcode": { "permissionModes": [] } }
        }));
        assert_eq!(caps.packetcode.permission_modes, modes(&PERMISSION_MODES));

        // sessionCapabilities.close is object-shaped. Only "{}" (or an object
        // with fields, since the type is open) counts; a block that omits it,
        // nulls it, or sends the boolean an ACP-naive engine might guess at is
        // not the spec's shape and must not be read as support.
        for absent in [
            json!({}),
            json!({ "close": null }),
            json!({ "close": true }),
            json!({ "close": "yes" }),
        ] {
            let caps = parse_capabilities(
                &json!({ "agentCapabilities": { "sessionCapabilities": absent } }),
            );
            assert!(!caps.session_close, "for {absent}");
        }
        let caps = parse_capabilities(
            &json!({ "agentCapabilities": { "sessionCapabilities": { "close": {} } } }),
        );
        assert!(caps.session_close);
    }
    // ---------------------------------------------------------------- //
    // Engine resolution                                                //
    // ---------------------------------------------------------------- //

    /// The precedence contract, on every platform: an explicit override beats
    /// everything, PATH beats the documented install dirs, and a resolution
    /// that finds nothing degrades to the bare name rather than to an empty
    /// string (which would spawn nothing at all).
    ///
    /// Also pins the laziness: a tier that already has its answer must not run
    /// the filesystem searches below it.
    #[test]
    fn resolution_precedence_is_override_then_path_then_install_dir() {
        use std::cell::Cell;
        let path_hit = PathBuf::from("/from/path/packetcode");
        let installed = PathBuf::from("/from/install/packetcode");
        let searched = Cell::new(0u32);
        let hit = || {
            searched.set(searched.get() + 1);
            Some(path_hit.clone())
        };
        let dir = || Some(installed.clone());

        assert_eq!(
            resolve_from(Some("/explicit/engine".into()), hit, dir),
            "/explicit/engine"
        );
        assert_eq!(searched.get(), 0, "an override must not trigger a PATH walk");

        assert_eq!(
            resolve_from(None, hit, dir),
            path_hit.to_string_lossy()
        );
        assert_eq!(searched.get(), 1);

        assert_eq!(
            resolve_from(None, || None, dir),
            installed.to_string_lossy()
        );
        assert_eq!(resolve_from(None, || None, || None), ENGINE_BINARY_STEM);
    }

    /// The override is read identically on every platform — it used to be the
    /// only tier a non-Windows install could rely on, and it is still the
    /// escape hatch for an engine installed somewhere undocumented.
    ///
    /// Serialised against the other env-touching test: `set_var` is
    /// process-global and the test harness is threaded.
    #[test]
    fn engine_path_override_reads_both_env_names_on_every_platform() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = EnvRestore::capture(&[ENGINE_PATH_ENV, LEGACY_ENGINE_PATH_ENV]);

        std::env::remove_var(ENGINE_PATH_ENV);
        std::env::remove_var(LEGACY_ENGINE_PATH_ENV);
        assert_eq!(engine_path_override(), None);

        // The legacy name still works on its own, for developers who have it
        // exported from the standalone GUI prototype.
        std::env::set_var(LEGACY_ENGINE_PATH_ENV, "/legacy/packetcode");
        assert_eq!(
            engine_path_override().as_deref(),
            Some("/legacy/packetcode")
        );

        // The current name wins when both are set.
        std::env::set_var(ENGINE_PATH_ENV, "/current/packetcode");
        assert_eq!(
            engine_path_override().as_deref(),
            Some("/current/packetcode")
        );

        // Blank and whitespace-only are "unset", not "spawn the empty string";
        // an exported-but-empty var must fall through to PATH.
        std::env::set_var(ENGINE_PATH_ENV, "   ");
        std::env::remove_var(LEGACY_ENGINE_PATH_ENV);
        assert_eq!(engine_path_override(), None);

        // Surrounding whitespace is trimmed off an otherwise usable path.
        std::env::set_var(ENGINE_PATH_ENV, "  /padded/packetcode \t");
        assert_eq!(
            engine_path_override().as_deref(),
            Some("/padded/packetcode")
        );

        drop(restore);
    }

    /// Every candidate is a documented location from the packetcode repo. The
    /// Unix expectations are compiled and asserted on Windows too (the list is
    /// a pure function, and `cfg!` picks the arm), so this machine still
    /// encodes what macOS and Linux must do.
    #[test]
    fn install_dir_candidates_match_the_documented_locations() {
        let candidates = install_dir_candidates(Some("/home/u"), Some(r"C:\Users\u\AppData\Local"));
        let rendered: Vec<String> = candidates
            .iter()
            .map(|c| c.to_string_lossy().replace('\\', "/"))
            .collect();

        if cfg!(windows) {
            // install.ps1: `$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\PacketCode\bin"`.
            assert_eq!(
                rendered,
                vec!["C:/Users/u/AppData/Local/Programs/PacketCode/bin/packetcode.exe"]
            );
        } else {
            // install.sh's sudo-free variant first (it is the one most likely
            // to be off PATH, and the one PacketBench's own installer targets),
            // then install.sh's own INSTALL_DIR default.
            assert_eq!(
                rendered,
                vec!["/home/u/.local/bin/packetcode", "/usr/local/bin/packetcode"]
            );
        }
    }

    /// A missing HOME/LOCALAPPDATA must not synthesise a nonsense path such as
    /// `/.local/bin` or `Programs\PacketCode\...` relative to the cwd.
    #[test]
    fn install_dir_candidates_skip_unset_home_variables() {
        for absent in [None, Some(""), Some("   ")] {
            let candidates = install_dir_candidates(absent, absent);
            if cfg!(windows) {
                assert!(candidates.is_empty(), "for {absent:?}");
            } else {
                // The system-wide location needs no environment at all, so it
                // survives; only the $HOME-derived one drops out.
                assert_eq!(
                    candidates,
                    vec![PathBuf::from("/usr/local/bin/packetcode")],
                    "for {absent:?}"
                );
            }
        }
    }

    /// A directory is never an engine, and a nonexistent path is never an
    /// engine. On Unix a file without an executable bit is not one either —
    /// that arm is what the old `is_file()` check got wrong.
    #[test]
    fn executable_check_rejects_directories_and_missing_paths() {
        let dir = std::env::temp_dir();
        assert!(!is_executable_file(&dir));
        assert!(!is_executable_file(&dir.join("packetbench-no-such-engine-9f3c1a")));
    }

    #[cfg(unix)]
    #[test]
    fn executable_check_requires_the_executable_bit_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("packetbench-acp-exec-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("packetcode");
        std::fs::write(&file, b"#!/bin/sh\nexit 0\n").expect("write probe file");

        // A plain readable file is NOT an engine: resolving it would produce a
        // path that fails at spawn with EACCES.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644))
            .expect("chmod 0644");
        assert!(!is_executable_file(&file));

        // What `install -m 0755` leaves behind.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
            .expect("chmod 0755");
        assert!(is_executable_file(&file));

        // Group- and other-only bits count too: which one applies depends on
        // the file's ownership, which this process cannot assume.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o011))
            .expect("chmod 0011");
        assert!(is_executable_file(&file));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Windows resolves executability by extension, so PATHEXT is the analogue
    /// of the executable bit and an extensionless file must not match.
    #[cfg(windows)]
    #[test]
    fn path_search_honours_pathext_on_windows() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = EnvRestore::capture(&["PATH", "PATHEXT"]);

        let dir = std::env::temp_dir().join("packetbench-acp-pathext-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create probe dir");
        // Extensionless: present, but not executable on Windows.
        std::fs::write(dir.join(ENGINE_BINARY_STEM), b"not an exe").expect("write bare");

        std::env::set_var("PATH", &dir);
        std::env::set_var("PATHEXT", ".COM;.EXE;.BAT;.CMD");
        assert_eq!(super::path_search(ENGINE_BINARY_STEM), None);

        let exe = dir.join("packetcode.exe");
        std::fs::write(&exe, b"MZ").expect("write exe");
        assert_eq!(super::path_search(ENGINE_BINARY_STEM), Some(exe));

        let _ = std::fs::remove_dir_all(&dir);
        drop(restore);
    }

    /// Serialises the tests that mutate process-global environment variables.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Snapshots environment variables and puts them back on drop, so a test
    /// that fails mid-way cannot leak state into the rest of the suite.
    struct EnvRestore(Vec<(String, Option<String>)>);

    impl EnvRestore {
        fn capture(names: &[&str]) -> Self {
            Self(
                names
                    .iter()
                    .map(|n| ((*n).to_string(), std::env::var(n).ok()))
                    .collect(),
            )
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                match value {
                    Some(v) => std::env::set_var(name, v),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}
