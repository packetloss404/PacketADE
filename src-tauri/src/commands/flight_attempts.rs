//! Async parallel agent attempts on Flights ("one prompt → N agents").
//!
//! Each attempt provisions a git worktree (local or remote SSH), starts an
//! API agent session bound to that worktree, and is persisted as an
//! `Attempt` on the Flight. Cancellation removes the worktree and closes
//! the session.

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::api_agent::{close_api_agent_session, start_api_agent_session, ApiAgentState};
use crate::core::execution::SshConfig;
use crate::core::flight::{Attempt, AttemptStatus, AttemptTarget, ReviewGateStatus};
use crate::core::storage;
use crate::core::worktree;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttemptTargetSpec {
    Local {
        base_path: String,
        base_branch: String,
        agent_config_id: String,
        provider: String,
        model: String,
        #[serde(default)]
        task_id: Option<String>,
    },
    Ssh {
        target_id: String,
        host: String,
        port: u16,
        user: String,
        #[serde(default)]
        key_path: Option<String>,
        #[serde(default)]
        auth_method: Option<String>,
        /// Pinned SHA256 host-key fingerprint, copied from the saved
        /// `ServerConfig.hostFingerprint`. When present, the per-attempt
        /// `SshConfig` uses strict host-key checking against the
        /// app-managed `known_hosts` file. When absent (legacy entries),
        /// the runtime falls back to TOFU `accept-new` and logs a warning.
        #[serde(default)]
        host_fingerprint: Option<String>,
        base_path: String,
        base_branch: String,
        agent_config_id: String,
        provider: String,
        model: String,
        #[serde(default)]
        task_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetAttemptStatus {
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathClaim {
    scope: String,
    path: String,
    display_path: String,
    branch: String,
    case_sensitive: bool,
}

fn normalize_claimed_path(path: &str, case_sensitive: bool) -> String {
    let mut normalized = String::with_capacity(path.len());
    let mut previous_was_slash = false;
    for ch in path.trim().replace('\\', "/").chars() {
        if ch == '/' {
            if !previous_was_slash {
                normalized.push(ch);
            }
            previous_was_slash = true;
        } else {
            if case_sensitive {
                normalized.push(ch);
            } else {
                normalized.push(ch.to_ascii_lowercase());
            }
            previous_was_slash = false;
        }
    }
    while normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
        .strip_prefix("./")
        .unwrap_or(&normalized)
        .to_string()
}

fn claimed_paths_overlap(left: &str, right: &str, case_sensitive: bool) -> bool {
    let a = normalize_claimed_path(left, case_sensitive);
    let b = normalize_claimed_path(right, case_sensitive);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a.clone() + "/"))
}

fn normalize_branch(branch: &str) -> String {
    let branch = branch.trim().to_ascii_lowercase();
    if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    }
}

fn target_spec_claim(spec: &AttemptTargetSpec) -> Option<PathClaim> {
    match spec {
        AttemptTargetSpec::Local {
            base_path,
            base_branch,
            ..
        } => {
            let path = normalize_claimed_path(base_path, false);
            if path.is_empty() {
                return None;
            }
            Some(PathClaim {
                scope: "local".to_string(),
                path,
                display_path: base_path.clone(),
                branch: normalize_branch(base_branch),
                case_sensitive: false,
            })
        }
        AttemptTargetSpec::Ssh {
            target_id,
            host,
            port,
            user,
            base_path,
            base_branch,
            ..
        } => {
            let path = normalize_claimed_path(base_path, true);
            if path.is_empty() {
                return None;
            }
            let scope = if target_id.trim().is_empty() {
                format!("ssh:{}@{}:{}", user, host, port)
            } else {
                format!("ssh:{}", target_id)
            };
            let display_target = if target_id.trim().is_empty() {
                format!("{}@{}:{}", user, host, port)
            } else {
                target_id.clone()
            };
            Some(PathClaim {
                scope,
                path,
                display_path: format!("{}:{}", display_target, base_path),
                branch: normalize_branch(base_branch),
                case_sensitive: true,
            })
        }
    }
}

fn attempt_claim(attempt: &Attempt) -> Option<PathClaim> {
    let (scope, base_path, case_sensitive) = match &attempt.target {
        AttemptTarget::Local { base_path, .. } => ("local".to_string(), base_path.clone(), false),
        AttemptTarget::Ssh {
            server_id,
            base_path,
            ..
        } => (format!("ssh:{}", server_id), base_path.clone(), true),
    };
    let path = normalize_claimed_path(&base_path, case_sensitive);
    if path.is_empty() {
        return None;
    }
    Some(PathClaim {
        scope,
        path,
        display_path: base_path,
        branch: normalize_branch(&attempt.base_branch),
        case_sensitive,
    })
}

fn claims_overlap(left: &PathClaim, right: &PathClaim) -> bool {
    left.scope == right.scope
        && left.branch == right.branch
        && claimed_paths_overlap(
            &left.path,
            &right.path,
            left.case_sensitive || right.case_sensitive,
        )
}

fn validate_target_identities(targets: &[AttemptTargetSpec]) -> Result<(), String> {
    for (index, target) in targets.iter().enumerate() {
        if let AttemptTargetSpec::Ssh { target_id, .. } = target {
            if target_id.trim().is_empty() {
                return Err(format!(
                    "path_collision: target {} is missing ssh target_id; save/select the SSH server before launching",
                    index + 1
                ));
            }
        }
    }
    Ok(())
}

/// Security boundary (#8a): refuse to launch an async/agent attempt against an
/// SSH target whose host key has not been pinned. `core/execution.rs` falls back
/// to `StrictHostKeyChecking=accept-new` (TOFU) when `host_fingerprint` is None,
/// which is acceptable for the *interactive* PTY/workspace path but is a silent
/// MITM window for the non-interactive async launch path. Fail closed here,
/// before any connection (or worktree provisioning) is attempted, so every async
/// SSH attempt is covered. Local (non-SSH) targets are ignored.
fn validate_ssh_pinning(targets: &[AttemptTargetSpec]) -> Result<(), String> {
    for target in targets {
        if let AttemptTargetSpec::Ssh {
            host,
            host_fingerprint,
            ..
        } = target
        {
            let pinned = host_fingerprint
                .as_deref()
                .map(str::trim)
                .is_some_and(|fp| !fp.is_empty());
            if !pinned {
                return Err(format!(
                    "Refusing to launch against {}: host key not verified. Pin it on the Servers page first.",
                    host
                ));
            }
        }
    }
    Ok(())
}

