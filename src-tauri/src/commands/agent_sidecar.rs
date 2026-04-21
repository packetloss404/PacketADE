//! Node sidecar process supervisor.
//!
//! Spawns and maintains a long-lived `node agent-sidecar/dist/index.js` child
//! process, speaks a newline-delimited JSON protocol over stdin/stdout, and
//! translates sidecar events into the `api-agent:*` Tauri events the frontend
//! already listens on (see `api_agent.rs` for the existing shapes that this
//! supervisor must mirror exactly — the frontend cannot tell which backend
//! produced the event).
//!
//! Slice B of the SDK-sidecar plan: plumbing only. Slice C (the routing layer
//! in `api_agent.rs`) calls the `forward_*` methods exposed here; no Tauri
//! commands are registered from this module.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

use super::shared::hide_window_async;

/// Providers whose sessions are routed through the Node sidecar rather than
/// the in-process Rust runtime. Keep in sync with slice C's dispatch logic.
pub const SIDECAR_PROVIDERS: &[&str] = &["claude-oauth", "openai-codex", "echo"];

/// Convenience predicate used by slice C to decide whether to call
/// `forward_*` vs. the existing Rust path.
pub fn is_sidecar_provider(provider: &str) -> bool {
    SIDECAR_PROVIDERS.contains(&provider)
}

/// Maximum sidecar restarts allowed within `RESTART_WINDOW`.
const MAX_RESTARTS_IN_WINDOW: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Event name helpers — must match `api_agent.rs` exactly.
// ---------------------------------------------------------------------------

fn chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
fn tool_start_event(session_id: &str) -> String {
    format!("api-agent:tool-start:{}", session_id)
}
fn tool_result_event(session_id: &str) -> String {
    format!("api-agent:tool-result:{}", session_id)
}
fn done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
fn error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}
fn thinking_event(session_id: &str) -> String {
    format!("api-agent:thinking:{}", session_id)
}
fn thinking_stop_event(session_id: &str) -> String {
    format!("api-agent:thinking-stop:{}", session_id)
}
fn permission_request_event(session_id: &str) -> String {
    format!("api-agent:permission-request:{}", session_id)
}
fn pending_edit_event(session_id: &str) -> String {
    format!("api-agent:pending-edit:{}", session_id)
}

// ---------------------------------------------------------------------------
// Event payload shapes — must match `api_agent.rs` exactly so the frontend
// listeners in `agentTaskStore.ts` can't tell which backend emitted the event.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct ToolStartPayload {
    id: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct ToolResultPayload {
    id: String,
    name: String,
    content: String,
    is_error: bool,
    input: String,
}

#[derive(Clone, Serialize)]
struct ThinkingPayload {
    text: String,
}

#[derive(Clone, Serialize)]
struct PermissionRequestPayload {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Serialize)]
struct PendingEditPayload {
    id: String,
    path: String,
    content: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

// ---------------------------------------------------------------------------
// SidecarManager — owns the child process, stdin writer channel, and the set
// of sidecar-owned sessions.
// ---------------------------------------------------------------------------

pub struct SidecarManager {
    app_handle: AppHandle,
    /// Absolute path to the sidecar's `dist/index.js` entrypoint.
    sidecar_path: PathBuf,
    /// Sender for JSON lines destined for the sidecar's stdin.
    /// Held inside a Mutex so the writer can be swapped on respawn.
    writer_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Sessions we've started and not yet closed. Used by slice C's
    /// `owns_session()` check and to fan-out sidecar-crash errors.
    owned_sessions: Arc<Mutex<HashSet<String>>>,
}

impl SidecarManager {
    /// Construct the manager, spawn the child, and start the IO tasks.
    /// Safe to call during `.setup()`; the child is spawned asynchronously.
    pub async fn new(app_handle: AppHandle) -> Arc<Self> {
        let sidecar_path = resolve_sidecar_path(&app_handle);
        let manager = Arc::new(Self {
            app_handle,
            sidecar_path,
            writer_tx: Mutex::new(None),
            owned_sessions: Arc::new(Mutex::new(HashSet::new())),
        });

        // Spawn the child + reader/writer tasks in the background. If the
        // initial spawn fails we log and continue — the frontend won't notice
        // until someone actually tries to use a sidecar provider.
        let mgr = Arc::clone(&manager);
        tokio::spawn(async move {
            mgr.spawn_and_supervise().await;
        });

        manager
    }

