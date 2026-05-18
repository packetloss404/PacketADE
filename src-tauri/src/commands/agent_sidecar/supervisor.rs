//! `SidecarManager` — owns the child process, stdin writer channel, and the
//! set of sidecar-owned sessions. Implements spawn / restart / IO pumping.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{error, info, warn};

use super::events::{error_event, ErrorPayload};
use super::status::{
    current_time_rfc3339, load_lifetime_stats, save_lifetime_stats, SidecarState, SidecarStatus,
    SidecarStatusInner,
};
use super::{MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW, SIDECAR_STATUS_EVENT};
use crate::commands::shared::hide_window_async;

/// Per-session waiter state for [`SidecarManager::wait_for_oneshot`].
///
/// Mission Planner E10-SUMMARIZE uses this to await a single-turn sidecar
/// session's completion from Rust code. The waiter accumulates `chunk` text
/// into `buffer` and gets resolved on the first terminal event (`done` →
/// `Ok(buffer)` / `error` → `Err(message)`).
///
/// Held inside `SidecarManager::oneshot_waiters` keyed by session id. The
/// entry is removed when the terminal event fires (or when the awaiter
/// times out / is dropped — best-effort cleanup happens on the next
/// terminal event for the same id).
pub(super) struct OneshotWaiter {
    /// Accumulated `chunk` text for this session. Drained when the
    /// terminal event resolves the waiter.
    pub buffer: String,
    /// One-shot completion channel. `Some(_)` while the awaiter is still
    /// waiting; `None` after the terminal event has fired (guards against
    /// double-resolution if both `done` and `error` race in pathological
    /// cases).
    pub sender: Option<oneshot::Sender<Result<String, String>>>,
}

pub struct SidecarManager {
    pub(super) app_handle: AppHandle,
    /// Absolute path to the sidecar's `dist/index.js` entrypoint.
    sidecar_path: PathBuf,
    /// Sender for JSON lines destined for the sidecar's stdin.
    /// Held inside a Mutex so the writer can be swapped on respawn.
    writer_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Sessions we've started and not yet closed. Used by slice C's
    /// `owns_session()` check and to fan-out sidecar-crash errors.
    pub(super) owned_sessions: Arc<Mutex<HashSet<String>>>,
    /// Lifecycle status surfaced to the frontend (see `SidecarStatus`).
    status: Mutex<SidecarStatusInner>,
    /// E10-SUMMARIZE — per-session one-shot completion waiters. A caller
    /// that needs the full assistant response as a `String` (rather than
    /// the streamed-event firehose) registers a waiter via
    /// [`SidecarManager::wait_for_oneshot`] before `forward_start`, then
    /// awaits the returned `Result`. The chunk/done/error branches of
    /// `handle_event` resolve outstanding waiters.
    ///
    /// Sessions with no registered waiter incur a single hash-map lookup
    /// per event — zero behavioural change for the streaming path.
    pub(super) oneshot_waiters: Arc<Mutex<HashMap<String, OneshotWaiter>>>,
}

