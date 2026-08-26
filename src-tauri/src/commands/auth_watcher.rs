//! Filesystem watcher for provider credential files.
//!
//! When the user completes `claude login` or `codex login` in a workspace
//! terminal, the corresponding credential file changes on disk. Without an
//! active watcher, the AuthBadge in the Agents pane would only reflect the
//! new status the next time the dropdown is opened (which triggers an RPC
//! refresh). This module bridges that gap by watching the credential
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
//!
//! Multi-account
//! -------------
//! Beyond the two ambient dirs we also watch every registered CLI account's
//! `configDir` (the dir a launch points `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
//! at). Emissions are therefore keyed by `(provider, accountId)`, with
//! `accountId` **absent** for the ambient default so every pre-existing
//! listener keeps working unchanged.
//!
//! Account-list dependency: the account records live in the persisted state
//! slice `core::storage::PersistedState::cli_accounts`. That slice is
//! `#[serde(default)]`, so a pre-multi-account state file simply yields zero
//! accounts and the watcher behaves exactly as it did before.
//!
//! Because account edits are persisted by writing the state file, we also
//! watch the data dir and re-reconcile the watched-dir set whenever the state
//! file changes — that, rather than a push from the frontend, is what keeps
//! watched dirs in sync as accounts are added, edited, and deleted. It needs
//! no cooperation from the store that owns the accounts, and it works even
//! when the edit came from another window.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::provider_auth::{
    probe_claude_oauth, probe_claude_oauth_in_dir, probe_codex_oauth, probe_codex_oauth_in_dir,
    ProviderAuthStatus,
};

/// Provider identifiers used in the emitted payload. These match the strings
/// that the frontend already sends to `get_provider_auth_status`.
const PROVIDER_CLAUDE: &str = "claude-oauth";
const PROVIDER_CODEX: &str = "openai-codex";

/// Coalesce window — events arriving within this duration of an earlier
/// event for the same provider are dropped and re-trigger the in-flight
/// emission. Tuned for the login flow, which typically settles within a
/// few hundred ms.
const DEBOUNCE_MS: u64 = 500;
/// A credential writer that never becomes quiet must still update the badge.
const DEBOUNCE_MAX_WAIT_MS: u64 = 5_000;

/// Managed state handle. Holding the watcher in `State<...>` keeps it alive
/// for the process lifetime and lets Tauri drop it on shutdown. The actual
/// `RecommendedWatcher` is stored inside a `Mutex` because `notify` requires
/// `&mut self` for `watch`/`unwatch` and we want the struct to be `Send +
/// Sync` so it can live in `tauri::State`.
pub struct AuthWatcherState {
    _registration: Arc<Mutex<AuthWatchRegistration>>,
}

struct AuthWatchRegistration {
    watcher: RecommendedWatcher,
    watched_paths: HashSet<PathBuf>,
}

/// Identity of one auth surface we can emit a status for.
///
/// `account_id == None` is the ambient default login (`~/.claude` /
/// `~/.codex`) — the only thing that existed before multi-account support.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct AuthKey {
    provider: String,
    account_id: Option<String>,
}

impl AuthKey {
    fn ambient(provider: &str) -> Self {
        Self {
            provider: provider.to_string(),
            account_id: None,
        }
    }
}

/// A registered CLI account, reduced to just what the watcher needs.
#[derive(Clone, Debug, PartialEq, Eq)]
struct WatchedAccount {
    id: String,
    /// One of [`PROVIDER_CLAUDE`] / [`PROVIDER_CODEX`].
    provider: String,
    config_dir: PathBuf,
}

/// Payload for the `provider-auth:changed` event. Shape is intentionally
/// identical to what the frontend would receive from a fresh RPC call so the
/// listener can apply the update without re-fetching.
///
/// `accountId` is omitted entirely for the ambient default, so listeners
/// written before multi-account support see the exact same payload they
/// always did.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthChangedPayload {
    provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    status: ProviderAuthStatus,
}