    /// Check whether a session id was started via this supervisor. Slice C
    /// uses this to pick between the sidecar and the in-process runtime on
    /// `send_message` / `cancel` / `close` after the fact.
    pub fn owns_session(&self, session_id: &str) -> bool {
        // Uses blocking lock — the `Mutex` here is `tokio::sync::Mutex` which
        // doesn't have `try_lock` semantics that work from sync code, so this
        // is an async-aware lock; we expose a blocking-looking API by running
        // the lock in a block_on. Callers in slice C should prefer calling
        // from async contexts (which is true for Tauri commands).
        match self.owned_sessions.try_lock() {
            Ok(guard) => guard.contains(session_id),
            // If we can't grab the lock right now, assume not-owned rather
            // than blocking the caller; slice C will fall through to the
            // Rust runtime which will error cleanly if the session doesn't
            // exist there either.
            Err(_) => false,
        }
    }

    /// Forward a start_session request to the sidecar.
    pub async fn forward_start(
        &self,
        session_id: String,
        provider: String,
        model: String,
        system_prompt: String,
        allowed_tools: Vec<String>,
        mcp_servers: Value,
        project_path: String,
        initial_message: String,
        resume: Option<String>,
        thinking_enabled: Option<bool>,
        plan_mode: Option<bool>,
    ) -> Result<(), String> {
        {
            let mut sessions = self.owned_sessions.lock().await;
            sessions.insert(session_id.clone());
        }
        let req = json!({
            "type": "start_session",
            "sessionId": session_id,
            "provider": provider,
            "model": model,
            "systemPrompt": system_prompt,
            "allowedTools": allowed_tools,
            "mcpServers": mcp_servers,
            "projectPath": project_path,
            "initialMessage": initial_message,
            "resume": resume,
            "thinkingEnabled": thinking_enabled,
            "planMode": plan_mode,
        });
        self.send_json(req).await
    }

    /// Forward a send_message request for an existing sidecar session.
    pub async fn forward_send(
        &self,
        session_id: String,
        content: String,
        attachments: Value,
    ) -> Result<(), String> {
        let req = json!({
            "type": "send_message",
            "sessionId": session_id,
            "content": content,
            "attachments": attachments,
        });
        self.send_json(req).await
    }

    /// Forward a permission decision to the sidecar.
    pub async fn forward_permission(
        &self,
        session_id: String,
        tool_use_id: String,
        decision: String,
    ) -> Result<(), String> {
        let req = json!({
            "type": "permission_response",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "decision": decision,
        });
        self.send_json(req).await
    }

    /// Forward a pending-edit approval/rejection to the sidecar.
    pub async fn forward_edit(
        &self,
        session_id: String,
        approved: bool,
    ) -> Result<(), String> {
        let req = json!({
            "type": "edit_response",
            "sessionId": session_id,
            "approved": approved,
        });
        self.send_json(req).await
    }

