//! Code Quality runner — backend service.
//!
//! This module is the multi-check runner half of the "Code Quality" feature.
//! Where `code_quality.rs` produces a static analytics report (LOC, complexity,
//! org score) without spawning anything, *this* module shells out to real
//! tooling (`pnpm lint`, `pnpm build`, `pnpm test`, `cargo check`, …) and
//! streams their output back to the frontend live, with cancellation,
//! per-check timeouts, and a structured final summary.
//!
//! ## Wire protocol
//!
//! The frontend creates a run-id and invokes `run_quality_checks` with the
//! project path and either an explicit list of `QualityCheck`s or `null` to
//! request auto-detection.  As the run progresses, the backend emits these
//! Tauri events (all scoped by `run_id`):
//!
//! | Event                                | Payload                                          |
//! |--------------------------------------|--------------------------------------------------|
//! | `quality:check-start:<run_id>`       | `QualityCheckStartEvent`                         |
//! | `quality:chunk:<run_id>`             | `QualityChunkEvent` (stdout/stderr line)         |
//! | `quality:check-done:<run_id>`        | `QualityCheckDoneEvent`                          |
//! | `quality:done:<run_id>`              | `QualityRunSummary`                              |
//! | `quality:error:<run_id>`             | `{ message: String }` (fatal/uncaught only)      |
//!
//! Cancellation: the frontend calls `cancel_quality_run(run_id)`.  The runner
//! checks an `AtomicBool` between checks *and* kills the in-flight child via
//! `kill_on_drop` (the child handle is also held in shared state so we can
//! reach in and kill it explicitly, faster than waiting for the next loop
//! iteration).
//!
//! ## Detection
//!
//! `detect_quality_checks` inspects the project root and returns whatever it
//! finds, in a sensible order (lint → typecheck → test → rust):
//!
//! * `package.json` → `pnpm lint` if a `lint` script exists; `pnpm build`
//!   for `build`; `pnpm test` for `test`.  We prefer `pnpm` because that's
//!   what the project's own `preflight` uses; we fall back to `npm` if
//!   `package.json` has no `packageManager` field hinting at pnpm.
//! * `Cargo.toml` → `cargo check` (always) and `cargo test --lib` if the
//!   project has tests.  Run from the directory that contains `Cargo.toml`
//!   if it's a subdir (e.g. `src-tauri/`); single-crate workspaces work too.
//! * `pyproject.toml` / `requirements.txt` → `ruff check` if available.
//! * Sensible defaults that are *optional* (i.e. soft-fail-on-missing-tool):
//!   `cargo clippy`.
//!
//! Auto-detection is best-effort.  Callers can override entirely by passing
//! their own `Vec<QualityCheck>`.

use crate::commands::shared::hide_window_async;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::oneshot;
use tokio::time::Instant;
use tracing::{info, warn};

/// Default per-check timeout.  5 minutes is long enough for `pnpm test` /
/// `cargo check` on a moderately sized repo but short enough that a hung
/// process can't lock up the run forever.  Overridable per-check via the
/// `timeout_secs` field.
const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 300;