/// Map a `CliAccount.cli` discriminant onto the provider id used in
/// `provider-auth:changed` / `get_provider_auth_status`.
fn cli_to_provider(cli: &str) -> Option<&'static str> {
    match cli {
        "claude-code" | "claude" => Some(PROVIDER_CLAUDE),
        "codex" | "openai-codex" => Some(PROVIDER_CODEX),
        _ => None,
    }
}

/// Reduce persisted `CliAccount` records to the watcher's view of them.
///
/// Forgiving by design: a record whose `cli` we don't recognise (a future
/// third CLI, or a hand-edited state file) or whose `config_dir` is blank is
/// skipped rather than failing the whole read — a bad row must not take the
/// ambient badges down with it.
fn watched_accounts_from(accounts: &[crate::core::storage::CliAccount]) -> Vec<WatchedAccount> {
    let mut out = Vec::new();
    for account in accounts {
        let Some(provider) = cli_to_provider(account.cli.as_str()) else {
            continue;
        };
        let dir = account.config_dir.trim();
        if dir.is_empty() {
            continue;
        }
        out.push(WatchedAccount {
            id: account.id.clone(),
            provider: provider.to_string(),
            config_dir: PathBuf::from(dir),
        });
    }
    out
}

fn state_file_path() -> PathBuf {
    crate::core::storage::data_dir().join(crate::core::storage::STATE_FILENAME)
}

/// Read the current account list from the persisted `cli_accounts` slice.
///
/// `load_state()` is infallible and defaults `cli_accounts` to empty, so a
/// pre-multi-account state file (or a missing one) yields zero accounts and
/// the watcher behaves exactly as it did before.
fn load_cli_accounts() -> Vec<WatchedAccount> {
    watched_accounts_from(&crate::core::storage::load_state().cli_accounts)
}

fn push_unique(targets: &mut Vec<PathBuf>, path: PathBuf) {
    if !targets.contains(&path) {
        targets.push(path);
    }
}

/// Compute the full set of directories we want watched right now.
///
/// - the ambient `~/.claude` / `~/.codex` when they exist, plus `$HOME` as a
///   fallback so we catch their *first* creation;
/// - the data dir, so a `cli_accounts` change in the state file re-triggers
///   reconciliation;
/// - every account's `configDir`, or its parent when the dir doesn't exist
///   yet (a freshly registered account gets its dir on first login).
fn desired_watch_targets(
    home: &Path,
    claude_dir: &Path,
    codex_dir: &Path,
    data_dir: &Path,
    accounts: &[WatchedAccount],
) -> Vec<PathBuf> {
    let mut targets: Vec<PathBuf> = Vec::new();
    if claude_dir.is_dir() {
        push_unique(&mut targets, claude_dir.to_path_buf());
    }
    if codex_dir.is_dir() {
        push_unique(&mut targets, codex_dir.to_path_buf());
    }
    if (!claude_dir.is_dir() || !codex_dir.is_dir()) && home.is_dir() {
        // Non-recursive watch on $HOME catches the creation of ~/.claude
        // and ~/.codex themselves.
        push_unique(&mut targets, home.to_path_buf());
    }
    if data_dir.is_dir() {
        push_unique(&mut targets, data_dir.to_path_buf());
    }
    for account in accounts {
        if account.config_dir.is_dir() {
            push_unique(&mut targets, account.config_dir.clone());
        } else if let Some(parent) = account.config_dir.parent() {
            if parent.is_dir() {
                push_unique(&mut targets, parent.to_path_buf());
            }
        }
    }
    targets
}