fn validate_target_claims(targets: &[AttemptTargetSpec]) -> Result<(), String> {
    let claims: Vec<(usize, PathClaim)> = targets
        .iter()
        .enumerate()
        .filter_map(|(index, target)| target_spec_claim(target).map(|claim| (index, claim)))
        .collect();

    for i in 0..claims.len() {
        for j in (i + 1)..claims.len() {
            let (left_index, left) = &claims[i];
            let (right_index, right) = &claims[j];
            if claims_overlap(left, right) {
                return Err(format!(
                    "path_collision: selected targets {} and {} both claim {} on {}",
                    left_index + 1,
                    right_index + 1,
                    left.display_path,
                    left.branch
                ));
            }
        }
    }

    Ok(())
}

fn validate_target_claims_against_active_attempts(
    targets: &[AttemptTargetSpec],
) -> Result<(), String> {
    let target_claims: Vec<(usize, PathClaim)> = targets
        .iter()
        .enumerate()
        .filter_map(|(index, target)| target_spec_claim(target).map(|claim| (index, claim)))
        .collect();
    let state = storage::load_state();

    for flight in &state.flights {
        for existing in &flight.attempts {
            if !is_active_attempt(existing.status) {
                continue;
            }
            let Some(existing_claim) = attempt_claim(existing) else {
                continue;
            };
            for (target_index, target_claim) in &target_claims {
                if claims_overlap(target_claim, &existing_claim) {
                    return Err(format!(
                        "path_collision: target {} claims {} but attempt {} is already {:?} on {} ({})",
                        target_index + 1,
                        target_claim.display_path,
                        existing.id,
                        existing.status,
                        existing_claim.display_path,
                        existing_claim.branch
                    ));
                }
            }
        }
    }

    Ok(())
}

fn is_active_attempt(status: AttemptStatus) -> bool {
    matches!(
        status,
        AttemptStatus::Queued | AttemptStatus::Provisioning | AttemptStatus::Running
    )
}

fn should_apply_attempt_status(current: AttemptStatus, next: AttemptStatus) -> bool {
    next != AttemptStatus::Running || is_active_attempt(current)
}

fn active_attempt_collision_message(incoming: &Attempt, existing: &Attempt) -> Option<String> {
    if !is_active_attempt(existing.status) {
        return None;
    }
    let incoming_claim = attempt_claim(incoming)?;
    let existing_claim = attempt_claim(existing)?;
    if !claims_overlap(&incoming_claim, &existing_claim) {
        return None;
    }
    Some(format!(
        "path_collision: attempt {} is already {:?} on {} ({})",
        existing.id, existing.status, existing_claim.display_path, existing_claim.branch
    ))
}

async fn cleanup_unpersisted_attempt(
    spec: &AttemptTargetSpec,
    target: &AttemptTarget,
    attempt_id: &str,
) {
    match target {
        AttemptTarget::Local { base_path, .. } => {
            if let Err(e) = worktree::remove_local_worktree(base_path, attempt_id, false).await {
                warn!(
                    attempt = %attempt_id,
                    error = %e,
                    "Local worktree cleanup after rejected attempt failed"
                );
            }
        }
        AttemptTarget::Ssh { base_path, .. } => {
            let Some(cfg) = build_ssh_config_from_spec(spec) else {
                warn!(
                    attempt = %attempt_id,
                    "SSH worktree cleanup after rejected attempt skipped: missing SSH config"
                );
                return;
            };
            if let Err(e) = worktree::remove_remote_worktree(&cfg, base_path, attempt_id).await {
                warn!(
                    attempt = %attempt_id,
                    error = %e,
                    "SSH worktree cleanup after rejected attempt failed"
                );
            }
        }
    }
}

