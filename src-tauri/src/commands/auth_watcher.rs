//! Filesystem watcher for provider credential files.
//!
//! When the user completes `claude login` or `codex login` in a workspace
//! terminal, the corresponding credential file changes on disk. Without an
//! active watcher, the AuthBadge in the Agents pane would only reflect the
//! new status the next time the dropdown is opened (which triggers an RPC
//! refresh). This module bridges that gap by watching the two credential
//! directories and emitting a `provider-auth:changed` event whenever a
//! relevant file mutates.
//!
//! Design notes:
//! - We watch the *parent* (`~/.claude` and `~/.codex`) rather than each
//!   individual credential file, because the files may not exist yet (the
//!   user may not have logged in yet) and watching a non-existent path is
//!   a setup error with most backends.
//! - If a watched directory doesn't exist, we fall back to watching the
//!   home directory and filter events by the first path component.
//! - Events are coalesced with a 500ms debounce window so a single login
//!   (which typically causes a flurry of create/modify/rename events)
//!   results in exactly one emit per provider.
//! - The watcher is owned by app-managed state so Tauri drops it when the
//!   app exits, cleanly releasing OS file handles.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::provider_auth::{probe_claude_oauth, probe_codex_oauth, ProviderAuthStatus};

/// Provider identifiers used in the emitted payload. These match the strings
/// that the frontend already sends to `get_provider_auth_status`.
const PROVIDER_CLAUDE: &str = "claude-oauth";
const PROVIDER_CODEX: &str = "openai-codex";

/// Coalesce window — events arriving within this duration of an earlier
/// event for the same provider are dropped and re-trigger the in-flight
/// emission. Tuned for the login flow, which typically settles within a
/// few hundred ms.
const DEBOUNCE_MS: u64 = 500;

/// Managed state handle. Holding the watcher in `State<...>` keeps it alive
/// for the process lifetime and lets Tauri drop it on shutdown. The actual
/// `RecommendedWatcher` is stored inside a `Mutex` because `notify` requires
/// `&mut self` for `watch`/`unwatch` and we want the struct to be `Send +
/// Sync` so it can live in `tauri::State`.
pub struct AuthWatcherState {
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Payload for the `provider-auth:changed` event. Shape is intentionally
/// identical to what the frontend would receive from a fresh RPC call so the
/// listener can apply the update without re-fetching.
#[derive(serde::Serialize, Clone)]
struct AuthChangedPayload {
    provider: String,
    status: ProviderAuthStatus,
}

/// Initialize the watcher. Called once from `.setup()`.
///
/// Errors from this function are logged but do not prevent app startup —
/// auth status will simply fall back to the on-demand polling behaviour if
/// the watcher can't be created (e.g. the platform lacks inotify/FSEvents).
pub fn init(app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            warn!("auth_watcher: no home directory available; skipping");
            return Ok(());
        }
    };

    let claude_dir = home.join(".claude");
    let codex_dir = home.join(".codex");

    // Figure out which paths we can actually watch. If the provider dir
    // doesn't exist, fall back to watching the home dir and filter events
    // by path prefix. This lets us catch the *first* login.
    let mut watch_targets: Vec<PathBuf> = Vec::new();
    let watch_home_fallback = !claude_dir.is_dir() || !codex_dir.is_dir();
    if claude_dir.is_dir() {
        watch_targets.push(claude_dir.clone());
    }
    if codex_dir.is_dir() {
        watch_targets.push(codex_dir.clone());
    }
    if watch_home_fallback {
        // Non-recursive watch on $HOME catches the creation of ~/.claude
        // and ~/.codex themselves. We dedupe against any dirs already
        // pushed above.
        if !watch_targets.iter().any(|p| p == &home) {
            watch_targets.push(home.clone());
        }
    }

    if watch_targets.is_empty() {
        warn!("auth_watcher: nothing to watch (no home, no provider dirs)");
        return Ok(());
    }

    // Bounded channel — events are cheap, 128 is plenty of headroom.
    let (tx, mut rx) = mpsc::channel::<notify::Result<Event>>(128);

    // The notify callback runs on its own thread. Forward events into the
    // async channel so we can await them in a Tokio task alongside the
    // debounce timer.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        // `blocking_send` is fine here — the callback thread is dedicated
        // to the watcher and a momentary stall under backpressure is
        // harmless.
        let _ = tx.blocking_send(res);
    })?;

    for target in &watch_targets {
        // Non-recursive: credential files are direct children of the
        // watched dirs. Recursive would just waste cycles on unrelated
        // files (e.g. `~/.claude/todos/*`).
        if let Err(e) = watcher.watch(target, RecursiveMode::NonRecursive) {
            warn!("auth_watcher: failed to watch {:?}: {}", target, e);
        } else {
            info!("auth_watcher: watching {:?}", target);
        }
    }

    // Spawn the consumer task. It owns the receiver and debounces per
    // provider before emitting.
    let app_for_task = app_handle.clone();
    let claude_dir_for_task = claude_dir;
    let codex_dir_for_task = codex_dir;
    tauri::async_runtime::spawn(async move {
        // F16: trailing-edge debounce. A login writes the cred file several times
        // in quick succession; a leading-edge debounce emitted on the FIRST event
        // (re-probing a half-written file) and dropped every later event —
        // including the final authoritative write. Instead we accumulate which
        // providers changed and emit a fresh probe only once the burst has been
        // quiet for the debounce window, so the emitted status is the settled one.
        let settle = Duration::from_millis(DEBOUNCE_MS);
        let mut dirty_claude = false;
        let mut dirty_codex = false;
        loop {
            let next = if dirty_claude || dirty_codex {
                match tokio::time::timeout(settle, rx.recv()).await {
                    Ok(v) => v,
                    Err(_) => {
                        // Quiescent for the debounce window — flush the trailing,
                        // authoritative state with a fresh probe per dirty provider.
                        if dirty_claude {
                            let status = probe_claude_oauth();
                            let _ = app_for_task.emit(
                                "provider-auth:changed",
                                AuthChangedPayload {
                                    provider: PROVIDER_CLAUDE.to_string(),
                                    status,
                                },
                            );
                            dirty_claude = false;
                        }
                        if dirty_codex {
                            let status = probe_codex_oauth();
                            let _ = app_for_task.emit(
                                "provider-auth:changed",
                                AuthChangedPayload {
                                    provider: PROVIDER_CODEX.to_string(),
                                    status,
                                },
                            );
                            dirty_codex = false;
                        }
                        continue;
                    }
                }
            } else {
                rx.recv().await
            };

            let Some(res) = next else {
                break; // channel closed
            };
            let event = match res {
                Ok(ev) => ev,
                Err(e) => {
                    warn!("auth_watcher: event error: {}", e);
                    continue;
                }
            };

            // Mark which provider(s) this event affects; the actual probe + emit
            // happens on the trailing edge above.
            for p in &event.paths {
                if path_is_in(&p, &claude_dir_for_task) {
                    dirty_claude = true;
                }
                if path_is_in(&p, &codex_dir_for_task) {
                    dirty_codex = true;
                }
            }
        }
    });

    // Keep the watcher alive via managed state.
    app_handle.manage(AuthWatcherState {
        _watcher: Mutex::new(Some(watcher)),
    });

    // Suppress unused-import warnings on platforms where we don't exercise
    // every branch of `watch_targets`.
    let _ = Arc::new(());

    Ok(())
}

/// True if `candidate` is the same as `dir` or a direct/indirect child of it.
fn path_is_in(candidate: &Path, dir: &Path) -> bool {
    candidate == dir || candidate.starts_with(dir)
}