/// Which auth surfaces a filesystem event touches.
fn dirty_keys_for_path(
    path: &Path,
    claude_dir: &Path,
    codex_dir: &Path,
    accounts: &[WatchedAccount],
) -> Vec<AuthKey> {
    let mut keys: Vec<AuthKey> = Vec::new();
    if path_is_in(path, claude_dir) {
        keys.push(AuthKey::ambient(PROVIDER_CLAUDE));
    }
    if path_is_in(path, codex_dir) {
        keys.push(AuthKey::ambient(PROVIDER_CODEX));
    }
    for account in accounts {
        if path_is_in(path, &account.config_dir) {
            let key = AuthKey {
                provider: account.provider.clone(),
                account_id: Some(account.id.clone()),
            };
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}

/// True when a watched path event refers to the persisted state file.
///
/// Matches `state.v1.json` plus the temp/backup siblings an atomic write
/// produces (`state.v1.json.tmp`, …), so we reconcile once the rename lands.
fn is_state_file_event(path: &Path, state_file: &Path) -> bool {
    if path == state_file {
        return true;
    }
    match (
        path.file_name().and_then(|s| s.to_str()),
        state_file.file_name().and_then(|s| s.to_str()),
    ) {
        (Some(name), Some(target)) => name.starts_with(target),
        _ => false,
    }
}

/// Probe the live status for one auth surface. Returns `None` when the key
/// names an account that has since been deleted.
fn probe_for_key(key: &AuthKey, accounts: &[WatchedAccount]) -> Option<ProviderAuthStatus> {
    match &key.account_id {
        None => Some(if key.provider == PROVIDER_CLAUDE {
            probe_claude_oauth()
        } else {
            probe_codex_oauth()
        }),
        Some(id) => {
            let account = accounts.iter().find(|a| &a.id == id)?;
            Some(if account.provider == PROVIDER_CLAUDE {
                probe_claude_oauth_in_dir(&account.config_dir)
            } else {
                probe_codex_oauth_in_dir(&account.config_dir)
            })
        }
    }
}

fn emit_for_key(app: &AppHandle, key: &AuthKey, accounts: &[WatchedAccount]) {
    let Some(status) = probe_for_key(key, accounts) else {
        return;
    };
    let _ = app.emit(
        "provider-auth:changed",
        AuthChangedPayload {
            provider: key.provider.clone(),
            account_id: key.account_id.clone(),
            status,
        },
    );
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
    let data_dir = crate::core::storage::data_dir();
    let state_file = state_file_path();
    let accounts = load_cli_accounts();

    let watch_targets = desired_watch_targets(&home, &claude_dir, &codex_dir, &data_dir, &accounts);
    if watch_targets.is_empty() {
        warn!("auth_watcher: nothing to watch (no home, no provider dirs)");
        return Ok(());
    }

    // Bounded channel — events are cheap, 128 is plenty of headroom.
    let (tx, mut rx) = mpsc::channel::<notify::Result<Event>>(128);

    // The notify callback runs on its own thread. Forward events into the
    // async channel so we can await them in a Tokio task alongside the
    // debounce timer.
    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        // `blocking_send` is fine here — the callback thread is dedicated
        // to the watcher and a momentary stall under backpressure is
        // harmless.
        let _ = tx.blocking_send(res);
    })?;

    let registration = Arc::new(Mutex::new(AuthWatchRegistration {
        watcher,
        watched_paths: HashSet::new(),
    }));
    reconcile_watches(&registration, &watch_targets);

    // Manage the live watcher before the consumer starts so a directory-create
    // event can immediately install the provider-directory watch.
    app_handle.manage(AuthWatcherState {
        _registration: Arc::clone(&registration),
    });

    // Spawn the consumer task. It owns the receiver and debounces per
    // (provider, account) before emitting.
    let app_for_task = app_handle.clone();
    let home_for_task = home;
    let claude_dir_for_task = claude_dir;
    let codex_dir_for_task = codex_dir;
    let data_dir_for_task = data_dir;
    let registration_for_task = Arc::clone(&registration);
    tauri::async_runtime::spawn(async move {
        // F16: trailing-edge debounce. A login writes the cred file several times
        // in quick succession; a leading-edge debounce emitted on the FIRST event
        // (re-probing a half-written file) and dropped every later event —
        // including the final authoritative write. Instead we accumulate which
        // surfaces changed and emit a fresh probe only once the burst has been
        // quiet for the debounce window, so the emitted status is the settled one.
        let settle = Duration::from_millis(DEBOUNCE_MS);
        let max_wait = Duration::from_millis(DEBOUNCE_MAX_WAIT_MS);
        let mut accounts = accounts;
        // Keyed by (provider, accountId) — generalised from the original pair
        // of `dirty_claude` / `dirty_codex` booleans, which could only ever
        // describe the two ambient logins.
        let mut dirty: HashSet<AuthKey> = HashSet::new();
        let mut accounts_dirty = false;
        let mut dirty_since: Option<tokio::time::Instant> = None;
        loop {
            let next = if !dirty.is_empty() || accounts_dirty {
                let elapsed = dirty_since
                    .map(|started| started.elapsed())
                    .unwrap_or_default();
                let wait = settle.min(max_wait.saturating_sub(elapsed));
                match tokio::time::timeout(wait, rx.recv()).await {
                    Ok(v) => v,
                    Err(_) => {
                        // Quiescent for the debounce window — flush the trailing,
                        // authoritative state with a fresh probe per dirty surface.
                        //
                        // Reconcile the account list FIRST so a just-registered
                        // account is resolvable by the probes below.
                        if accounts_dirty {
                            accounts_dirty = false;
                            let fresh = load_cli_accounts();
                            if fresh != accounts {
                                accounts = fresh;
                                reconcile_watches(
                                    &registration_for_task,
                                    &desired_watch_targets(
                                        &home_for_task,
                                        &claude_dir_for_task,
                                        &codex_dir_for_task,
                                        &data_dir_for_task,
                                        &accounts,
                                    ),
                                );
                            }
                        }
                        for key in dirty.drain() {
                            emit_for_key(&app_for_task, &key, &accounts);
                        }
                        dirty_since = None;
                        continue;
                    }
                }
            } else {
                rx.recv().await
            };

            let Some(res) = next else {
                // Teardown normally has no consumer, but flushing here keeps
                // the contract correct for an explicitly closed registration.
                for key in dirty.drain() {
                    emit_for_key(&app_for_task, &key, &accounts);
                }
                break;
            };
            let event = match res {
                Ok(ev) => ev,
                Err(e) => {
                    warn!("auth_watcher: event error: {}", e);
                    continue;
                }
            };

            // Upgrade fallback watches to the real directory as soon as it
            // appears — for the ambient dirs and for each account's configDir.
            for dir in [&claude_dir_for_task, &codex_dir_for_task] {
                if event.paths.iter().any(|path| path_is_in(path, dir)) {
                    ensure_provider_directory_watch(&registration_for_task, dir);
                }
            }
            for account in &accounts {
                if event
                    .paths
                    .iter()
                    .any(|path| path_is_in(path, &account.config_dir))
                {
                    ensure_provider_directory_watch(&registration_for_task, &account.config_dir);
                }
            }

            // Mark which surface(s) this event affects; the actual probe + emit
            // happens on the trailing edge above.
            let was_clean = dirty.is_empty() && !accounts_dirty;
            for path in &event.paths {
                if is_state_file_event(path, &state_file) {
                    accounts_dirty = true;
                }
                for key in
                    dirty_keys_for_path(path, &claude_dir_for_task, &codex_dir_for_task, &accounts)
                {
                    dirty.insert(key);
                }
            }
            if was_clean && (!dirty.is_empty() || accounts_dirty) {
                dirty_since = Some(tokio::time::Instant::now());
            }
        }
    });

    Ok(())
}