    /// Forward a cancel request to the sidecar. Does not remove the session
    /// from `owned_sessions` — the sidecar should emit `done` or `error`
    /// which will clean up.
    pub async fn forward_cancel(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "cancel",
            "sessionId": session_id,
        });
        self.send_json(req).await
    }

    /// Forward a close request and remove from owned sessions.
    pub async fn forward_close(&self, session_id: String) -> Result<(), String> {
        let req = json!({
            "type": "close_session",
            "sessionId": session_id,
        });
        let result = self.send_json(req).await;
        {
            let mut sessions = self.owned_sessions.lock().await;
            sessions.remove(&session_id);
        }
        result
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// Serialize `value` as a JSON line and push it onto the writer channel.
    async fn send_json(&self, value: Value) -> Result<(), String> {
        let line = serde_json::to_string(&value)
            .map_err(|e| format!("serialize sidecar request: {}", e))?;
        let tx = {
            let guard = self.writer_tx.lock().await;
            guard.clone()
        };
        let tx = tx.ok_or_else(|| "sidecar writer not initialized".to_string())?;
        tx.send(line)
            .map_err(|_| "sidecar writer channel closed".to_string())?;
        Ok(())
    }

    /// Spawn-and-supervise loop. Runs the child, then restarts it if it dies,
    /// subject to the rate limit. If the rate limit is exceeded we fan-out
    /// errors to all owned sessions and stop trying.
    async fn spawn_and_supervise(self: Arc<Self>) {
        let mut restart_times: Vec<Instant> = Vec::new();

        loop {
            match self.spawn_child().await {
                Ok(()) => {
                    // spawn_child returned because the child exited cleanly or
                    // died. Fall through to restart logic.
                    warn!("agent sidecar exited — considering restart");
                }
                Err(e) => {
                    error!(error = %e, "failed to spawn agent sidecar");
                }
            }

            // Prune restart times outside the window, then check the rate limit.
            let now = Instant::now();
            restart_times.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
            if restart_times.len() >= MAX_RESTARTS_IN_WINDOW {
                error!(
                    "agent sidecar exceeded {} restarts in {:?}; giving up",
                    MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW
                );
                self.fan_out_crash_error().await;
                // Clear the writer channel so future forward_* calls fail fast
                // with a clear error.
                let mut guard = self.writer_tx.lock().await;
                *guard = None;
                return;
            }
            restart_times.push(now);

            // Small backoff before retry.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Spawn the Node child and drive IO until it exits. Returns Ok when the
    /// child is gone (so the supervisor can decide whether to restart).
    ///
    /// Dispatches to one of two spawn strategies:
    /// - Tokio `tokio::process::Command` when a system `node` / explicit
    ///   `PACKETADE_NODE_PATH` should be used (dev default, or anywhere the
    ///   env override is set).
    /// - Tauri shell plugin's sidecar API (`app.shell().sidecar("node")`) in
    ///   release, so the bundled Node binary is used.
    async fn spawn_child(self: &Arc<Self>) -> Result<(), String> {
        if !self.sidecar_path.exists() {
            return Err(format!(
                "sidecar entry not found at {} — reinstall the app or set PACKETADE_SIDECAR_PATH",
                self.sidecar_path.display()
            ));
        }

        if let Some(node_path) = resolved_node_override() {
            // Explicit override — always use tokio::process with that exe.
            self.spawn_via_tokio(Some(node_path)).await
        } else if cfg!(debug_assertions) {
            // Dev: system `node` on PATH.
            self.spawn_via_tokio(None).await
        } else {
            // Release: Tauri-bundled Node via the shell plugin sidecar API.
            self.spawn_via_shell_sidecar().await
        }
    }

    /// Spawn the sidecar via `tokio::process::Command`. Used in dev and when
    /// `PACKETADE_NODE_PATH` is set.
    async fn spawn_via_tokio(
        self: &Arc<Self>,
        node_override: Option<PathBuf>,
    ) -> Result<(), String> {
        let node_exe: PathBuf = node_override.unwrap_or_else(|| PathBuf::from("node"));
        let mut cmd = Command::new(&node_exe);
        cmd.arg(&self.sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr inherits so sidecar logs reach the terminal / log
            // aggregator without us having to relay them.
            .stderr(Stdio::inherit());
        hide_window_async(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "spawn node sidecar (node={}, entry={}): {}",
                node_exe.display(),
                self.sidecar_path.display(),
                e
            )
        })?;

        let child_pid = child.id();
        info!(
            pid = ?child_pid,
            node = %node_exe.display(),
            path = %self.sidecar_path.display(),
            strategy = "tokio",
            "agent sidecar spawned"
        );

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin was not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar stdout was not piped".to_string())?;

        // Writer task: pull lines from an mpsc channel, append '\n', write.
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<String>();
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = Some(writer_tx);
        }
        let writer_handle = tokio::spawn(writer_loop(stdin, writer_rx));

        // Reader task: buffered line reader, parse JSON, emit events.
        let reader_mgr = Arc::clone(self);
        let reader_handle = tokio::spawn(async move {
            reader_mgr.reader_loop(stdout).await;
        });

        // Wait for the child to exit.
        let status = match child.wait().await {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "agent sidecar wait() failed");
                // Kill the IO tasks by dropping the writer channel.
                let mut guard = self.writer_tx.lock().await;
                *guard = None;
                return Ok(());
            }
        };

        warn!(?status, pid = ?child_pid, "agent sidecar exited");

        // Drop the writer channel so the writer task winds down.
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = None;
        }

        // Reader task will end on its own once stdout hits EOF.
        let _ = reader_handle.await;
        let _ = writer_handle.await;

        Ok(())
    }

    /// Spawn the sidecar via the Tauri shell plugin's sidecar API, which
    /// resolves `node` to the app-bundled binary declared in
    /// `tauri.conf.json > bundle.externalBin` (see slice B). Used in release.
    async fn spawn_via_shell_sidecar(self: &Arc<Self>) -> Result<(), String> {
        let command = self
            .app_handle
            .shell()
            .sidecar("node")
            .map_err(|e| format!("resolve bundled node sidecar: {}", e))?
            .arg(&self.sidecar_path);

        let (mut rx, mut child) = command
            .spawn()
            .map_err(|e| format!("spawn bundled node sidecar: {}", e))?;

        let child_pid = child.pid();
        info!(
            pid = child_pid,
            path = %self.sidecar_path.display(),
            strategy = "shell-sidecar",
            "agent sidecar spawned"
        );

        // Writer task: pull lines from an mpsc channel, append '\n', write
        // them via `CommandChild::write`. The shell plugin's CommandChild does
        // not expose a raw `ChildStdin`; it wraps a synchronous PipeWriter.
        // We move the child into the writer task so it can be mutated there;
        // to let the reader still observe terminate-on-exit, we use the
        // Terminated event from the event channel rather than `child.wait()`.
        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<String>();
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = Some(writer_tx);
        }

        let writer_handle = tokio::spawn(async move {
            while let Some(line) = writer_rx.recv().await {
                let mut buf = line.into_bytes();
                buf.push(b'\n');
                if let Err(e) = child.write(&buf) {
                    warn!(error = %e, "agent sidecar stdin write failed");
                    break;
                }
            }
            // Channel closed — try to kill the child so the reader task can
            // observe termination and return.
            let _ = child.kill();
        });

        // Reader task: pump events from the shell plugin channel into the
        // same `handle_event` / stderr logging pipeline as the tokio path.
        let reader_mgr = Arc::clone(self);
        let reader_handle = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        // The shell plugin delivers already line-split bytes
                        // (one event per newline) when raw_out is false.
                        let line = String::from_utf8_lossy(&bytes);
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => reader_mgr.handle_event(value).await,
                            Err(e) => {
                                warn!(
                                    error = %e,
                                    line = %truncate(trimmed, 500),
                                    "agent sidecar emitted malformed JSON"
                                );
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        // Mirror the tokio path's `Stdio::inherit()` behavior
                        // by surfacing stderr to our tracing sink. The shell
                        // plugin forces stderr to be piped, so we must drain.
                        let line = String::from_utf8_lossy(&bytes);
                        let trimmed = line.trim_end();
                        if !trimmed.is_empty() {
                            warn!(target: "agent_sidecar::stderr", "{}", trimmed);
                        }
                    }
                    CommandEvent::Error(e) => {
                        warn!(error = %e, "agent sidecar shell command error");
                    }
                    CommandEvent::Terminated(payload) => {
                        warn!(
                            code = ?payload.code,
                            signal = ?payload.signal,
                            pid = child_pid,
                            "agent sidecar exited"
                        );
                        break;
                    }
                    _ => {}
                }
            }
        });

        // The reader task returns when the sidecar terminates; once that
        // happens we drop the writer channel so the writer task joins and
        // the supervisor can decide whether to restart.
        let _ = reader_handle.await;
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = None;
        }
        let _ = writer_handle.await;

        Ok(())
    }

    /// Consume lines from the sidecar's stdout, parse each as JSON, and emit
    /// the corresponding `api-agent:*` event.
    async fn reader_loop(self: Arc<Self>, stdout: tokio::process::ChildStdout) {
        let mut reader = BufReader::new(stdout).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => self.handle_event(value).await,
                        Err(e) => {
                            warn!(
                                error = %e,
                                line = %truncate(&line, 500),
                                "agent sidecar emitted malformed JSON"
                            );
                        }
                    }
                }
                Ok(None) => {
                    // EOF on stdout — the child has closed its side.
                    break;
                }
                Err(e) => {
                    warn!(error = %e, "agent sidecar stdout read error");
                    break;
                }
            }
        }
    }

    /// Translate a parsed sidecar event into a Tauri event.
    async fn handle_event(&self, value: Value) {
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let session_id = value
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        match event_type {
            "ready" => {
                let pid = value.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                info!(pid, "agent sidecar reported ready");
                // No frontend propagation — this is a plumbing signal.
            }
            "chunk" => {
                // Match `api_agent.rs` exactly: the frontend listens with
                // `listen<string>`, so the payload is the raw text string —
                // not an object wrapper.
                let text = value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self.app_handle.emit(&chunk_event(&session_id), text);
            }
            "thinking" => {
                let text = value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self
                    .app_handle
                    .emit(&thinking_event(&session_id), ThinkingPayload { text });
            }
            "thinking_stop" => {
                let _ = self.app_handle.emit(&thinking_stop_event(&session_id), ());
            }
            "tool_start" => {
                // Sidecar uses `toolUseId`; frontend expects `id`. Translate.
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self.app_handle.emit(
                    &tool_start_event(&session_id),
                    ToolStartPayload { id, name },
                );
            }
            "tool_result" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // The sidecar may or may not echo the tool name / input back
                // on the result. Fall back to empty string; the frontend
                // treats them as display metadata only.
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let output = value.get("output");
                let content = match output {
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => serde_json::to_string(v).unwrap_or_default(),
                    None => String::new(),
                };
                let is_error = value
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let input = value
                    .get("input")
                    .map(|v| serde_json::to_string(v).unwrap_or_default())
                    .unwrap_or_default();
                let _ = self.app_handle.emit(
                    &tool_result_event(&session_id),
                    ToolResultPayload {
                        id,
                        name,
                        content,
                        is_error,
                        input,
                    },
                );
            }
            "permission_request" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = value
                    .get("input")
                    .or_else(|| value.get("arguments"))
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => serde_json::to_string(other).unwrap_or_default(),
                    })
                    .unwrap_or_default();
                let _ = self.app_handle.emit(
                    &permission_request_event(&session_id),
                    PermissionRequestPayload { id, name, arguments },
                );
            }
            "pending_edit" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let path = value
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let content = value
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = self.app_handle.emit(
                    &pending_edit_event(&session_id),
                    PendingEditPayload { id, path, content },
                );
            }
            "done" => {
                let input_tokens = value
                    .get("inputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = value
                    .get("outputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read_input_tokens = value
                    .get("cacheReadInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation_input_tokens = value
                    .get("cacheCreationInputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let _ = self.app_handle.emit(
                    &done_event(&session_id),
                    DonePayload {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                    },
                );
                // Session is finished — drop it from the owned set. (Session
                // configs can still be resumed via `forward_start` with a
                // resume token; that will re-insert it.)
                let mut sessions = self.owned_sessions.lock().await;
                sessions.remove(&session_id);
            }
            "error" => {
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown sidecar error")
                    .to_string();
                let _ = self.app_handle.emit(
                    &error_event(&session_id),
                    ErrorPayload { message },
                );
                let mut sessions = self.owned_sessions.lock().await;
                sessions.remove(&session_id);
            }
            other => {
                warn!(
                    event_type = %other,
                    "agent sidecar emitted unknown event type"
                );
            }
        }
    }

    /// Emit `api-agent:error:*` on every currently-owned session when the
    /// sidecar dies unrecoverably.
    async fn fan_out_crash_error(&self) {
        let sessions: Vec<String> = {
            let guard = self.owned_sessions.lock().await;
            guard.iter().cloned().collect()
        };
        for session_id in sessions {
            let _ = self.app_handle.emit(
                &error_event(&session_id),
                ErrorPayload {
                    message: "Sidecar crashed and could not restart".to_string(),
                },
            );
        }
        let mut guard = self.owned_sessions.lock().await;
        guard.clear();
    }
}