async fn append_attempt(
    flight_id: &str,
    attempt: &Attempt,
    allow_path_collisions: bool,
    prompt: Option<String>,
) -> Result<(), String> {
    // v0.8 race-fix: use `with_state_lock` so concurrent async writers
    // (e.g. multiple `launch_flight_async` invocations or interleaving with
    // `mark_attempt_status`) can't lose each other's mutations via the old
    // naked load → mutate → save.
    let flight_id = flight_id.to_string();
    let attempt = attempt.clone();
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            if !state.flights.iter().any(|f| f.id == flight_id) {
                return Err(format!("Flight '{}' not found", flight_id));
            }
            if !allow_path_collisions {
                for existing_flight in &state.flights {
                    for existing in &existing_flight.attempts {
                        if existing.id == attempt.id {
                            continue;
                        }
                        if let Some(message) = active_attempt_collision_message(&attempt, existing)
                        {
                            return Err(message);
                        }
                    }
                }
            }
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            if flight.prompt.is_none() {
                flight.prompt = prompt;
            }
            flight.attempts.push(attempt);
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

async fn update_attempt_status(
    flight_id: &str,
    attempt_id: &str,
    status: AttemptStatus,
    error: Option<String>,
) -> Result<(), String> {
    // v0.8 race-fix: see `append_attempt` rationale. Concurrent writers
    // through the old naked load/save could drop each other's status flips.
    let flight_id = flight_id.to_string();
    let attempt_id = attempt_id.to_string();
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            if status == AttemptStatus::Completed
                && flight
                    .review_gate_policy
                    .as_ref()
                    .is_some_and(|policy| policy.enabled)
            {
                let gate = flight
                    .attempts
                    .iter()
                    .find(|a| a.id == attempt_id)
                    .and_then(|attempt| attempt.review_gate.as_ref())
                    .ok_or_else(|| {
                        "Reviewer Gate has not produced a verdict; acceptance is blocked."
                            .to_string()
                    })?;
                let allowed = match gate.status {
                    ReviewGateStatus::Passed => true,
                    ReviewGateStatus::Overridden => {
                        gate.overridden_at.is_some()
                            && gate
                                .override_reason
                                .as_deref()
                                .is_some_and(|reason| !reason.trim().is_empty())
                    }
                    _ => false,
                };
                if !allowed {
                    return Err(
                        "Reviewer Gate must pass or have a recorded override before acceptance."
                            .to_string(),
                    );
                }
            }
            let attempt = flight
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            if !should_apply_attempt_status(attempt.status, status) {
                return Ok(());
            }
            attempt.status = status;
            if matches!(
                status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                attempt.completed_at = Some(now_ms());
            }
            record_attempt_error(attempt, status, error);
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// Record a terminal error on an attempt. On a `Failed` transition with a
/// message, also derive a structured `failure_category` via the shared
/// classifier (E1) so the UI can show a category, not just free text.
fn record_attempt_error(attempt: &mut Attempt, status: AttemptStatus, error: Option<String>) {
    if let Some(msg) = error {
        if status == AttemptStatus::Failed {
            attempt.failure_category = Some(
                crate::core::error_classifier::classify_cli_error(&msg)
                    .category
                    .as_str()
                    .to_string(),
            );
        }
        attempt.error_message = Some(msg);
    }
}

fn apply_attempt_status_by_session(
    state: &mut storage::PersistedState,
    session_id: &str,
    status: AttemptStatus,
    error: Option<String>,
) -> bool {
    for flight in &mut state.flights {
        if let Some(attempt) = flight
            .attempts
            .iter_mut()
            .find(|attempt| attempt.session_id == session_id)
        {
            if !is_active_attempt(attempt.status) {
                return false;
            }
            attempt.status = status;
            if matches!(
                status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                attempt.completed_at = Some(now_ms());
            }
            record_attempt_error(attempt, status, error);
            flight.updated_at = now_ms();
            return true;
        }
    }
    false
}

pub async fn update_attempt_status_by_session(
    session_id: &str,
    status: AttemptStatus,
    error: Option<String>,
) -> Result<bool, String> {
    let session_id = session_id.to_string();
    storage::with_state_lock(move |state| {
        let updated = apply_attempt_status_by_session(state, &session_id, status, error);
        std::future::ready(Ok(updated))
    })
    .await
}

/// S4: build an `SshConfig` for a persisted attempt (which stores only
/// `target_id` + paths, not the connection details) by re-resolving the saved
/// `ServerConfig` from storage — the backend analogue of the frontend's
/// `serverStore` lookup. Crucially this carries `host_fingerprint`, so a
/// backend-initiated cancel/cleanup pins the host key exactly like the
/// spec-driven path, instead of deferring to the frontend or falling back to
/// TOFU. Returns `None` if the server is no longer configured.
fn resolve_server_ssh_config(target_id: &str, base_path: &str) -> Option<SshConfig> {
    let state = storage::load_state();
    let server = state.servers.iter().find(|s| s.id == target_id)?;
    Some(ssh_config_from_server(server, base_path))
}

/// Pure mapping from a saved `ServerConfig` to a per-cleanup `SshConfig`. Split
/// out from the storage lookup so the fingerprint-propagation contract (S4) is
/// unit-testable without touching disk.
fn ssh_config_from_server(
    server: &crate::core::storage::ServerConfig,
    base_path: &str,
) -> SshConfig {
    SshConfig {
        host: server.host.clone(),
        port: server.port,
        user: server.username.clone(),
        remote_path: base_path.to_string(),
        key_path: server.key_path.clone(),
        auth_method: Some(server.auth_method.clone()),
        target_id: Some(server.id.clone()),
        host_fingerprint: server.host_fingerprint.clone(),
    }
}

fn build_ssh_config_from_spec(spec: &AttemptTargetSpec) -> Option<SshConfig> {
    if let AttemptTargetSpec::Ssh {
        target_id,
        host,
        port,
        user,
        key_path,
        auth_method,
        host_fingerprint,
        base_path,
        ..
    } = spec
    {
        Some(SshConfig {
            host: host.clone(),
            port: *port,
            user: user.clone(),
            remote_path: base_path.clone(),
            key_path: key_path.clone(),
            auth_method: auth_method.clone(),
            target_id: Some(target_id.clone()),
            // Phase 2: propagate the saved `ServerConfig.hostFingerprint`
            // from the picker through the spec so flight attempts pin
            // host keys instead of falling back to TOFU.
            host_fingerprint: host_fingerprint.clone(),
        })
    } else {
        None
    }
}

#[tauri::command]
pub async fn launch_flight_async(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    prompt: String,
    targets: Vec<AttemptTargetSpec>,
    allow_path_collisions: Option<bool>,
) -> Result<Vec<Attempt>, String> {
    if targets.is_empty() {
        return Err("At least one target is required".to_string());
    }
    let allow_path_collisions = allow_path_collisions.unwrap_or(false);
    validate_target_identities(&targets)?;
    // #8a: fail closed on unpinned SSH targets before any connection/provisioning.
    validate_ssh_pinning(&targets)?;
    if !allow_path_collisions {
        validate_target_claims(&targets)?;
        validate_target_claims_against_active_attempts(&targets)?;
    }

    // v0.8: capture the flight title so the worktree's auto-trailer
    // hook can substitute `{flightTitle}` into the rendered trailer.
    // Read once up front rather than per-attempt so we don't pay the
    // disk hit N times. Missing flight → empty title (the auto-trailer
    // still works, just with the placeholder elided).
    let flight_title = {
        let flight_id = flight_id.clone();
        tokio::task::spawn_blocking(move || {
            storage::load_state()
                .flights
                .into_iter()
                .find(|f| f.id == flight_id)
                .map(|f| f.title)
                .unwrap_or_default()
        })
        .await
        .map_err(|e| format!("flight title lookup join error: {}", e))?
    };

    let mut launched: Vec<Attempt> = Vec::new();

    for spec in targets {
        let attempt_id = format!("att_{}", Uuid::new_v4().simple());
        let session_id = attempt_id.clone();
        let branch = worktree::branch_name(&attempt_id);
        let task_id = match &spec {
            AttemptTargetSpec::Local { task_id, .. } | AttemptTargetSpec::Ssh { task_id, .. } => {
                task_id.clone()
            }
        };

        let flight = worktree::WorktreeFlight {
            flight_id: Some(flight_id.clone()),
            flight_title: Some(flight_title.clone()),
        };

        let (target, ssh_config_for_session, agent_config_id, provider, model, base_branch) =
            match &spec {
                AttemptTargetSpec::Local {
                    base_path,
                    base_branch,
                    agent_config_id,
                    provider,
                    model,
                    ..
                } => {
                    let path = worktree::create_local_worktree_with_flight(
                        base_path,
                        &attempt_id,
                        base_branch,
                        flight.clone(),
                    )
                    .await
                    .map_err(|e| format!("Local worktree provision failed: {}", e))?;
                    (
                        AttemptTarget::Local {
                            base_path: base_path.clone(),
                            worktree_path: path,
                        },
                        None,
                        agent_config_id.clone(),
                        provider.clone(),
                        model.clone(),
                        base_branch.clone(),
                    )
                }
                AttemptTargetSpec::Ssh {
                    base_path,
                    base_branch,
                    agent_config_id,
                    provider,
                    model,
                    ..
                } => {
                    // #8a defense-in-depth: re-enforce host-key pinning at the
                    // connection boundary so this remains fail-closed even if a
                    // future caller reaches the build site without the upfront
                    // `validate_ssh_pinning` gate. `build_ssh_config_from_spec`
                    // copies `host_fingerprint` verbatim and `core/execution.rs`
                    // would otherwise TOFU-fallback to `accept-new`.
                    validate_ssh_pinning(std::slice::from_ref(&spec))?;
                    let cfg =
                        build_ssh_config_from_spec(&spec).ok_or("Failed to build SshConfig")?;
                    let path =
                        worktree::create_remote_worktree(&cfg, base_path, &attempt_id, base_branch)
                            .await
                            .map_err(|e| format!("Remote worktree provision failed: {}", e))?;
                    // SshConfig used by the API agent session must point at the
                    // worktree, not the original base path, so all tool calls
                    // operate inside the attempt's worktree.
                    let session_cfg = SshConfig {
                        remote_path: path.clone(),
                        ..cfg.clone()
                    };
                    (
                        AttemptTarget::Ssh {
                            server_id: cfg.target_id.clone().unwrap_or_default(),
                            base_path: base_path.clone(),
                            worktree_path: path,
                        },
                        Some(session_cfg),
                        agent_config_id.clone(),
                        provider.clone(),
                        model.clone(),
                        base_branch.clone(),
                    )
                }
            };

        // For Local targets, pass the worktree path as the project_path so the
        // API agent's tool runtime executes inside the worktree.
        let project_path = match &target {
            AttemptTarget::Local { worktree_path, .. } => worktree_path.clone(),
            AttemptTarget::Ssh { worktree_path, .. } => worktree_path.clone(),
        };

        let attempt = Attempt {
            id: attempt_id.clone(),
            flight_id: flight_id.clone(),
            target,
            agent_config_id: agent_config_id.clone(),
            model: model.clone(),
            provider: provider.clone(),
            branch,
            base_branch,
            session_id: session_id.clone(),
            status: AttemptStatus::Provisioning,
            started_at: Some(now_ms()),
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            error_message: None,
            failure_category: None,
            review_gate: None,
            task_id,
            draft_pr_number: None,
        };

        if let Err(e) = append_attempt(
            &flight_id,
            &attempt,
            allow_path_collisions,
            Some(prompt.clone()),
        )
        .await
        {
            warn!(error = %e, "Failed to persist Attempt; aborting");
            cleanup_unpersisted_attempt(&spec, &attempt.target, &attempt_id).await;
            return Err(e);
        }

        // Hand off to the existing API agent session machinery. session_id is
        // shared with the agentTaskStore conversation id on the frontend so
        // the AttemptTile can subscribe to streaming events.
        let (final_status, final_error) = match start_api_agent_session(
            app_handle.clone(),
            state.clone(),
            sidecar.clone(),
            session_id.clone(),
            provider.clone(),
            model.clone(),
            project_path,
            prompt.clone(),
            None,        // system_prompt_override — use default
            Some(false), // thinking_enabled
            None,        // attachments
            Some(false), // plan_mode
            ssh_config_for_session,
            None,        // allowed_tools — flight attempts use full tool set
            None,        // resume_token — flights start fresh
            None,        // enabled_mcp_server_ids — flights use all enabled MCP servers
            None,        // mcp_trust_snapshot — conservative read-only migration
            None,        // resume_messages — flights start fresh
            None,        // permission_mode — default auto
            Some(false), // approve_writes
            None,        // command_path
            None,        // workspace — derived from ssh_config/local project_path
        )
        .await
        {
            Ok(()) => {
                let _ =
                    update_attempt_status(&flight_id, &attempt_id, AttemptStatus::Running, None)
                        .await;
                (AttemptStatus::Running, None)
            }
            Err(e) => {
                let message = format!("Session start failed: {}", e);
                let _ = update_attempt_status(
                    &flight_id,
                    &attempt_id,
                    AttemptStatus::Failed,
                    Some(message.clone()),
                )
                .await;
                // G26: the worktree was provisioned before we tried to start the
                // session; on start failure the attempt is terminal, so tear its
                // now-orphaned worktree down instead of leaking it. The persisted
                // Failed record stays so the failure remains visible in the UI.
                cleanup_unpersisted_attempt(&spec, &attempt.target, &attempt_id).await;
                (AttemptStatus::Failed, Some(message))
            }
        };

        info!(
            flight = %flight_id,
            attempt = %attempt_id,
            agent = %agent_config_id,
            "Launched async attempt"
        );
        launched.push(Attempt {
            status: final_status,
            completed_at: if matches!(
                final_status,
                AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
            ) {
                Some(now_ms())
            } else {
                None
            },
            failure_category: if final_status == AttemptStatus::Failed {
                final_error.as_deref().map(|m| {
                    crate::core::error_classifier::classify_cli_error(m)
                        .category
                        .as_str()
                        .to_string()
                })
            } else {
                None
            },
            error_message: final_error,
            ..attempt
        });
    }

    let latest_state = storage::load_state();
    if let Some(flight) = latest_state.flights.iter().find(|f| f.id == flight_id) {
        let latest_attempts = launched
            .iter()
            .map(|attempt| {
                flight
                    .attempts
                    .iter()
                    .find(|current| current.id == attempt.id)
                    .cloned()
                    .unwrap_or_else(|| attempt.clone())
            })
            .collect();
        Ok(latest_attempts)
    } else {
        Ok(launched)
    }
}

/// Tear down one attempt's worktree, reporting failure as data.
///
/// `ssh` is the already-resolved connection for an SSH attempt; `None` means
/// the saved `ServerConfig` is gone, which is reported as `deferred` (the
/// frontend can re-issue `cleanup_attempt_worktree_ssh` with live host
/// details) rather than as success.
async fn cleanup_attempt_worktree_with(
    attempt_id: &str,
    target: &AttemptTarget,
    ssh: Option<SshConfig>,
) -> worktree::WorktreeCleanupOutcome {
    match target {
        AttemptTarget::Local { base_path, .. } => {
            let path = worktree::worktree_path(base_path, attempt_id)
                .unwrap_or_else(|_| base_path.to_string());
            let mut outcome = worktree::WorktreeCleanupOutcome::for_path(path);
            match worktree::remove_local_worktree(base_path, attempt_id, false).await {
                Ok(()) => outcome.removed = true,
                Err(e) => {
                    warn!(attempt = %attempt_id, error = %e, "Local worktree cleanup failed");
                    outcome.error = Some(e);
                }
            }
            outcome
        }
        AttemptTarget::Ssh { base_path, .. } => {
            let path = worktree::worktree_path(base_path, attempt_id)
                .unwrap_or_else(|_| base_path.to_string());
            let mut outcome = worktree::WorktreeCleanupOutcome::for_path(path);
            match ssh {
                Some(cfg) => {
                    match worktree::remove_remote_worktree(&cfg, base_path, attempt_id).await {
                        Ok(()) => outcome.removed = true,
                        Err(e) => {
                            warn!(attempt = %attempt_id, error = %e, "Remote worktree cleanup failed");
                            outcome.error = Some(e);
                        }
                    }
                }
                None => {
                    warn!(attempt = %attempt_id, "SSH worktree cleanup deferred — server no longer configured; frontend may re-issue cleanup_attempt_worktree_ssh");
                    outcome.deferred = true;
                }
            }
            outcome
        }
    }
}

/// S4 wrapper: resolve the saved `ServerConfig` (pinning the host key via its
/// saved fingerprint) before tearing the worktree down.
async fn cleanup_attempt_worktree(
    attempt_id: &str,
    target: &AttemptTarget,
) -> worktree::WorktreeCleanupOutcome {
    let ssh = match target {
        AttemptTarget::Ssh {
            base_path,
            server_id,
            ..
        } => resolve_server_ssh_config(server_id, base_path),
        AttemptTarget::Local { .. } => None,
    };
    cleanup_attempt_worktree_with(attempt_id, target, ssh).await
}

/// Best-effort worktree sweep for the attempts that
/// `core::orchestrator::recover_flights_on_startup` demoted to `Failed`
/// because a restart interrupted them.
///
/// Startup recovery is synchronous and runs before the Tauri runtime, so it
/// can only fix the persisted status; the worktree it leaves behind (plus its
/// `pkt/*` branch) needs an async pass. Failures are logged and swallowed —
/// the user can still remove a stale worktree by hand, and a git error here
/// must not take the app down on launch.
pub async fn sweep_interrupted_attempts(
    interrupted: Vec<crate::core::orchestrator::InterruptedAttempt>,
) {
    if interrupted.is_empty() {
        return;
    }
    info!(
        count = interrupted.len(),
        "Sweeping worktrees for attempts interrupted by a previous run"
    );
    for entry in interrupted {
        let outcome = cleanup_attempt_worktree(&entry.attempt_id, &entry.target).await;
        if outcome.removed {
            info!(
                flight = %entry.flight_id,
                attempt = %entry.attempt_id,
                path = %outcome.worktree_path,
                "Removed the worktree of an interrupted attempt"
            );
        } else {
            warn!(
                flight = %entry.flight_id,
                attempt = %entry.attempt_id,
                path = %outcome.worktree_path,
                deferred = outcome.deferred,
                error = outcome.error.as_deref().unwrap_or(""),
                "Could not remove the worktree of an interrupted attempt"
            );
        }
    }
}

/// Cancel an attempt: close its session, mark it cancelled, remove its
/// worktree.
///
/// Returns the worktree teardown outcome instead of swallowing it. Cleanup
/// failure is deliberately NON-FATAL — the attempt is cancelled either way —
/// but it is now visible to the caller, so `deleteFlightWithAttemptCleanup`
/// can report a worktree that is still on disk instead of showing the user a
/// clean delete.
#[tauri::command]
pub async fn cancel_flight_attempt(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    attempt_id: String,
) -> Result<worktree::WorktreeCleanupOutcome, String> {
    // 1. Pull a snapshot of the attempt so we can clean up the worktree
    //    after closing the session.
    let attempt = {
        let s = storage::load_state();
        s.flights
            .iter()
            .find(|f| f.id == flight_id)
            .and_then(|f| f.attempts.iter().find(|a| a.id == attempt_id).cloned())
            .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?
    };

    // 2. Close the API agent session (cancels the loop + drops history).
    let _ = close_api_agent_session(state, sidecar, attempt.session_id.clone()).await;

    // 3. Mark cancelled before worktree removal so the UI flips quickly.
    let _ = update_attempt_status(&flight_id, &attempt_id, AttemptStatus::Cancelled, None).await;

    // 4. Remove the worktree. For SSH we re-resolve the saved `ServerConfig`
    //    by server_id so the host key is pinned via the saved fingerprint;
    //    only if the server is gone do we defer to the frontend.
    Ok(cleanup_attempt_worktree(&attempt_id, &attempt.target).await)
}

/// Remove a Flight's cooperative integration worktree.
///
/// The integration worktree is flight-keyed, not attempt-keyed, so none of the
/// attempt cleanup commands can reach it — deleting a cooperative Flight used
/// to leave `<base>/.pkt-flight-integrations/<flight_id>` (and its
/// `packetbench/flight/<flight_id>` branch) behind forever.
///
/// `server_id` selects the remote twin and is resolved from saved servers, so
/// a deleted server surfaces as `deferred` rather than a silent no-op.
/// `delete_branch` uses the safe `git branch -d`: the integration branch can
/// be the only ref to merged-but-unlanded attempt work, and a refusal is
/// reported in `branch_retained` rather than forced.
#[tauri::command]
pub async fn cleanup_flight_integration_worktree(
    flight_id: String,
    base_path: String,
    server_id: Option<String>,
    delete_branch: bool,
) -> Result<worktree::WorktreeCleanupOutcome, String> {
    match server_id {
        None => {
            worktree::remove_local_integration_worktree(&base_path, &flight_id, delete_branch).await
        }
        Some(server_id) => match resolve_server_ssh_config(&server_id, &base_path) {
            Some(cfg) => {
                worktree::remove_remote_integration_worktree(
                    &cfg,
                    &base_path,
                    &flight_id,
                    delete_branch,
                )
                .await
            }
            None => {
                warn!(flight = %flight_id, server = %server_id, "Integration worktree cleanup deferred — server no longer configured");
                let mut outcome = worktree::WorktreeCleanupOutcome::for_path(
                    worktree::integration_worktree_path(&base_path, &flight_id)
                        .unwrap_or_else(|_| base_path.clone()),
                );
                outcome.deferred = true;
                Ok(outcome)
            }
        },
    }
}

#[tauri::command]
pub async fn cleanup_attempt_worktree_ssh(
    flight_id: String,
    attempt_id: String,
    host: String,
    port: u16,
    user: String,
    key_path: Option<String>,
    base_path: String,
    target_id: String,
    // Phase 2: optional pinned fingerprint, sourced from the saved
    // `ServerConfig.hostFingerprint`. Falls back to TOFU when absent
    // (legacy callers that haven't been updated yet).
    host_fingerprint: Option<String>,
) -> Result<(), String> {
    let cfg = SshConfig {
        host,
        port,
        user,
        remote_path: base_path.clone(),
        key_path,
        target_id: Some(target_id),
        host_fingerprint,
        auth_method: None,
    };
    let _ = (flight_id, attempt_id.clone());
    worktree::remove_remote_worktree(&cfg, &base_path, &attempt_id).await
}

/// v0.8-G: record the draft PR number published for an attempt. Called
/// after the frontend successfully pushes the attempt branch and opens a
/// draft PR via `github_create_pr`. The number is later surfaced in the
/// Flight detail UI as a "Draft PR #N" link.
#[tauri::command]
pub async fn set_attempt_draft_pr(
    flight_id: String,
    attempt_id: String,
    pr_number: u32,
) -> Result<(), String> {
    // v0.8 race-fix: hold the async state lock across load → mutate → save
    // so a concurrent `set_attempt_draft_pr` (e.g. retry path or duplicate
    // publish guard race) can't clobber the first writer's PR number.
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            let attempt = flight
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            attempt.draft_pr_number = Some(pr_number);
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// v0.8-G: persist the Flight's `publish_attempts_as_prs` boolean. Lets
/// the frontend toggle flow through to storage without a full Flight
/// upsert — keeps the asyncFlightStore path lean.
#[tauri::command]
pub async fn set_flight_publish_attempts_as_prs(
    flight_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Serialize against other attempt/cost writers via `with_state_lock` so
    // concurrent saves can't drop the toggle flip.
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            flight.publish_attempts_as_prs = enabled;
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// Persist an attempt's Reviewer Gate record.
///
/// The gate is **backend-owned**, like every other attempt lifecycle field.
/// `merge_attempts_for_frontend_save` keeps the backend's copy of an attempt
/// that already exists and takes only independently-derived counters from a
/// whole-slice frontend save, so a `review_gate` authored by the frontend
/// store was discarded on the very next save. `update_attempt_status` then
/// read a field it could never receive and refused every gated acceptance
/// with "Reviewer Gate has not produced a verdict". The reviewer runtime
/// therefore writes through here, under `with_state_lock`, and the merge
/// preserves what this command wrote.
///
/// `review_gate: None` clears the record (used when a retry restarts the
/// reviewer from scratch).
#[tauri::command]
pub async fn set_attempt_review_gate(
    flight_id: String,
    attempt_id: String,
    review_gate: Option<crate::api::AttemptReviewGateDto>,
) -> Result<(), String> {
    let gate = review_gate.map(Into::into);
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            let attempt = flight
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .ok_or_else(|| format!("Attempt '{}' not found", attempt_id))?;
            attempt.review_gate = gate;
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
}

/// Set an attempt's status. Terminal statuses additionally close the session
/// and tear the worktree down.
///
/// Returns the teardown outcome for terminal transitions (`None` for
/// non-terminal ones) so a failed removal is visible to the frontend instead
/// of being `warn!`-logged and dropped — the same hole `cancel_flight_attempt`
/// had.
#[tauri::command]
pub async fn mark_attempt_status(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    attempt_id: String,
    status: SetAttemptStatus,
) -> Result<Option<worktree::WorktreeCleanupOutcome>, String> {
    let new_status = match status {
        SetAttemptStatus::Reviewing => AttemptStatus::Reviewing,
        SetAttemptStatus::Completed => AttemptStatus::Completed,
        SetAttemptStatus::Failed => AttemptStatus::Failed,
        SetAttemptStatus::Cancelled => AttemptStatus::Cancelled,
    };

    let is_terminal = matches!(
        new_status,
        AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
    );

    // For terminal states, snapshot the attempt before mutating so we can
    // close its session and clean up its worktree afterwards.
    let attempt_snapshot = if is_terminal {
        let s = storage::load_state();
        s.flights
            .iter()
            .find(|f| f.id == flight_id)
            .and_then(|f| f.attempts.iter().find(|a| a.id == attempt_id).cloned())
    } else {
        None
    };

    update_attempt_status(&flight_id, &attempt_id, new_status, None).await?;

    let Some(attempt) = attempt_snapshot else {
        return Ok(None);
    };

    // Close the API agent session bound to this attempt (best-effort —
    // it may already be closed if the agent finished naturally).
    let _ = close_api_agent_session(state, sidecar, attempt.session_id.clone()).await;

    // Tear down the worktree. Local cleanup runs inline; SSH cleanup still
    // prefers the saved ServerConfig and reports `deferred` when it is gone,
    // so the frontend knows to re-issue `cleanup_attempt_worktree_ssh`.
    Ok(Some(
        cleanup_attempt_worktree(&attempt_id, &attempt.target).await,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flight::{Flight, FlightPriority, FlightStatus};

    fn local_spec(path: &str) -> AttemptTargetSpec {
        AttemptTargetSpec::Local {
            base_path: path.to_string(),
            base_branch: "main".to_string(),
            agent_config_id: "api-claude".to_string(),
            provider: "claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            task_id: None,
        }
    }

    fn ssh_spec(target_id: &str, path: &str) -> AttemptTargetSpec {
        AttemptTargetSpec::Ssh {
            target_id: target_id.to_string(),
            host: "example.test".to_string(),
            port: 22,
            user: "ian".to_string(),
            key_path: None,
            auth_method: None,
            host_fingerprint: None,
            base_path: path.to_string(),
            base_branch: "main".to_string(),
            agent_config_id: "api-claude".to_string(),
            provider: "claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            task_id: None,
        }
    }

    fn local_attempt(id: &str, path: &str, status: AttemptStatus) -> Attempt {
        Attempt {
            id: id.to_string(),
            flight_id: "flight-1".to_string(),
            target: AttemptTarget::Local {
                base_path: path.to_string(),
                worktree_path: format!("{}/.git/packetbench-worktrees/{}", path, id),
            },
            agent_config_id: "api-claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            provider: "claude".to_string(),
            branch: format!("packetbench/{}", id),
            base_branch: "main".to_string(),
            session_id: id.to_string(),
            status,
            started_at: Some(1),
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            error_message: None,
            failure_category: None,
            review_gate: None,
            task_id: None,
            draft_pr_number: None,
        }
    }

    // S4: a backend-initiated cleanup must pin the host key by carrying the
    // saved ServerConfig.host_fingerprint into the SshConfig — not drop it.
    #[test]
    fn ssh_config_from_server_propagates_fingerprint() {
        let server = crate::core::storage::ServerConfig {
            id: "srv-1".to_string(),
            name: "prod".to_string(),
            host: "example.test".to_string(),
            port: 2222,
            username: "ian".to_string(),
            auth_method: "key".to_string(),
            key_path: Some("~/.ssh/id_ed25519".to_string()),
            remote_path: Some("/srv/work".to_string()),
            last_connected_at: None,
            installed_agents: vec![],
            host_fingerprint: Some("SHA256:abc123".to_string()),
        };
        let cfg = ssh_config_from_server(&server, "/srv/work/base");
        assert_eq!(cfg.host_fingerprint.as_deref(), Some("SHA256:abc123"));
        assert_eq!(cfg.host, "example.test");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.user, "ian");
        assert_eq!(cfg.target_id.as_deref(), Some("srv-1"));
        assert_eq!(cfg.remote_path, "/srv/work/base");
    }

    #[test]
    fn ssh_config_from_server_keeps_none_fingerprint_for_legacy() {
        let server = crate::core::storage::ServerConfig {
            id: "srv-2".to_string(),
            name: "legacy".to_string(),
            host: "old.test".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: "agent".to_string(),
            key_path: None,
            remote_path: None,
            last_connected_at: None,
            installed_agents: vec![],
            host_fingerprint: None,
        };
        let cfg = ssh_config_from_server(&server, "/base");
        assert!(cfg.host_fingerprint.is_none());
    }

    #[test]
    fn record_attempt_error_classifies_failed_message() {
        let mut attempt = local_attempt("a1", "/tmp/x", AttemptStatus::Running);
        record_attempt_error(
            &mut attempt,
            AttemptStatus::Failed,
            Some("Error: unauthorized — invalid api key".to_string()),
        );
        assert_eq!(attempt.failure_category.as_deref(), Some("auth"));
        assert_eq!(
            attempt.error_message.as_deref(),
            Some("Error: unauthorized — invalid api key")
        );
    }

    #[test]
    fn record_attempt_error_skips_category_when_not_failed() {
        let mut attempt = local_attempt("a1", "/tmp/x", AttemptStatus::Cancelled);
        record_attempt_error(
            &mut attempt,
            AttemptStatus::Cancelled,
            Some("stopped by user".to_string()),
        );
        assert_eq!(attempt.failure_category, None);
        assert_eq!(attempt.error_message.as_deref(), Some("stopped by user"));
    }

    fn flight_with_attempt(attempt: Attempt) -> Flight {
        Flight {
            id: "flight-1".to_string(),
            title: "Flight".to_string(),
            objective: "Do work".to_string(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "D:/repo".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones: Vec::new(),
            linked_session_ids: Vec::new(),
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: vec![attempt],
            review_gate_policy: None,
            execution_mode: None,
            integration_branch: None,
            coordination_inbox: Vec::new(),
            autonomy_mode: None,
            autonomy_policy: None,
            autonomy_runtime: None,
            planning_conversation_id: None,
            planner_session_id: None,
            planner_status: None,
            planner_cost: None,
            planner_tokens: None,
            planner_provider: None,
            publish_attempts_as_prs: false,
            coordination_log: Vec::new(),
        }
    }

    #[test]
    fn validate_target_claims_blocks_duplicate_roots() {
        let result = validate_target_claims(&[local_spec("D:\\Repo"), local_spec("d:/repo/src")]);

        assert!(result
            .expect_err("duplicate target roots should be rejected")
            .contains("path_collision"),);
    }

    #[test]
    fn validate_target_identities_rejects_blank_ssh_target_id() {
        let result = validate_target_identities(&[ssh_spec("", "/repo")]);

        assert!(result
            .expect_err("blank SSH target id should be rejected")
            .contains("target_id"));
    }

    #[test]
    fn ssh_claims_are_case_sensitive() {
        let upper = target_spec_claim(&ssh_spec("server-1", "/repo/Foo")).unwrap();
        let lower = target_spec_claim(&ssh_spec("server-1", "/repo/foo")).unwrap();

        assert!(!claims_overlap(&upper, &lower));
    }

    #[test]
    fn active_attempt_collision_blocks_running_same_root() {
        let incoming = local_attempt("att-new", "d:/repo", AttemptStatus::Provisioning);
        let existing = local_attempt("att-running", "D:\\Repo\\src", AttemptStatus::Running);

        let message = active_attempt_collision_message(&incoming, &existing)
            .expect("overlapping running attempt should collide");

        assert!(message.contains("att-running"));
        assert!(message.contains("path_collision"));
    }

    #[test]
    fn active_attempt_collision_ignores_completed_attempts() {
        let incoming = local_attempt("att-new", "d:/repo", AttemptStatus::Provisioning);
        let existing = local_attempt("att-done", "D:\\Repo", AttemptStatus::Completed);

        assert!(active_attempt_collision_message(&incoming, &existing).is_none());
    }

    #[test]
    fn startup_running_status_does_not_regress_terminal_or_reviewing_attempts() {
        assert!(should_apply_attempt_status(
            AttemptStatus::Provisioning,
            AttemptStatus::Running
        ));
        assert!(!should_apply_attempt_status(
            AttemptStatus::Reviewing,
            AttemptStatus::Running
        ));
        assert!(!should_apply_attempt_status(
            AttemptStatus::Failed,
            AttemptStatus::Running
        ));
    }

    #[test]
    fn apply_attempt_status_by_session_moves_active_attempt_to_reviewing() {
        let mut state = storage::PersistedState::default();
        state.flights = vec![flight_with_attempt(local_attempt(
            "session-1",
            "D:\\Repo",
            AttemptStatus::Running,
        ))];

        let updated = apply_attempt_status_by_session(
            &mut state,
            "session-1",
            AttemptStatus::Reviewing,
            None,
        );

        assert!(updated);
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Reviewing);
        assert!(attempt.completed_at.is_none());
    }

    #[test]
    fn apply_attempt_status_by_session_does_not_clobber_cancelled_attempt() {
        let mut state = storage::PersistedState::default();
        let mut attempt = local_attempt("session-1", "D:\\Repo", AttemptStatus::Cancelled);
        attempt.completed_at = Some(123);
        state.flights = vec![flight_with_attempt(attempt)];

        let updated = apply_attempt_status_by_session(
            &mut state,
            "session-1",
            AttemptStatus::Reviewing,
            None,
        );

        assert!(!updated);
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Cancelled);
        assert_eq!(attempt.completed_at, Some(123));
    }

    // --- Worktree teardown reporting (cancel / terminal transition) ---

    fn temp_repo(tag: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-cleanup-{}-{}", tag, nanos));
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@packetbench.test"]);
        git(&["config", "user.name", "PacketBench Test"]);
        git(&["checkout", "-q", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "base\n").expect("write f.txt");
        git(&["add", "f.txt"]);
        git(&["commit", "-q", "-m", "init"]);
        root
    }

    #[tokio::test]
    async fn cleanup_reports_success_for_a_real_local_worktree() {
        let root = temp_repo("ok");
        let base = root.to_string_lossy().to_string();
        let path = crate::core::worktree::create_local_worktree(&base, "att-ok", "main")
            .await
            .expect("worktree created");
        let target = AttemptTarget::Local {
            base_path: base.clone(),
            worktree_path: path.clone(),
        };

        let outcome = cleanup_attempt_worktree_with("att-ok", &target, None).await;

        assert!(outcome.removed, "{:?}", outcome);
        assert!(outcome.error.is_none());
        assert!(!outcome.needs_attention());
        assert!(!std::path::Path::new(&path).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cleanup_reports_a_failed_local_worktree_removal_instead_of_swallowing_it() {
        // The worktree dir exists but its base is not a git repo, so
        // `git worktree remove` fails. This used to be warn!-logged and the
        // command returned Ok(()) — a stuck worktree looked like a clean
        // delete to the frontend.
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("packetbench-cleanup-bad-{}", nanos));
        let wt = root.join(".pkt-worktrees").join("att-bad");
        std::fs::create_dir_all(&wt).unwrap();
        let base = root.to_string_lossy().to_string();
        let target = AttemptTarget::Local {
            base_path: base.clone(),
            worktree_path: wt.to_string_lossy().to_string(),
        };

        let outcome = cleanup_attempt_worktree_with("att-bad", &target, None).await;

        assert!(!outcome.removed);
        assert!(outcome.needs_attention());
        assert!(
            outcome
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("git worktree remove failed"),
            "unexpected error: {:?}",
            outcome.error
        );
        // The path is named so the user can finish the job by hand.
        assert!(outcome.worktree_path.contains("att-bad"));
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cleanup_reports_ssh_teardown_as_deferred_when_the_server_is_gone() {
        let target = AttemptTarget::Ssh {
            base_path: "/srv/repo".to_string(),
            worktree_path: "/srv/repo/.pkt-worktrees/att-ssh".to_string(),
            server_id: "server-gone".to_string(),
        };

        let outcome = cleanup_attempt_worktree_with("att-ssh", &target, None).await;

        assert!(!outcome.removed);
        assert!(outcome.deferred, "{:?}", outcome);
        assert!(outcome.error.is_none(), "deferred is not an error");
        assert!(outcome.needs_attention());
        assert_eq!(outcome.worktree_path, "/srv/repo/.pkt-worktrees/att-ssh");
    }

    #[test]
    fn apply_attempt_status_by_session_records_error_on_failed_attempt() {
        let mut state = storage::PersistedState::default();
        state.flights = vec![flight_with_attempt(local_attempt(
            "session-1",
            "D:\\Repo",
            AttemptStatus::Provisioning,
        ))];

        let updated = apply_attempt_status_by_session(
            &mut state,
            "session-1",
            AttemptStatus::Failed,
            Some("provider failed".to_string()),
        );

        assert!(updated);
        let attempt = &state.flights[0].attempts[0];
        assert_eq!(attempt.status, AttemptStatus::Failed);
        assert!(attempt.completed_at.is_some());
        assert_eq!(attempt.error_message.as_deref(), Some("provider failed"));
    }

    // --- F1: Reviewer Gate acceptance, end to end through real storage -----

    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetbench-gate-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).expect("create unique temp dir");
        dir
    }

    fn gated_flight() -> Flight {
        let mut flight = flight_with_attempt(local_attempt(
            "attempt-1",
            "D:\\Repo",
            AttemptStatus::Reviewing,
        ));
        flight.review_gate_policy = Some(crate::core::flight::ReviewGatePolicy {
            enabled: true,
            reviewer_agent_config_id: "api-claude".to_string(),
            reviewer_model: None,
            acceptance_criteria: Vec::new(),
        });
        flight
    }

    fn gate_dto(status: crate::api::ReviewGateStatusDto) -> crate::api::AttemptReviewGateDto {
        crate::api::AttemptReviewGateDto {
            status,
            reviewer_conversation_id: Some("review-1".to_string()),
            reviewer_agent_config_id: Some("api-claude".to_string()),
            reviewer_model: None,
            report: None,
            error_message: None,
            started_at: Some(1),
            completed_at: Some(2),
            overridden_at: None,
            override_reason: None,
        }
    }

    fn stored_attempt(flight_id: &str, attempt_id: &str) -> Attempt {
        storage::load_state()
            .flights
            .into_iter()
            .find(|f| f.id == flight_id)
            .expect("flight present")
            .attempts
            .into_iter()
            .find(|a| a.id == attempt_id)
            .expect("attempt present")
    }

    /// The gap that hid F1: nothing covered gated acceptance. With the gate
    /// enabled, acceptance is blocked until a verdict exists, blocked again
    /// when that verdict is not a pass, and only then allowed — and the
    /// verdict has to survive the frontend's whole-slice flight save that
    /// runs constantly in between.
    #[tokio::test]
    async fn gated_acceptance_blocks_until_a_verdict_is_persisted() {
        let dir = unique_temp_dir("accept");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        // 1. No verdict yet — acceptance is refused.
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("acceptance must be blocked without a verdict");
        assert!(err.contains("has not produced a verdict"), "{err}");

        // 2. A non-passing verdict is still refused.
        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::ChangesRequested)),
        )
        .await
        .expect("gate write should succeed");
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("changes_requested must not unblock acceptance");
        assert!(
            err.contains("must pass or have a recorded override"),
            "{err}"
        );

        // 3. A passing verdict persists across the frontend's flight save…
        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::Passed)),
        )
        .await
        .expect("gate write should succeed");
        let mut frontend_snapshot = gated_flight();
        frontend_snapshot.attempts[0].review_gate = None;
        storage::save_flights(vec![frontend_snapshot])
            .await
            .expect("frontend whole-slice save");
        assert!(
            stored_attempt("flight-1", "attempt-1")
                .review_gate
                .is_some(),
            "the persisted verdict must survive a frontend flight save"
        );

        // 4. …and acceptance now goes through.
        update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect("a passing gate must allow acceptance");
        assert_eq!(
            stored_attempt("flight-1", "attempt-1").status,
            AttemptStatus::Completed
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An override is only an override when the user actually recorded a
    /// reason for it — a bare `overridden` status must not unblock acceptance.
    #[tokio::test]
    async fn gated_acceptance_requires_a_reason_on_an_override() {
        let dir = unique_temp_dir("override");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        let mut bare = gate_dto(crate::api::ReviewGateStatusDto::Overridden);
        bare.overridden_at = None;
        bare.override_reason = None;
        set_attempt_review_gate("flight-1".to_string(), "attempt-1".to_string(), Some(bare))
            .await
            .expect("gate write should succeed");
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("an unreasoned override must not unblock acceptance");
        assert!(
            err.contains("must pass or have a recorded override"),
            "{err}"
        );

        let mut recorded = gate_dto(crate::api::ReviewGateStatusDto::Overridden);
        recorded.overridden_at = Some(9);
        recorded.override_reason = Some("Reviewer stalled; risk accepted.".to_string());
        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(recorded),
        )
        .await
        .expect("gate write should succeed");
        update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect("a reasoned override must allow acceptance");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Clearing the record (what a reviewer retry does) puts the attempt back
    /// behind the gate rather than leaving a stale pass in place.
    #[tokio::test]
    async fn clearing_the_review_gate_reblocks_acceptance() {
        let dir = unique_temp_dir("clear");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-1".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::Passed)),
        )
        .await
        .expect("gate write should succeed");
        set_attempt_review_gate("flight-1".to_string(), "attempt-1".to_string(), None)
            .await
            .expect("clearing the gate should succeed");

        assert!(stored_attempt("flight-1", "attempt-1")
            .review_gate
            .is_none());
        let err = update_attempt_status("flight-1", "attempt-1", AttemptStatus::Completed, None)
            .await
            .expect_err("a cleared gate must re-block acceptance");
        assert!(err.contains("has not produced a verdict"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn set_attempt_review_gate_rejects_unknown_ids() {
        let dir = unique_temp_dir("unknown");
        let _guard = storage::redirect_data_dir_for_test(dir.clone());
        storage::save_flights(vec![gated_flight()])
            .await
            .expect("seed gated flight");

        let err = set_attempt_review_gate(
            "flight-1".to_string(),
            "attempt-missing".to_string(),
            Some(gate_dto(crate::api::ReviewGateStatusDto::Passed)),
        )
        .await
        .expect_err("an unknown attempt id must be reported");
        assert!(err.contains("attempt-missing"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
