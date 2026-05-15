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

async fn append_attempt(flight_id: &str, attempt: &Attempt) -> Result<(), String> {
    // v0.8 race-fix: use `with_state_lock` so concurrent async writers
    // (e.g. multiple `launch_flight_async` invocations or interleaving with
    // `mark_attempt_status`) can't lose each other's mutations via the old
    // naked load → mutate → save.
    let flight_id = flight_id.to_string();
    let attempt = attempt.clone();
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
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

fn build_ssh_config_from_spec(spec: &AttemptTargetSpec) -> Option<SshConfig> {
    if let AttemptTargetSpec::Ssh {
        target_id,
        host,
        port,
        user,
        key_path,
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
) -> Result<Vec<Attempt>, String> {
    if targets.is_empty() {
        return Err("At least one target is required".to_string());
    }

    let mut launched: Vec<Attempt> = Vec::new();

    for spec in targets {
        let attempt_id = format!("att_{}", Uuid::new_v4().simple());
        let session_id = attempt_id.clone();
        let branch = worktree::branch_name(&attempt_id);

        let (target, ssh_config_for_session, agent_config_id, provider, model, base_branch) =
            match &spec {
                AttemptTargetSpec::Local {
                    base_path,
                    base_branch,
                    agent_config_id,
                    provider,
                    model,
                } => {
                    let path = worktree::create_local_worktree(base_path, &attempt_id, base_branch)
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

        if let Err(e) = append_attempt(&flight_id, &attempt).await {
            warn!(error = %e, "Failed to persist Attempt; aborting");
            return Err(e);
        }

        // Hand off to the existing API agent session machinery. session_id is
        // shared with the agentTaskStore conversation id on the frontend so
        // the AttemptTile can subscribe to streaming events.
        match start_api_agent_session(
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
        )
        .await
        {
            Ok(()) => {
                let _ =
                    update_attempt_status(&flight_id, &attempt_id, AttemptStatus::Running, None)
                        .await;
            }
            Err(e) => {
                let _ = update_attempt_status(
                    &flight_id,
                    &attempt_id,
                    AttemptStatus::Failed,
                    Some(format!("Session start failed: {}", e)),
                )
                .await;
            }
        }

        info!(
            flight = %flight_id,
            attempt = %attempt_id,
            agent = %agent_config_id,
            "Launched async attempt"
        );
        launched.push(attempt);
    }

    Ok(launched)
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
            if let Err(e) = worktree::remove_local_worktree(base_path, &attempt_id).await {
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
    // v0.8 race-fix: serialize against other planner-tool / attempt writers
    // via `with_state_lock` so concurrent saves can't drop the toggle flip.
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
                if let Err(e) = worktree::remove_local_worktree(base_path, &attempt_id).await {
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