/// Pump JSON lines from the mpsc receiver to the sidecar's stdin. Terminates
/// when the channel is closed (on respawn / shutdown) or stdin write fails.
async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = rx.recv().await {
        let mut buf = line.into_bytes();
        buf.push(b'\n');
        if let Err(e) = stdin.write_all(&buf).await {
            warn!(error = %e, "agent sidecar stdin write failed");
            break;
        }
        if let Err(e) = stdin.flush().await {
            warn!(error = %e, "agent sidecar stdin flush failed");
            break;
        }
    }
}

/// Resolve the path to the sidecar entrypoint.
///
/// Three-branch resolution:
/// 1. If `PACKETADE_SIDECAR_PATH` is set, use it verbatim (tests, locally-
///    built sidecars, and escape hatch for broken packaging).
/// 2. Otherwise in dev (`cfg!(debug_assertions)`) fall back to
///    `<project-root>/agent-sidecar/dist/index.js`. `CARGO_MANIFEST_DIR` in
///    dev is `src-tauri/`, so this resolves to the source tree.
/// 3. Otherwise in release resolve via Tauri's resource dir (slice B bundles
///    `agent-sidecar/{dist,package.json,node_modules}` under that path).
///
/// If none of the three exist we still return a best-guess path; the caller
/// (`spawn_child`) checks `.exists()` and surfaces a user-readable error
/// that lists the resolved path.
fn resolve_sidecar_path(app_handle: &AppHandle) -> PathBuf {
    // 1. Explicit env override — highest priority.
    if let Ok(override_path) = std::env::var("PACKETADE_SIDECAR_PATH") {
        return PathBuf::from(override_path);
    }

    // 2. Dev fallback — CARGO_MANIFEST_DIR-relative path to the source tree.
    let dev_path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("agent-sidecar")
        .join("dist")
        .join("index.js");

    if cfg!(debug_assertions) {
        return dev_path;
    }

    // 3. Release — bundled resource dir. If resource_dir() fails (unlikely
    //    on desktop), fall back to dev_path so the error message in
    //    `spawn_child` points at something sensible.
    match app_handle.path().resource_dir() {
        Ok(dir) => dir.join("agent-sidecar").join("dist").join("index.js"),
        Err(e) => {
            error!(
                error = %e,
                "failed to resolve resource_dir; falling back to manifest-relative path"
            );
            dev_path
        }
    }
}

/// Resolve an explicit Node binary override via `PACKETADE_NODE_PATH`. When
/// `None` is returned, callers use their default strategy: system `node` in
/// dev, Tauri shell plugin sidecar in release.
fn resolved_node_override() -> Option<PathBuf> {
    std::env::var("PACKETADE_NODE_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Trim a string for log output.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
