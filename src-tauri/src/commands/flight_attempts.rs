//! Async parallel agent attempts on Flights ("one prompt → N agents").
//!
//! Each attempt provisions a git worktree (local or remote SSH), starts an
//! API agent session bound to that worktree, and is persisted as an
//! `Attempt` on the Flight. Cancellation removes the worktree and closes
//! the session.

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::api_agent::{close_api_agent_session, start_api_agent_session, ApiAgentState};
use crate::core::execution::SshConfig;
use crate::core::flight::{Attempt, AttemptStatus, AttemptTarget};
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
            target_id,
            base_path,
            ..
        } => (format!("ssh:{}", target_id), base_path.clone(), true),
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
            if let Some(msg) = error {
                attempt.error_message = Some(msg);
            }
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
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
            if let Some(message) = error {
                attempt.error_message = Some(message);
            }
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
                            target_id: cfg.target_id.clone().unwrap_or_default(),
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

#[tauri::command]
pub async fn cancel_flight_attempt(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    attempt_id: String,
) -> Result<(), String> {
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

    // 4. Remove the worktree.
    match &attempt.target {
        AttemptTarget::Local { base_path, .. } => {
            if let Err(e) = worktree::remove_local_worktree(base_path, &attempt_id, false).await {
                warn!(attempt = %attempt_id, error = %e, "Local worktree cleanup failed");
            }
        }
        AttemptTarget::Ssh {
            base_path,
            target_id,
            ..
        } => {
            // Reconstruct an SshConfig from saved attempt info. We don't have
            // host/user/port here — for cleanup we leave the worktree in place
            // if we can't authenticate, since attempting to reconnect from a
            // partial config would error out. Frontend can re-issue cleanup
            // later once it re-resolves the `ServerConfig` via `serverStore`.
            let _ = (base_path, target_id);
            warn!(attempt = %attempt_id, "SSH worktree cleanup deferred — requires frontend to call cleanup_attempt_worktree");
        }
    }

    Ok(())
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

#[tauri::command]
pub async fn mark_attempt_status(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    flight_id: String,
    attempt_id: String,
    status: SetAttemptStatus,
) -> Result<(), String> {
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

    if let Some(attempt) = attempt_snapshot {
        // Close the API agent session bound to this attempt (best-effort —
        // it may already be closed if the agent finished naturally).
        let _ = close_api_agent_session(state, sidecar, attempt.session_id.clone()).await;

        // Tear down the worktree. Local cleanup runs inline; SSH cleanup is
        // deferred to the frontend because we don't have host/user/key here.
        match &attempt.target {
            AttemptTarget::Local { base_path, .. } => {
                if let Err(e) = worktree::remove_local_worktree(base_path, &attempt_id, false).await
                {
                    warn!(attempt = %attempt_id, error = %e, "Local worktree cleanup failed");
                }
            }
            AttemptTarget::Ssh {
                base_path,
                target_id,
                ..
            } => {
                let _ = (base_path, target_id);
                warn!(
                    attempt = %attempt_id,
                    "SSH worktree cleanup deferred for attempt {} — frontend should invoke cleanup_attempt_worktree_ssh",
                    attempt_id
                );
            }
        }
    }

    Ok(())
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
        }
    }

    fn local_attempt(id: &str, path: &str, status: AttemptStatus) -> Attempt {
        Attempt {
            id: id.to_string(),
            flight_id: "flight-1".to_string(),
            target: AttemptTarget::Local {
                base_path: path.to_string(),
                worktree_path: format!("{}/.git/packetade-worktrees/{}", path, id),
            },
            agent_config_id: "api-claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            provider: "claude".to_string(),
            branch: format!("packetade/{}", id),
            base_branch: "main".to_string(),
            session_id: id.to_string(),
            status,
            started_at: Some(1),
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            error_message: None,
            draft_pr_number: None,
        }
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
}