impl SidecarManager {
    /// Construct the manager, spawn the child, and start the IO tasks.
    /// Safe to call during `.setup()`; the child is spawned asynchronously.
    pub async fn new(app_handle: AppHandle) -> Arc<Self> {
        let sidecar_path = resolve_sidecar_path(&app_handle);
        // Hydrate lifetime counters from disk before spawning. Missing /
        // corrupt file → defaults. Never fatal.
        let lifetime = load_lifetime_stats();
        let mut inner = SidecarStatusInner::default();
        inner.lifetime = lifetime;
        let manager = Arc::new(Self {
            app_handle,
            sidecar_path,
            writer_tx: Mutex::new(None),
            owned_sessions: Arc::new(Mutex::new(HashSet::new())),
            status: Mutex::new(inner),
            oneshot_waiters: Arc::new(Mutex::new(HashMap::new())),
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

    pub(super) async fn forget_owned_session(&self, session_id: &str) {
        let mut sessions = self.owned_sessions.lock().await;
        sessions.remove(session_id);
    }

    /// E10-SUMMARIZE — register a one-shot completion waiter for
    /// `session_id` and return a future that resolves with the
    /// concatenated assistant text on `done`, or `Err(message)` on `error`.
    ///
    /// Intended for sessions whose entire conversation is a single
    /// request/response round-trip (e.g. mission-journal summarization).
    /// The caller is responsible for:
    ///   * Calling this **before** `forward_start` so the waiter is in
    ///     place before any chunks arrive (the registration is cheap and
    ///     synchronous-looking — just a `HashMap::insert`).
    ///   * Closing the session via `forward_close` after the future
    ///     resolves. The waiter does **not** close the session itself; it
    ///     only collects text.
    ///
    /// If a waiter for `session_id` already exists, the previous one is
    /// dropped (sender goes out of scope → previous awaiter sees
    /// `RecvError`). In practice each one-shot session id is a fresh UUID,
    /// so this never happens.
    #[allow(dead_code)]
    pub async fn wait_for_oneshot(
        self: &Arc<Self>,
        session_id: &str,
    ) -> oneshot::Receiver<Result<String, String>> {
        let (tx, rx) = oneshot::channel();
        let waiter = OneshotWaiter {
            buffer: String::new(),
            sender: Some(tx),
        };
        let mut guard = self.oneshot_waiters.lock().await;
        guard.insert(session_id.to_string(), waiter);
        rx
    }

    /// Return a snapshot of the current lifecycle status. Used by the
    /// `get_sidecar_status` Tauri command (the frontend polls this on mount
    /// before subscribing to `sidecar-status:changed`).
    pub async fn current_status(&self) -> SidecarStatus {
        let guard = self.status.lock().await;
        guard.snapshot()
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// Apply a status mutation under the lock and emit
    /// `sidecar-status:changed` with the new snapshot. All transitions go
    /// through here so we never forget to emit.
    ///
    /// Persists `lifetime` to `~/.packetade/sidecar-stats.json` on every
    /// call. The write is cheap (the struct serializes to a few hundred
    /// bytes), atomic via `.tmp` + rename, and best-effort — failures are
    /// logged but do not block the emit.
    pub(super) async fn update_status(&self, mutate: impl FnOnce(&mut SidecarStatusInner)) {
        let (snapshot, lifetime) = {
            let mut guard = self.status.lock().await;
            mutate(&mut guard);
            (guard.snapshot(), guard.lifetime.clone())
        };
        if let Err(e) = save_lifetime_stats(&lifetime) {
            warn!(error = %e, "failed to persist sidecar lifetime stats");
        }
        let _ = self.app_handle.emit(SIDECAR_STATUS_EVENT, snapshot);
    }

    /// Serialize `value` as a JSON line and push it onto the writer channel.
    pub(super) async fn send_json(&self, value: Value) -> Result<(), String> {
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
                    let now_rfc3339 = current_time_rfc3339();
                    self.update_status(|s| {
                        // If the child had been ready, an unexpected exit
                        // without a recorded error still deserves *some*
                        // breadcrumb for the status chip's tooltip.
                        if s.last_error.is_none() && s.state == SidecarState::Ready {
                            s.last_error = Some("Sidecar exited unexpectedly".to_string());
                        }
                        s.pid = None;
                        // Lifetime bookkeeping: count the crash, remember the
                        // error for future sessions, and fold the just-ended
                        // uptime window into the cumulative total.
                        s.lifetime.total_crashes = s.lifetime.total_crashes.saturating_add(1);
                        s.lifetime.last_crash_time = Some(now_rfc3339.clone());
                        s.lifetime.last_error = s.last_error.clone();
                        if let Some(start) = s.session_start.take() {
                            let secs = start.elapsed().as_secs();
                            s.lifetime.total_uptime_secs =
                                s.lifetime.total_uptime_secs.saturating_add(secs);
                        }
                    })
                    .await;
                }
                Err(e) => {
                    error!(error = %e, "failed to spawn agent sidecar");
                    let msg = e.clone();
                    let now_rfc3339 = current_time_rfc3339();
                    self.update_status(|s| {
                        s.last_error = Some(msg.clone());
                        s.pid = None;
                        // Treat a spawn failure as a crash for lifetime
                        // purposes — it's the same user-visible outcome.
                        s.lifetime.total_crashes = s.lifetime.total_crashes.saturating_add(1);
                        s.lifetime.last_crash_time = Some(now_rfc3339.clone());
                        s.lifetime.last_error = Some(msg);
                        if let Some(start) = s.session_start.take() {
                            let secs = start.elapsed().as_secs();
                            s.lifetime.total_uptime_secs =
                                s.lifetime.total_uptime_secs.saturating_add(secs);
                        }
                    })
                    .await;
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
                {
                    let mut guard = self.writer_tx.lock().await;
                    *guard = None;
                }
                self.update_status(|s| {
                    s.state = SidecarState::Down;
                    s.pid = None;
                    if s.last_error.is_none() {
                        s.last_error = Some(format!(
                            "Sidecar exceeded {} restarts in {:?}",
                            MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW
                        ));
                    }
                })
                .await;
                return;
            }
            restart_times.push(now);

            // About to retry — flip to "restarting" and bump the lifetime
            // counter. The chip will show `restarting (N/3)`.
            self.update_status(|s| {
                s.state = SidecarState::Restarting;
                s.restart_count = s.restart_count.saturating_add(1);
                s.pid = None;
            })
            .await;

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
        } else if let Some(node_path) = resolve_bundled_node_path(&self.app_handle) {
            // Release/standalone: prefer the colocated bundled Node binary
            // with the Tokio path. The shell plugin's sidecar resolver works
            // in installed bundles, but can fail for direct
            // `target/release/packetade.exe` launches even when build.rs has
            // copied Node beside the executable.
            self.spawn_via_tokio(Some(node_path)).await
        } else {
            // Release fallback: Tauri-bundled Node via the shell plugin
            // sidecar API.
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
        let sidecar_arg = node_compatible_path(&self.sidecar_path);
        let mut cmd = Command::new(&node_exe);
        cmd.arg(&sidecar_arg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window_async(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "spawn node sidecar (node={}, entry={}): {}",
                node_exe.display(),
                sidecar_arg.display(),
                e
            )
        })?;

        let child_pid = child.id();
        info!(
            pid = ?child_pid,
            node = %node_exe.display(),
            path = %sidecar_arg.display(),
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
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "sidecar stderr was not piped".to_string())?;

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
        let stderr_handle = tokio::spawn(stderr_loop(stderr));

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
        if !status.success() {
            let message = format!("Sidecar exited with {}", status);
            self.update_status(|s| {
                if s.last_error.is_none() {
                    s.last_error = Some(message);
                }
            })
            .await;
        }

        // Drop the writer channel so the writer task winds down.
        {
            let mut guard = self.writer_tx.lock().await;
            *guard = None;
        }

        // Reader task will end on its own once stdout hits EOF.
        let _ = reader_handle.await;
        let _ = stderr_handle.await;
        let _ = writer_handle.await;

        Ok(())
    }

    /// Spawn the sidecar via the Tauri shell plugin's sidecar API, which
    /// resolves `node` to the app-bundled binary declared in
    /// `tauri.conf.json > bundle.externalBin` (see slice B). Used in release.
    async fn spawn_via_shell_sidecar(self: &Arc<Self>) -> Result<(), String> {
        let sidecar_arg = node_compatible_path(&self.sidecar_path);
        let command = self
            .app_handle
            .shell()
            .sidecar("node")
            .map_err(|e| format!("resolve bundled node sidecar: {}", e))?
            .arg(&sidecar_arg);

        let (mut rx, mut child) = command
            .spawn()
            .map_err(|e| format!("spawn bundled node sidecar: {}", e))?;

        let child_pid = child.pid();
        info!(
            pid = child_pid,
            path = %sidecar_arg.display(),
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
                                    line = %super::handler::truncate(trimmed, 500),
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
                        if payload.code != Some(0) {
                            let message = match payload.code {
                                Some(code) => format!("Sidecar exited with code {}", code),
                                None => "Sidecar exited unexpectedly".to_string(),
                            };
                            reader_mgr
                                .update_status(|s| {
                                    if s.last_error.is_none() {
                                        s.last_error = Some(message);
                                    }
                                })
                                .await;
                        }
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
                                line = %super::handler::truncate(&line, 500),
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

        // E10-SUMMARIZE — also resolve any outstanding one-shot waiters
        // with the crash error so awaiters don't hang forever after a
        // hard sidecar failure.
        let mut waiters = self.oneshot_waiters.lock().await;
        let drained: Vec<(String, OneshotWaiter)> = waiters.drain().collect();
        drop(waiters);
        for (_sid, mut waiter) in drained {
            if let Some(sender) = waiter.sender.take() {
                let _ = sender.send(Err(
                    "Sidecar crashed and could not restart".to_string(),
                ));
            }
        }
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

async fn stderr_loop(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    warn!(target: "agent_sidecar::stderr", "{}", trimmed);
                }
            }
            Ok(None) => break,
            Err(e) => {
                warn!(error = %e, "agent sidecar stderr read failed");
                break;
            }
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

/// Node 24.15 on Windows cannot load a main module path in verbatim form
/// (`\\?\D:\...`), which Tauri may return for bundled resources. Strip that
/// prefix only for the argument we pass to Node; filesystem checks can keep
/// using the original `PathBuf`.
#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    let rendered = path.to_string_lossy();
    if let Some(rest) = rendered.strip_prefix("\\\\?\\UNC\\") {
        PathBuf::from(format!("\\\\{}", rest))
    } else if let Some(rest) = rendered.strip_prefix("\\\\?\\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn bundled_node_names() -> &'static [&'static str] {
    #[cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))]
    {
        &["node.exe", "node-x86_64-pc-windows-msvc.exe"]
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        &["node", "node-x86_64-apple-darwin"]
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        &["node", "node-aarch64-apple-darwin"]
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        &["node", "node-x86_64-unknown-linux-gnu"]
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        &["node", "node-aarch64-unknown-linux-gnu"]
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64")
    )))]
    {
        &[]
    }
}

fn resolve_bundled_node_path(app_handle: &AppHandle) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        roots.push(resource_dir);
    }

    for root in roots {
        for name in bundled_node_names() {
            let candidate = root.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