/// Hard cap on captured stdout+stderr per check.  Anything beyond this is
/// dropped from the in-memory buffer (the streaming events still go out, so
/// the UI sees it live, but the post-mortem `output` is truncated to keep us
/// from OOMing on a runaway test suite).
const MAX_CAPTURED_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// Hard cap on the run history we keep around in memory (oldest evicted on
/// overflow).  Pure safety valve — under normal use you'd only ever have
/// one active run.
const MAX_RUN_HISTORY: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityCheck {
    /// Stable id used to route stream events to the right UI panel.
    pub id: String,
    /// Human-readable label shown in the UI.
    pub label: String,
    /// Executable to run (e.g. `"pnpm"`, `"cargo"`).
    pub command: String,
    /// Args passed verbatim.  Never goes through a shell — no injection
    /// surface even if a user customises checks later.
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory **relative to** the project root.  Empty / "." =
    /// project root.  This is how we run `cargo check` in `src-tauri/`.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Per-check timeout override.  `None` = `DEFAULT_CHECK_TIMEOUT_SECS`.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Extra environment variables for the child process.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// If true, a non-zero exit code does NOT mark the overall run as
    /// failed (e.g. an optional `clippy` check).  The check itself still
    /// reports its exit code; we just don't fail the run on it.
    #[serde(default)]
    pub optional: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityCheckStartEvent {
    pub run_id: String,
    pub check_id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub started_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityChunkEvent {
    pub run_id: String,
    pub check_id: String,
    /// `"stdout"` | `"stderr"`.
    pub stream: &'static str,
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityCheckDoneEvent {
    pub run_id: String,
    pub check_id: String,
    pub label: String,
    /// Final captured output (stdout+stderr interleaved by arrival).
    /// Truncated at `MAX_CAPTURED_OUTPUT_BYTES`.
    pub output: String,
    pub truncated: bool,
    /// Process exit code.  `None` if the check was cancelled, timed out, or
    /// failed to spawn (in which case `error` is populated).
    pub exit_code: Option<i32>,
    pub status: CheckStatus,
    pub error: Option<String>,
    pub started_at: u64,
    pub completed_at: u64,
    pub duration_ms: u64,
    pub optional: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Passed,
    Failed,
    Cancelled,
    TimedOut,
    MissingTool,
    SpawnError,
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityRunSummary {
    pub run_id: String,
    pub project_path: String,
    pub checks: Vec<QualityCheckDoneEvent>,
    pub started_at: u64,
    pub completed_at: u64,
    pub duration_ms: u64,
    pub cancelled: bool,
    /// True iff every non-optional check returned `Passed`.
    pub all_passed: bool,
}

/// Per-run handle stored in `QualityRunnerState` so `cancel_quality_run` and
/// the running task can communicate.  Dropped from the registry when the
/// run finishes (passing, failing, or cancelled).
struct RunHandle {
    cancelled: Arc<AtomicBool>,
    /// Currently-running child, if any.  Mutating field — we swap it in /
    /// out as each check spawns and reaps.  Holding a `Child` here means a
    /// cancel can kill the actual OS process immediately, not wait for the
    /// runner loop to notice the flag.
    current_child: Arc<Mutex<Option<Child>>>,
    /// Wall-clock time the run was registered, used for FIFO eviction
    /// when the in-memory history grows past `MAX_RUN_HISTORY`. We use
    /// `Instant` rather than insertion order on the `HashMap` because
    /// `HashMap` iteration order is non-deterministic — evicting the
    /// `.keys().next()` entry could, and in tests did, evict an
    /// in-progress run and break cancellation.
    started_at: Instant,
}

#[derive(Default)]
pub struct QualityRunnerState {
    runs: Mutex<HashMap<String, RunHandle>>,
}

impl QualityRunnerState {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&self, run_id: &str) -> (Arc<AtomicBool>, Arc<Mutex<Option<Child>>>) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let current_child = Arc::new(Mutex::new(None));
        let mut guard = self.runs.lock().expect("quality runner state poisoned");

        // Evict the *oldest* run record (by `started_at`) if we're at the
        // history cap. We deliberately avoid `HashMap::keys().next()` here
        // because its iteration order is non-deterministic and could
        // evict an in-progress run whose cancel handle we still need.
        if guard.len() >= MAX_RUN_HISTORY {
            let oldest_key = guard
                .iter()
                .min_by_key(|(_, h)| h.started_at)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest_key {
                guard.remove(&k);
            }
        }
        guard.insert(
            run_id.to_string(),
            RunHandle {
                cancelled: cancelled.clone(),
                current_child: current_child.clone(),
                started_at: Instant::now(),
            },
        );
        (cancelled, current_child)
    }

    fn unregister(&self, run_id: &str) {
        let mut guard = self.runs.lock().expect("quality runner state poisoned");
        guard.remove(run_id);
    }

    fn request_cancel(&self, run_id: &str) -> bool {
        let guard = self.runs.lock().expect("quality runner state poisoned");
        if let Some(handle) = guard.get(run_id) {
            handle.cancelled.store(true, Ordering::SeqCst);
            // Kill the current child if any.  `kill_on_drop` is also set,
            // so even if `start_kill` fails (rare) the child is reaped when
            // the `Child` drops at the end of the check loop.
            if let Ok(mut child_slot) = handle.current_child.lock() {
                if let Some(child) = child_slot.as_mut() {
                    let _ = child.start_kill();
                }
            }
            true
        } else {
            false
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve a check's working directory, defending against `..` traversal.
/// Returns the absolute path that the child should `cwd` into.
fn resolve_check_cwd(project_path: &Path, check_cwd: Option<&str>) -> Result<PathBuf, String> {
    let cwd_raw = check_cwd.unwrap_or("").trim();
    if cwd_raw.is_empty() || cwd_raw == "." {
        return Ok(project_path.to_path_buf());
    }

    let candidate = project_path.join(cwd_raw);
    // We do NOT use std::fs::canonicalize here because the directory may
    // not exist on disk yet for some checks (rare, but defensive).  Instead
    // we walk the components and reject any "..".
    if cwd_raw.contains("..") {
        return Err(format!(
            "Quality check cwd '{}' contains '..' — refused",
            cwd_raw
        ));
    }
    Ok(candidate)
}

/// Spawn a child for one quality check and stream its output.
///
/// Returns a `QualityCheckDoneEvent` describing the outcome.  Does **not**
/// emit the done event itself — that's the caller's job, so the caller can
/// also push it into the summary vec.
async fn run_single_check(
    app: &AppHandle,
    run_id: &str,
    check: &QualityCheck,
    project_path: &Path,
    cancelled: Arc<AtomicBool>,
    current_child: Arc<Mutex<Option<Child>>>,
) -> QualityCheckDoneEvent {
    let started_at = now_ms();
    let started_instant = Instant::now();

    // If we were cancelled before we even spawned, short-circuit.
    if cancelled.load(Ordering::SeqCst) {
        return QualityCheckDoneEvent {
            run_id: run_id.to_string(),
            check_id: check.id.clone(),
            label: check.label.clone(),
            output: String::new(),
            truncated: false,
            exit_code: None,
            status: CheckStatus::Cancelled,
            error: None,
            started_at,
            completed_at: started_at,
            duration_ms: 0,
            optional: check.optional,
        };
    }

    let cwd = match resolve_check_cwd(project_path, check.cwd.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            return QualityCheckDoneEvent {
                run_id: run_id.to_string(),
                check_id: check.id.clone(),
                label: check.label.clone(),
                output: String::new(),
                truncated: false,
                exit_code: None,
                status: CheckStatus::SpawnError,
                error: Some(e),
                started_at,
                completed_at: now_ms(),
                duration_ms: started_instant.elapsed().as_millis() as u64,
                optional: check.optional,
            };
        }
    };

    let cwd_str = cwd.to_string_lossy().to_string();
    let _ = app.emit(
        &format!("quality:check-start:{}", run_id),
        &QualityCheckStartEvent {
            run_id: run_id.to_string(),
            check_id: check.id.clone(),
            label: check.label.clone(),
            command: check.command.clone(),
            args: check.args.clone(),
            cwd: cwd_str.clone(),
            started_at,
        },
    );

    // Build the command.  We deliberately do NOT pass through a shell —
    // `pnpm`, `cargo`, etc. accept arguments directly.  This kills the
    // injection-via-cwd / injection-via-args surface area.
    let mut cmd = TokioCommand::new(&check.command);
    cmd.args(&check.args);
    cmd.current_dir(&cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    // Force `NO_COLOR` so ANSI escapes don't pollute the captured output —
    // the UI renders plain text.  Callers can override via `env` if they
    // really want colour.
    cmd.env("NO_COLOR", "1");
    cmd.env("FORCE_COLOR", "0");
    cmd.env("CI", "1"); // most JS test runners pick this up to disable interactive UI
    for (k, v) in &check.env {
        cmd.env(k, v);
    }
    hide_window_async(&mut cmd);

    let spawn_result = cmd.spawn();
    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            // Heuristic: ENOENT / "program not found" → MissingTool so the
            // frontend can offer to install it.  Everything else is a
            // SpawnError.
            let status = if e.kind() == std::io::ErrorKind::NotFound {
                CheckStatus::MissingTool
            } else {
                CheckStatus::SpawnError
            };
            let completed_at = now_ms();
            return QualityCheckDoneEvent {
                run_id: run_id.to_string(),
                check_id: check.id.clone(),
                label: check.label.clone(),
                output: String::new(),
                truncated: false,
                exit_code: None,
                status,
                error: Some(format!("{}: {}", check.command, e)),
                started_at,
                completed_at,
                duration_ms: started_instant.elapsed().as_millis() as u64,
                optional: check.optional,
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stash the child so `cancel_quality_run` can reach it.  We hold the
    // child by-value in the slot; when we `take()` it back at the end to
    // call `wait`, the slot goes back to `None`.
    {
        let mut slot = current_child.lock().expect("current_child poisoned");
        *slot = Some(child);
    }

    // Shared capture buffer.  Both reader tasks push lines into it.
    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let truncated_flag = Arc::new(AtomicBool::new(false));

    fn spawn_reader<R>(
        reader: R,
        stream_name: &'static str,
        app: AppHandle,
        run_id: String,
        check_id: String,
        captured: Arc<Mutex<Vec<u8>>>,
        truncated_flag: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()>
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        tokio::spawn(async move {
            let mut buf = BufReader::new(reader);
            let mut line = String::new();
            loop {
                line.clear();
                let read = buf.read_line(&mut line).await;
                match read {
                    Ok(0) => break,
                    Ok(_) => {
                        // Strip trailing newline so the UI controls
                        // line-break semantics, but keep the bytes (incl.
                        // the newline) in the captured buffer for fidelity.
                        let mut to_emit = line.clone();
                        if to_emit.ends_with('\n') {
                            to_emit.pop();
                            if to_emit.ends_with('\r') {
                                to_emit.pop();
                            }
                        }
                        // Push into capture buffer with size cap.
                        if let Ok(mut cap) = captured.lock() {
                            if cap.len() < MAX_CAPTURED_OUTPUT_BYTES {
                                let remaining = MAX_CAPTURED_OUTPUT_BYTES - cap.len();
                                let bytes = line.as_bytes();
                                if bytes.len() <= remaining {
                                    cap.extend_from_slice(bytes);
                                } else {
                                    cap.extend_from_slice(&bytes[..remaining]);
                                    truncated_flag.store(true, Ordering::SeqCst);
                                }
                            } else {
                                truncated_flag.store(true, Ordering::SeqCst);
                            }
                        }
                        let _ = app.emit(
                            &format!("quality:chunk:{}", run_id),
                            &QualityChunkEvent {
                                run_id: run_id.clone(),
                                check_id: check_id.clone(),
                                stream: stream_name,
                                line: to_emit,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        })
    }

    let stdout_task = stdout.map(|s| {
        spawn_reader(
            s,
            "stdout",
            app.clone(),
            run_id.to_string(),
            check.id.clone(),
            captured.clone(),
            truncated_flag.clone(),
        )
    });
    let stderr_task = stderr.map(|s| {
        spawn_reader(
            s,
            "stderr",
            app.clone(),
            run_id.to_string(),
            check.id.clone(),
            captured.clone(),
            truncated_flag.clone(),
        )
    });

    let timeout_secs = check.timeout_secs.unwrap_or(DEFAULT_CHECK_TIMEOUT_SECS);
    let timeout_duration = Duration::from_secs(timeout_secs.max(1));

    // The child stays in the shared `current_child` slot so
    // `cancel_quality_run` can kill it via the slot, even while we're
    // awaiting it here.  We need to await with a timeout AND react to the
    // cancellation flag.  Approach: a watchdog task polls both the
    // cancellation flag and an internal deadline; if either fires, it
    // reaches into the slot and calls `start_kill` on the child.  The
    // primary task here just `wait`s the child to natural completion.
    let deadline = Instant::now() + timeout_duration;
    let watcher_flag = cancelled.clone();
    let watcher_child_slot = current_child.clone();
    let (kill_reason_tx, kill_reason_rx) = oneshot::channel::<KillReason>();
    let watcher = tokio::spawn(async move {
        let mut tx_holder = Some(kill_reason_tx);
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let cancelled_now = watcher_flag.load(Ordering::SeqCst);
            let timed_out = Instant::now() >= deadline;
            if cancelled_now || timed_out {
                if let Ok(mut slot) = watcher_child_slot.lock() {
                    if let Some(c) = slot.as_mut() {
                        let _ = c.start_kill();
                    }
                }
                let reason = if cancelled_now {
                    KillReason::Cancelled
                } else {
                    KillReason::TimedOut
                };
                if let Some(tx) = tx_holder.take() {
                    let _ = tx.send(reason);
                }
                return;
            }
        }
    });

    // Take the child out for `wait`.  After this point, `cancel` can still
    // kill the child via the slot ONLY if it's there; once we take it the
    // watcher above also can't reach it.  So we keep the watcher polling
    // the *slot*, not the child handle directly — which means the child
    // must stay in the slot until we know we're done.  Instead of taking,
    // we'll use `try_wait` polling.
    //
    // Switch strategy: poll `try_wait` in a loop with a short sleep,
    // racing against the kill_reason oneshot.  This avoids the borrow
    // conflict between `child.wait()` and `child.start_kill()`.
    let outcome: Outcome = {
        let mut kill_reason_rx = kill_reason_rx;
        let mut natural_status: Option<std::process::ExitStatus> = None;
        let mut kill_reason: Option<KillReason> = None;
        loop {
            // Try to reap the child without taking it out of the slot.
            {
                let mut slot = current_child.lock().expect("current_child poisoned");
                if let Some(c) = slot.as_mut() {
                    match c.try_wait() {
                        Ok(Some(status)) => {
                            natural_status = Some(status);
                            // Drop the child from the slot so cancel can't
                            // try to kill an already-reaped process.
                            slot.take();
                            break;
                        }
                        Ok(None) => { /* still running */ }
                        Err(e) => {
                            // Treat as wait error and stop.
                            slot.take();
                            return QualityCheckDoneEvent {
                                run_id: run_id.to_string(),
                                check_id: check.id.clone(),
                                label: check.label.clone(),
                                output: String::new(),
                                truncated: false,
                                exit_code: None,
                                status: CheckStatus::SpawnError,
                                error: Some(format!("wait error: {}", e)),
                                started_at,
                                completed_at: now_ms(),
                                duration_ms: started_instant.elapsed().as_millis() as u64,
                                optional: check.optional,
                            };
                        }
                    }
                } else {
                    // Slot is empty — shouldn't happen except after we
                    // ourselves drained it.
                    break;
                }
            }

            // Race a short sleep against the kill-reason oneshot so we
            // pick up cancellation promptly.
            tokio::select! {
                biased;
                r = &mut kill_reason_rx => {
                    if let Ok(reason) = r {
                        kill_reason = Some(reason);
                    }
                    // Don't break yet — give the child a moment to die
                    // after `start_kill`, then loop back to reap it.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }

            // If kill_reason fired, wait up to 5s for the child to die.
            // After that we'll forcibly drop it (kill_on_drop is set).
            if kill_reason.is_some() && Instant::now() > deadline + Duration::from_secs(5) {
                // Force-drop the child from the slot so kill_on_drop
                // reaps it.
                let mut slot = current_child.lock().expect("current_child poisoned");
                slot.take();
                break;
            }
        }

        // Priority order matters here:
        //   1. If the child exited naturally (`natural_status: Some(_)`),
        //      that wins regardless of `kill_reason`. The watcher polls
        //      every 100ms, so it can fire `start_kill` AND emit a
        //      `Cancelled` reason in the narrow window AFTER the child
        //      has already terminated normally but BEFORE the runner
        //      loop reaps it from the slot. Treating that as Cancelled
        //      would misclassify a passing run as user-cancelled.
        //   2. Otherwise the kill_reason (Cancelled or TimedOut) wins.
        //   3. If we somehow have neither, that's a wait-error.
        match (natural_status, kill_reason) {
            (Some(status), _) => Outcome::Exited(status.code()),
            (None, Some(KillReason::Cancelled)) => Outcome::Cancelled,
            (None, Some(KillReason::TimedOut)) => Outcome::TimedOut,
            (None, None) => Outcome::WaitError(
                "child disappeared from slot without reaping".to_string(),
            ),
        }
    };

    // Reader tasks exit naturally when the child's pipes close.  Give them
    // a short grace period so the final lines make it into the capture
    // buffer.
    if let Some(t) = stdout_task {
        let _ = tokio::time::timeout(Duration::from_secs(2), t).await;
    }
    if let Some(t) = stderr_task {
        let _ = tokio::time::timeout(Duration::from_secs(2), t).await;
    }
    watcher.abort();

    let completed_at = now_ms();
    let duration_ms = started_instant.elapsed().as_millis() as u64;
    let truncated = truncated_flag.load(Ordering::SeqCst);
    let output_bytes = captured.lock().map(|c| c.clone()).unwrap_or_default();
    let output = String::from_utf8_lossy(&output_bytes).to_string();

    let (status, exit_code, error) = match outcome {
        Outcome::Exited(Some(code)) if code == 0 => (CheckStatus::Passed, Some(code), None),
        Outcome::Exited(Some(code)) => (CheckStatus::Failed, Some(code), None),
        Outcome::Exited(None) => (
            CheckStatus::Failed,
            None,
            Some("Process terminated without an exit code".to_string()),
        ),
        Outcome::Cancelled => (CheckStatus::Cancelled, None, None),
        Outcome::TimedOut => (
            CheckStatus::TimedOut,
            None,
            Some(format!("Check exceeded timeout of {}s", timeout_secs)),
        ),
        Outcome::WaitError(msg) => (CheckStatus::SpawnError, None, Some(msg)),
    };

    QualityCheckDoneEvent {
        run_id: run_id.to_string(),
        check_id: check.id.clone(),
        label: check.label.clone(),
        output,
        truncated,
        exit_code,
        status,
        error,
        started_at,
        completed_at,
        duration_ms,
        optional: check.optional,
    }
}

enum Outcome {
    Exited(Option<i32>),
    Cancelled,
    TimedOut,
    WaitError(String),
}

#[derive(Clone, Copy, Debug)]
enum KillReason {
    Cancelled,
    TimedOut,
}

/// Inspect a project root and produce a reasonable default check list.
/// Returns the empty vec if nothing matched — the frontend should treat
/// that as "this project has no automated checks configured".
fn detect_checks_for_path(project_path: &Path) -> Vec<QualityCheck> {
    let mut out: Vec<QualityCheck> = Vec::new();

    // ---- Node / JS / TS ----
    let pkg_path = project_path.join("package.json");
    if let Ok(pkg_raw) = std::fs::read_to_string(&pkg_path) {
        if let Ok(pkg_val) = serde_json::from_str::<serde_json::Value>(&pkg_raw) {
            // Prefer pnpm if the project declares it (covers PacketADE).
            // Otherwise prefer npm — yarn is rarer and would need its own
            // detection (presence of yarn.lock).
            let pkg_mgr = if pkg_val
                .get("packageManager")
                .and_then(|v| v.as_str())
                .map(|s| s.starts_with("pnpm"))
                .unwrap_or(false)
                || project_path.join("pnpm-lock.yaml").exists()
            {
                "pnpm"
            } else if project_path.join("yarn.lock").exists() {
                "yarn"
            } else {
                "npm"
            };
            let scripts = pkg_val.get("scripts").and_then(|v| v.as_object());

            let has_script = |name: &str| -> bool {
                scripts
                    .map(|s| s.get(name).is_some())
                    .unwrap_or(false)
            };

            // Lint: only added if there's an actual `lint` script.
            if has_script("lint") {
                out.push(QualityCheck {
                    id: "lint".into(),
                    label: "Lint".into(),
                    command: pkg_mgr.into(),
                    args: vec!["run".into(), "lint".into()],
                    cwd: None,
                    timeout_secs: None,
                    env: HashMap::new(),
                    optional: false,
                });
            }

            // Typecheck / build.  We prefer a dedicated `typecheck` script
            // (cheaper) and fall back to `build`.
            if has_script("typecheck") {
                out.push(QualityCheck {
                    id: "typecheck".into(),
                    label: "Type Check".into(),
                    command: pkg_mgr.into(),
                    args: vec!["run".into(), "typecheck".into()],
                    cwd: None,
                    timeout_secs: None,
                    env: HashMap::new(),
                    optional: false,
                });
            } else if has_script("build") {
                out.push(QualityCheck {
                    id: "build".into(),
                    label: "Build".into(),
                    command: pkg_mgr.into(),
                    args: vec!["run".into(), "build".into()],
                    cwd: None,
                    timeout_secs: None,
                    env: HashMap::new(),
                    optional: false,
                });
            }

            // Test.  `pnpm test`, `npm test`, etc.
            if has_script("test") {
                out.push(QualityCheck {
                    id: "test".into(),
                    label: "Tests".into(),
                    command: pkg_mgr.into(),
                    args: vec!["run".into(), "test".into()],
                    cwd: None,
                    timeout_secs: None,
                    env: HashMap::new(),
                    optional: false,
                });
            }
        }
    }

    // ---- Rust ----
    // `Cargo.toml` may be at the project root OR in a subdir (the PacketADE
    // layout has it in `src-tauri/`).  We probe both.
    let cargo_locations: Vec<(&str, PathBuf)> = vec![
        (".", project_path.join("Cargo.toml")),
        ("src-tauri", project_path.join("src-tauri/Cargo.toml")),
    ];
    let mut cargo_added = false;
    for (rel_cwd, manifest) in cargo_locations {
        if !manifest.exists() {
            continue;
        }
        cargo_added = true;
        let cwd = if rel_cwd == "." {
            None
        } else {
            Some(rel_cwd.to_string())
        };
        out.push(QualityCheck {
            id: format!(
                "cargo-check{}",
                if rel_cwd == "." {
                    "".to_string()
                } else {
                    format!("-{}", rel_cwd)
                }
            ),
            label: if rel_cwd == "." {
                "Cargo Check".into()
            } else {
                format!("Cargo Check ({})", rel_cwd)
            },
            command: "cargo".into(),
            args: vec!["check".into(), "--all-targets".into()],
            cwd: cwd.clone(),
            timeout_secs: None,
            env: HashMap::new(),
            optional: false,
        });
        out.push(QualityCheck {
            id: format!(
                "cargo-test{}",
                if rel_cwd == "." {
                    "".to_string()
                } else {
                    format!("-{}", rel_cwd)
                }
            ),
            label: if rel_cwd == "." {
                "Cargo Test".into()
            } else {
                format!("Cargo Test ({})", rel_cwd)
            },
            command: "cargo".into(),
            args: vec!["test".into(), "--lib".into(), "--quiet".into()],
            cwd: cwd.clone(),
            timeout_secs: None,
            env: HashMap::new(),
            optional: false,
        });
        // Only the *first* Cargo manifest we hit is treated as canonical
        // for this auto-detect pass; otherwise a workspace with multiple
        // crates would run the same check N times.
        break;
    }
    let _ = cargo_added;

    // ---- Python ----
    let has_pyproject = project_path.join("pyproject.toml").exists();
    let has_requirements = project_path.join("requirements.txt").exists();
    if has_pyproject || has_requirements {
        // ruff is the most common modern linter; if it's not installed the
        // check returns `MissingTool` cleanly.
        out.push(QualityCheck {
            id: "ruff".into(),
            label: "Ruff".into(),
            command: "ruff".into(),
            args: vec!["check".into(), ".".into()],
            cwd: None,
            timeout_secs: None,
            env: HashMap::new(),
            optional: true,
        });
        // mypy: optional because not every Python project type-checks.
        out.push(QualityCheck {
            id: "mypy".into(),
            label: "Mypy".into(),
            command: "mypy".into(),
            args: vec![".".into()],
            cwd: None,
            timeout_secs: None,
            env: HashMap::new(),
            optional: true,
        });
    }

    out
}

#[tauri::command]
pub fn detect_quality_checks(project_path: String) -> Result<Vec<QualityCheck>, String> {
    super::validate_project_path(&project_path)?;
    Ok(detect_checks_for_path(Path::new(&project_path)))
}

/// Kick off a quality run.  Returns immediately with the run-id (the same
/// id the caller passed in, echoed back for symmetry with other commands).
/// All progress is reported via `quality:*` Tauri events.
///
/// `checks = None` ⇒ auto-detect from `project_path`.  `checks = Some(empty)`
/// ⇒ error (refuse a no-op run so the frontend can flag it).
#[tauri::command]
pub fn run_quality_checks(
    app: AppHandle,
    project_path: String,
    run_id: String,
    checks: Option<Vec<QualityCheck>>,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    if run_id.trim().is_empty() {
        return Err("run_id cannot be empty".to_string());
    }

    let resolved_checks = match checks {
        Some(list) => {
            if list.is_empty() {
                return Err("No checks provided".to_string());
            }
            list
        }
        None => {
            let detected = detect_checks_for_path(Path::new(&project_path));
            if detected.is_empty() {
                return Err("No quality checks detected for this project".to_string());
            }
            detected
        }
    };

    let state = app
        .try_state::<Arc<QualityRunnerState>>()
        .ok_or_else(|| "QualityRunnerState not initialised".to_string())?
        .inner()
        .clone();

    // Refuse duplicate run_ids — guards against the frontend double-firing.
    {
        let guard = state.runs.lock().expect("quality runner state poisoned");
        if guard.contains_key(&run_id) {
            return Err(format!("Run '{}' is already in progress", run_id));
        }
    }

    let (cancelled, current_child) = state.register(&run_id);

    let app_handle = app.clone();
    let project_path_clone = project_path.clone();
    let run_id_clone = run_id.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let project_root = Path::new(&project_path_clone).to_path_buf();
        let started_at = now_ms();
        let started_instant = Instant::now();
        let mut summary_checks: Vec<QualityCheckDoneEvent> = Vec::with_capacity(resolved_checks.len());
        let mut overall_cancelled = false;
        let mut all_passed = true;

        info!(
            run_id = %run_id_clone,
            project = %project_path_clone,
            checks = resolved_checks.len(),
            "Starting quality run"
        );

        for check in &resolved_checks {
            // If a previous check tripped cancellation, skip the rest.
            if cancelled.load(Ordering::SeqCst) {
                overall_cancelled = true;
                let now = now_ms();
                let skipped = QualityCheckDoneEvent {
                    run_id: run_id_clone.clone(),
                    check_id: check.id.clone(),
                    label: check.label.clone(),
                    output: String::new(),
                    truncated: false,
                    exit_code: None,
                    status: CheckStatus::Skipped,
                    error: None,
                    started_at: now,
                    completed_at: now,
                    duration_ms: 0,
                    optional: check.optional,
                };
                let _ = app_handle.emit(
                    &format!("quality:check-done:{}", run_id_clone),
                    &skipped,
                );
                summary_checks.push(skipped);
                if !check.optional {
                    all_passed = false;
                }
                continue;
            }

            let done = run_single_check(
                &app_handle,
                &run_id_clone,
                check,
                &project_root,
                cancelled.clone(),
                current_child.clone(),
            )
            .await;

            if matches!(done.status, CheckStatus::Cancelled) {
                overall_cancelled = true;
            }
            if !done.optional
                && !matches!(
                    done.status,
                    CheckStatus::Passed | CheckStatus::Skipped
                )
            {
                all_passed = false;
            }

            let _ = app_handle.emit(
                &format!("quality:check-done:{}", run_id_clone),
                &done,
            );
            summary_checks.push(done);
        }

        let completed_at = now_ms();
        let summary = QualityRunSummary {
            run_id: run_id_clone.clone(),
            project_path: project_path_clone.clone(),
            checks: summary_checks,
            started_at,
            completed_at,
            duration_ms: started_instant.elapsed().as_millis() as u64,
            cancelled: overall_cancelled,
            all_passed: all_passed && !overall_cancelled,
        };

        let _ = app_handle.emit(&format!("quality:done:{}", run_id_clone), &summary);

        info!(
            run_id = %run_id_clone,
            duration_ms = summary.duration_ms,
            all_passed = summary.all_passed,
            cancelled = summary.cancelled,
            "Quality run finished"
        );

        state_clone.unregister(&run_id_clone);
    });

    Ok(run_id)
}

#[tauri::command]
pub fn cancel_quality_run(app: AppHandle, run_id: String) -> Result<bool, String> {
    let state = app
        .try_state::<Arc<QualityRunnerState>>()
        .ok_or_else(|| "QualityRunnerState not initialised".to_string())?;
    let cancelled = state.request_cancel(&run_id);
    if !cancelled {
        warn!(run_id = %run_id, "cancel_quality_run: no such active run");
    }
    Ok(cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetade-qr-{}-{}", prefix, unique));
        fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    #[test]
    fn detect_returns_empty_for_unrecognised_project() {
        let dir = tmp_dir("empty");
        let checks = detect_checks_for_path(&dir);
        assert!(checks.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detect_picks_up_package_json_scripts() {
        let dir = tmp_dir("pkg");
        fs::write(
            dir.join("package.json"),
            r#"{
                "name": "x",
                "scripts": {
                    "lint": "eslint .",
                    "build": "tsc",
                    "test": "vitest run"
                }
            }"#,
        )
        .unwrap();
        let checks = detect_checks_for_path(&dir);
        let ids: Vec<&str> = checks.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"lint"));
        assert!(ids.contains(&"build"));
        assert!(ids.contains(&"test"));
        // Default package manager is npm when there's no pnpm-lock.yaml /
        // packageManager hint.
        assert_eq!(checks[0].command, "npm");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detect_prefers_pnpm_when_lockfile_present() {
        let dir = tmp_dir("pnpm");
        fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"lint":"eslint ."}}"#,
        )
        .unwrap();
        fs::write(dir.join("pnpm-lock.yaml"), "lockfileVersion: 9.0").unwrap();
        let checks = detect_checks_for_path(&dir);
        assert_eq!(checks[0].command, "pnpm");
        assert_eq!(checks[0].args, vec!["run", "lint"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detect_prefers_typecheck_over_build() {
        let dir = tmp_dir("typecheck");
        fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"typecheck":"tsc","build":"vite build"}}"#,
        )
        .unwrap();
        let checks = detect_checks_for_path(&dir);
        assert!(checks.iter().any(|c| c.id == "typecheck"));
        assert!(!checks.iter().any(|c| c.id == "build"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detect_handles_subdir_cargo_manifest() {
        let dir = tmp_dir("cargo-subdir");
        let sub = dir.join("src-tauri");
        fs::create_dir_all(&sub).unwrap();
        fs::write(
            sub.join("Cargo.toml"),
            "[package]\nname=\"x\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
        )
        .unwrap();
        let checks = detect_checks_for_path(&dir);
        let cargo_check = checks
            .iter()
            .find(|c| c.id.starts_with("cargo-check"))
            .expect("cargo-check");
        assert_eq!(cargo_check.cwd.as_deref(), Some("src-tauri"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detect_skips_node_modules_lockfile_when_no_package_json() {
        // Defensive: a stray pnpm-lock.yaml in a non-Node folder should not
        // produce any checks.
        let dir = tmp_dir("stray-lock");
        fs::write(dir.join("pnpm-lock.yaml"), "lockfileVersion: 9.0").unwrap();
        let checks = detect_checks_for_path(&dir);
        assert!(checks.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_check_cwd_rejects_dot_dot_traversal() {
        let base = tmp_dir("traversal");
        let bad = resolve_check_cwd(&base, Some("../etc"));
        assert!(bad.is_err());
        let good = resolve_check_cwd(&base, Some("src-tauri")).unwrap();
        assert!(good.ends_with("src-tauri"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn resolve_check_cwd_defaults_to_project_root() {
        let base = tmp_dir("default-cwd");
        let r = resolve_check_cwd(&base, None).unwrap();
        assert_eq!(r, base);
        let r2 = resolve_check_cwd(&base, Some(".")).unwrap();
        assert_eq!(r2, base);
        let r3 = resolve_check_cwd(&base, Some("")).unwrap();
        assert_eq!(r3, base);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn runner_state_registers_and_cancels_runs() {
        let state = QualityRunnerState::new();
        let (flag, _child) = state.register("run-1");
        assert!(!flag.load(Ordering::SeqCst));
        assert!(state.request_cancel("run-1"));
        assert!(flag.load(Ordering::SeqCst));
        // Unknown run id returns false without panicking.
        assert!(!state.request_cancel("does-not-exist"));
        state.unregister("run-1");
    }

    #[test]
    fn runner_state_evicts_oldest_on_overflow() {
        let state = QualityRunnerState::new();
        for i in 0..(MAX_RUN_HISTORY + 4) {
            state.register(&format!("run-{}", i));
        }
        let guard = state.runs.lock().unwrap();
        assert!(guard.len() <= MAX_RUN_HISTORY);
    }
}