/// Bring the live watch registration in line with `desired`: add watches for
/// newly wanted dirs, drop watches for dirs that fell out of the set (e.g.
/// the configDir of a deleted account).
fn reconcile_watches(registration: &Arc<Mutex<AuthWatchRegistration>>, desired: &[PathBuf]) {
    let Ok(mut reg) = registration.lock() else {
        warn!("auth_watcher: watch registration mutex poisoned");
        return;
    };
    let wanted: HashSet<PathBuf> = desired.iter().cloned().collect();

    let stale: Vec<PathBuf> = reg
        .watched_paths
        .iter()
        .filter(|p| !wanted.contains(*p))
        .cloned()
        .collect();
    for path in stale {
        if let Err(e) = reg.watcher.unwatch(&path) {
            warn!("auth_watcher: failed to unwatch {:?}: {}", path, e);
        } else {
            info!("auth_watcher: stopped watching {:?}", path);
        }
        reg.watched_paths.remove(&path);
    }

    for target in desired {
        if reg.watched_paths.contains(target) {
            continue;
        }
        // Non-recursive: credential files are direct children of the
        // watched dirs. Recursive would just waste cycles on unrelated
        // files (e.g. `~/.claude/todos/*`).
        if let Err(e) = reg.watcher.watch(target, RecursiveMode::NonRecursive) {
            warn!("auth_watcher: failed to watch {:?}: {}", target, e);
        } else {
            info!("auth_watcher: watching {:?}", target);
            reg.watched_paths.insert(target.clone());
        }
    }
}

fn ensure_provider_directory_watch(
    registration: &Arc<Mutex<AuthWatchRegistration>>,
    directory: &Path,
) {
    if !directory.is_dir() {
        return;
    }
    let Ok(mut registration) = registration.lock() else {
        warn!("auth_watcher: watch registration mutex poisoned");
        return;
    };
    if registration.watched_paths.contains(directory) {
        return;
    }
    match registration
        .watcher
        .watch(directory, RecursiveMode::NonRecursive)
    {
        Ok(()) => {
            registration.watched_paths.insert(directory.to_path_buf());
            info!("auth_watcher: watching newly-created {:?}", directory);
        }
        Err(e) => warn!(
            "auth_watcher: failed to watch newly-created {:?}: {}",
            directory, e
        ),
    }
}

/// True if `candidate` is the same as `dir` or a direct/indirect child of it.
fn path_is_in(candidate: &Path, dir: &Path) -> bool {
    candidate == dir || candidate.starts_with(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn account(id: &str, provider: &str, dir: &Path) -> WatchedAccount {
        WatchedAccount {
            id: id.to_string(),
            provider: provider.to_string(),
            config_dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn provider_directory_create_and_later_credential_paths_match() {
        let dir = Path::new("C:/Users/test/.codex");
        assert!(path_is_in(Path::new("C:/Users/test/.codex"), dir));
        assert!(path_is_in(Path::new("C:/Users/test/.codex/auth.json"), dir));
        assert!(!path_is_in(Path::new("C:/Users/test/.claude"), dir));
    }

    // --- cli_accounts slice mapping -------------------------------------

    fn persisted(id: &str, cli: &str, config_dir: &str) -> crate::core::storage::CliAccount {
        crate::core::storage::CliAccount {
            id: id.to_string(),
            label: format!("label-{}", id),
            cli: cli.to_string(),
            config_dir: config_dir.to_string(),
            email: None,
            created_at: 0,
            last_used_at: None,
        }
    }

    #[test]
    fn watched_accounts_map_both_clis_to_provider_ids() {
        let accounts = watched_accounts_from(&[
            persisted("acct-1", "claude-code", "/home/u/.claude-oss"),
            persisted("acct-2", "codex", "/home/u/.codex-client"),
        ]);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].id, "acct-1");
        assert_eq!(accounts[0].provider, PROVIDER_CLAUDE);
        assert_eq!(accounts[0].config_dir, PathBuf::from("/home/u/.claude-oss"));
        assert_eq!(accounts[1].provider, PROVIDER_CODEX);
    }

    #[test]
    fn watched_accounts_empty_slice_is_ambient_only() {
        // The pre-multi-account state file deserializes to an empty slice;
        // the watcher must then behave exactly as it did before.
        assert!(watched_accounts_from(&[]).is_empty());
    }

    #[test]
    fn watched_accounts_skip_unknown_cli_and_blank_dirs() {
        let accounts = watched_accounts_from(&[
            persisted("a", "gemini", "/a"),
            persisted("b", "codex", "   "),
            persisted("c", "claude-code", "/c"),
        ]);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "c");
    }

    // --- watched-dir registration ---------------------------------------

    #[test]
    fn desired_watch_targets_includes_every_account_config_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        let data = home.join(".packetbench");
        let oss = tmp.path().join("claude-oss");
        let client = tmp.path().join("codex-client");
        for d in [&home, &claude, &codex, &data, &oss, &client] {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        let accounts = vec![
            account("a1", PROVIDER_CLAUDE, &oss),
            account("a2", PROVIDER_CODEX, &client),
        ];
        let targets = desired_watch_targets(&home, &claude, &codex, &data, &accounts);
        assert!(targets.contains(&claude), "{:?}", targets);
        assert!(targets.contains(&codex), "{:?}", targets);
        assert!(targets.contains(&data), "state file must be watched");
        assert!(targets.contains(&oss), "account dir must be watched");
        assert!(targets.contains(&client), "account dir must be watched");
    }

    #[test]
    fn desired_watch_targets_falls_back_to_parent_for_missing_account_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        let data = home.join(".packetbench");
        std::fs::create_dir_all(&home).expect("mkdir");
        let not_yet = tmp.path().join("accounts").join("fresh");
        std::fs::create_dir_all(not_yet.parent().unwrap()).expect("mkdir");
        let accounts = vec![account("a1", PROVIDER_CLAUDE, &not_yet)];
        let targets = desired_watch_targets(&home, &claude, &codex, &data, &accounts);
        assert!(!targets.contains(&not_yet));
        assert!(
            targets.contains(&not_yet.parent().unwrap().to_path_buf()),
            "{:?}",
            targets
        );
    }

    #[test]
    fn desired_watch_targets_drops_deleted_account_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        let data = home.join(".packetbench");
        let gone = tmp.path().join("removed-account");
        for d in [&home, &claude, &codex, &data, &gone] {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        let with_account = desired_watch_targets(
            &home,
            &claude,
            &codex,
            &data,
            &[account("a1", PROVIDER_CODEX, &gone)],
        );
        assert!(with_account.contains(&gone));
        let without = desired_watch_targets(&home, &claude, &codex, &data, &[]);
        assert!(
            !without.contains(&gone),
            "removing the account must drop its dir from the desired set"
        );
    }

    // --- dirty-key routing ----------------------------------------------

    #[test]
    fn dirty_keys_route_ambient_dirs_to_account_less_keys() {
        let claude = Path::new("/home/u/.claude");
        let codex = Path::new("/home/u/.codex");
        let keys = dirty_keys_for_path(
            Path::new("/home/u/.claude/.credentials.json"),
            claude,
            codex,
            &[],
        );
        assert_eq!(keys, vec![AuthKey::ambient(PROVIDER_CLAUDE)]);
        assert!(keys[0].account_id.is_none());
    }

    #[test]
    fn dirty_keys_route_account_dirs_to_account_keys() {
        let claude = Path::new("/home/u/.claude");
        let codex = Path::new("/home/u/.codex");
        let oss = Path::new("/home/u/claude-oss");
        let accounts = vec![account("acct-1", PROVIDER_CLAUDE, oss)];
        let keys = dirty_keys_for_path(
            Path::new("/home/u/claude-oss/.credentials.json"),
            claude,
            codex,
            &accounts,
        );
        assert_eq!(
            keys,
            vec![AuthKey {
                provider: PROVIDER_CLAUDE.to_string(),
                account_id: Some("acct-1".to_string()),
            }]
        );
    }

    #[test]
    fn dirty_keys_for_unrelated_path_are_empty() {
        let keys = dirty_keys_for_path(
            Path::new("/home/u/projects/foo"),
            Path::new("/home/u/.claude"),
            Path::new("/home/u/.codex"),
            &[account("a", PROVIDER_CODEX, Path::new("/home/u/codex-alt"))],
        );
        assert!(keys.is_empty());
    }

    #[test]
    fn dirty_keys_report_both_when_account_dir_is_the_ambient_dir() {
        // A user may register the ambient dir as an explicit account; both
        // the ambient badge and the account badge must refresh.
        let claude = Path::new("/home/u/.claude");
        let accounts = vec![account("acct-1", PROVIDER_CLAUDE, claude)];
        let keys = dirty_keys_for_path(
            Path::new("/home/u/.claude/.credentials.json"),
            claude,
            Path::new("/home/u/.codex"),
            &accounts,
        );
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().any(|k| k.account_id.is_none()));
        assert!(keys
            .iter()
            .any(|k| k.account_id.as_deref() == Some("acct-1")));
    }

    // --- state-file detection -------------------------------------------

    #[test]
    fn state_file_events_include_atomic_write_siblings() {
        let state = Path::new("/home/u/.packetbench/state.v1.json");
        assert!(is_state_file_event(state, state));
        assert!(is_state_file_event(
            Path::new("/home/u/.packetbench/state.v1.json.tmp"),
            state
        ));
        assert!(!is_state_file_event(
            Path::new("/home/u/.packetbench/analytics.json"),
            state
        ));
    }

    // --- payload shape ---------------------------------------------------

    #[test]
    fn payload_omits_account_id_for_ambient_default() {
        let json = serde_json::to_value(AuthChangedPayload {
            provider: PROVIDER_CLAUDE.to_string(),
            account_id: None,
            status: ProviderAuthStatus {
                status: "ready".to_string(),
                hint: String::new(),
            },
        })
        .unwrap();
        assert_eq!(json.get("provider").unwrap(), PROVIDER_CLAUDE);
        assert!(
            json.get("accountId").is_none(),
            "existing listeners must see the pre-multi-account payload verbatim"
        );
        assert_eq!(json.get("status").unwrap().get("status").unwrap(), "ready");
    }

    #[test]
    fn payload_carries_camel_case_account_id_for_accounts() {
        let json = serde_json::to_value(AuthChangedPayload {
            provider: PROVIDER_CODEX.to_string(),
            account_id: Some("acct-7".to_string()),
            status: ProviderAuthStatus {
                status: "login_required".to_string(),
                hint: "x".to_string(),
            },
        })
        .unwrap();
        assert_eq!(json.get("accountId").unwrap(), "acct-7");
        assert!(json.get("account_id").is_none());
    }

    // --- probe routing ---------------------------------------------------

    #[test]
    fn probe_for_key_uses_the_accounts_own_config_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("codex-client");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let accounts = vec![account("acct-1", PROVIDER_CODEX, &dir)];
        let status = probe_for_key(
            &AuthKey {
                provider: PROVIDER_CODEX.to_string(),
                account_id: Some("acct-1".to_string()),
            },
            &accounts,
        )
        .expect("account exists");
        // Empty dir -> not logged in for this account, regardless of whether
        // the developer running the test is logged into ambient codex.
        assert_eq!(status.status, "login_required");
    }

    #[test]
    fn probe_for_key_returns_none_for_deleted_account() {
        assert!(probe_for_key(
            &AuthKey {
                provider: PROVIDER_CODEX.to_string(),
                account_id: Some("gone".to_string()),
            },
            &[],
        )
        .is_none());
    }
}
