//! `create_task` tool handler.
//!
//! Owned by **E2-TASK**.
//!
//! Args shape:
//! ```json
//! {
//!   "milestone_id": string,
//!   "title": string,
//!   "prompt": string,
//!   "agent_id": string,
//!   "target_spec": AttemptTargetSpec
//! }
//! ```
//!
//! `target_spec` uses the **async-attempts shape** (`AttemptTargetSpec`)
//! per the locked spec — the planner routes tasks through the
//! `asyncFlightStore.launchAsync` executor path, not the legacy PTY
//! orchestrator.
//!
//! Returns `{ "taskId": string }` on success.
//!
//! ## Concurrency model (peer-review FIX 1 / FIX 2 / FIX 3)
//!
//! The handler:
//!   1. Resolves the owning mission via
//!      [`MissionPlannerRegistry::mission_id_for_sidecar_session`] — no
//!      bespoke flight scan.
//!   2. Validates `agent_id` against `state.agents` (falling back to
//!      `claude-code` on miss; matches the orchestrationStore pattern).
//!   3. Persists the new Task with `status=Queued` via
//!      [`storage::with_state_lock`] so concurrent planner tool calls
//!      can't lose updates.
//!   4. Emits `mission-planner:task-created:<missionId>` *before*
//!      spawning the launch so the UI sees the Queued task immediately.
//!   5. Spawns `launch_flight_async` via `tauri::async_runtime::spawn`
//!      and returns the new `taskId` immediately — the planner does not
//!      block on worktree provisioning / API agent start.
//!   6. The spawned background task waits for the launch result and,
//!      under a second `with_state_lock`, flips the Task to `Running`
//!      with its `session_id` (and on failure, to `Failed`). It then
//!      emits either `mission-planner:task-started:<missionId>` or
//!      `mission-planner:task-launch-failed:<missionId>`.
//!
//! Three Tauri events scope this lifecycle:
//!   * `mission-planner:task-created:<missionId>` — fired by the handler
//!     before returning; UI can render the Queued tile immediately.
//!   * `mission-planner:task-started:<missionId>` — fired by the spawned
//!     task after a successful `launch_flight_async`; carries the
//!     attempt id + session id.
//!   * `mission-planner:task-launch-failed:<missionId>` — fired by the
//!     spawned task if the attempt failed to start. The Task has been
//!     flipped to `Failed` so the next planner wake will see it.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::api_agent::ApiAgentState;
use crate::commands::flight_attempts::{launch_flight_async, AttemptTargetSpec};
use crate::commands::mission_planner::MissionPlannerRegistry;
use crate::core::flight::{Task, TaskStatus, TaskType};
use crate::core::storage;

/// Fallback agent id when the planner asks for an unknown agent. Matches
/// `orchestrationStore.launchFlight`'s substitution pattern on the
/// frontend so behavior is consistent across launch surfaces.
const FALLBACK_AGENT_ID: &str = "claude-code";

#[derive(Debug, Deserialize)]
struct CreateTaskArgs {
    milestone_id: String,
    title: String,
    prompt: String,
    agent_id: String,
    target_spec: AttemptTargetSpec,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Overwrite the `agent_config_id` field on an `AttemptTargetSpec` with the
/// validated agent id. The enum is non-exhaustive in spirit but currently
/// only has Local and Ssh variants — both carry `agent_config_id`.
fn override_agent_id(spec: AttemptTargetSpec, agent_id: &str) -> AttemptTargetSpec {
    match spec {
        AttemptTargetSpec::Local {
            base_path,
            base_branch,
            agent_config_id: _,
            provider,
            model,
        } => AttemptTargetSpec::Local {
            base_path,
            base_branch,
            agent_config_id: agent_id.to_string(),
            provider,
            model,
        },
        AttemptTargetSpec::Ssh {
            target_id,
            host,
            port,
            user,
            key_path,
            host_fingerprint,
            base_path,
            base_branch,
            agent_config_id: _,
            provider,
            model,
        } => AttemptTargetSpec::Ssh {
            target_id,
            host,
            port,
            user,
            key_path,
            host_fingerprint,
            base_path,
            base_branch,
            agent_config_id: agent_id.to_string(),
            provider,
            model,
        },
    }
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1a. Guard against "(not set)" placeholder values leaking through the
    //     target_spec (or any other arg field). The wake-message renderer
    //     in `core::mission_planner_prompts` falls back to that literal
    //     when the mission snapshot has no projectPath, and a careless
    //     planner copy could echo it into `target_spec.basePath` — which
    //     would then silently misroute `launch_flight_async`. Reject the
    //     call so the planner has to resolve the missing field (typically
    //     basePath / projectPath) before retrying, or escalate via
    //     `request_user_approval`.
    //
    //     `AttemptTargetSpec` is Deserialize-only (no Serialize impl), so
    //     we inspect the raw args JSON before deserialization rather than
    //     round-tripping through the typed struct.
    if args_contains_placeholder(&args) {
        return Err(
            "invalid target_spec: contains placeholder value '(not set)'. \
             Resolve the missing field (likely basePath / projectPath) before calling create_task."
                .to_string(),
        );
    }

    // 1. Parse args.
    let parsed: CreateTaskArgs = serde_json::from_value(args)
        .map_err(|e| format!("invalid args: {}", e))?;

    // 2. Resolve mission id via the planner registry (peer-review FIX 1).
    //    The registry already maps sidecar session id → mission id, so we
    //    don't need to scan persisted flights here.
    let registry = app
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let mission_id = registry
        .mission_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "no mission found for planner session '{}'; the planner may have been stopped",
                session_id
            )
        })?;

    // 3. Validate `agent_id` against the installed agents catalog. This is
    //    a read-only snapshot — no need to hold the state lock, and it
    //    must run before we enter the persistence critical section so
    //    we have the correct id to stamp on the Task and the attempt.
    let validated_agent_id: String = {
        let state = storage::load_state();
        let installed = state
            .agents
            .iter()
            .any(|a| a.id == parsed.agent_id && a.installed);
        if installed {
            parsed.agent_id.clone()
        } else {
            warn!(
                requested = %parsed.agent_id,
                fallback = %FALLBACK_AGENT_ID,
                "create_task: requested agent_id is not an installed agent; falling back"
            );
            FALLBACK_AGENT_ID.to_string()
        }
    };

    // 4. Overwrite target_spec.agent_config_id with the validated id so
    //    the spawned attempt uses the same agent the Task is stamped with.
    //    Peer reviewer flagged this as correct defensive coupling.
    let attempt_spec = override_agent_id(parsed.target_spec.clone(), &validated_agent_id);

    // 5. Build + persist the Task with status=Queued under the async
    //    state lock (peer-review FIX 2). All later state writes (Running
    //    / Failed) go through `with_state_lock` too.
    let task_id = format!("task_{}", uuid::Uuid::new_v4());
    let title = parsed.title.clone();
    let prompt = parsed.prompt.clone();
    let milestone_id = parsed.milestone_id.clone();

    // The closure runs synchronously and returns a `Ready` future; the
    // `with_state_lock` signature is `FnOnce(&mut PersistedState) -> Fut`
    // which can't express HRTBs that would let an `async move` capture
    // `&mut state` cleanly, so we use the same `std::future::ready(...)`
    // pattern already established in `resolve_mission_approval`.
    let task_id_for_persist = task_id.clone();
    let title_for_persist = title.clone();
    let milestone_id_for_persist = milestone_id.clone();
    let mission_id_for_persist = mission_id.clone();
    let validated_agent_id_for_persist = validated_agent_id.clone();
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == mission_id_for_persist)
                .ok_or_else(|| format!("mission '{}' not found", mission_id_for_persist))?;
            let milestone = flight
                .milestones
                .iter_mut()
                .find(|m| m.id == milestone_id_for_persist)
                .ok_or_else(|| {
                    format!(
                        "milestone '{}' not found on mission '{}'",
                        milestone_id_for_persist, mission_id_for_persist
                    )
                })?;
            let order = milestone.tasks.len();
            let new_task = Task {
                id: task_id_for_persist.clone(),
                milestone_id: milestone_id_for_persist.clone(),
                flight_id: mission_id_for_persist.clone(),
                title: title_for_persist.clone(),
                description: String::new(),
                order,
                status: TaskStatus::Queued,
                task_type: TaskType::Implementation,
                agent_config_id: validated_agent_id_for_persist.clone(),
                agent_args: None,
                model: None,
                depends_on: Vec::new(),
                session_id: None,
                result: None,
                review_packet: None,
                created_at: now_ms(),
                started_at: None,
                completed_at: None,
                cost: 0.0,
                tokens: 0,
            };
            milestone.tasks.push(new_task);
            flight.updated_at = now_ms();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await?;

    // 6. Emit `task-created` BEFORE the launch spawn so the UI renders the
    //    Queued tile before any worktree provisioning latency.
    let _ = app.emit(
        &format!("mission-planner:task-created:{}", mission_id),
        serde_json::json!({
            "missionId": mission_id,
            "taskId": task_id,
            "milestoneId": milestone_id,
            "title": title,
            "agentId": validated_agent_id,
            "createdAt": now_ms(),
        }),
    );

    // 7. SPAWN the attempt launch on the Tauri runtime (peer-review FIX 3 /
    //    P1-4). The handler does NOT await launch_flight_async — that
    //    function provisions a worktree (potentially over SSH) and starts
    //    a fresh API agent session, which can take seconds. Blocking the
    //    planner turn on that latency starves the next tool call and the
    //    sidecar's MCP loop. Instead, we hand off and the spawned task
    //    flips the Task to Running (or Failed) under a second
    //    `with_state_lock`.
    let app_for_spawn = app.clone();
    let mission_id_for_spawn = mission_id.clone();
    let milestone_id_for_spawn = milestone_id.clone();
    let task_id_for_spawn = task_id.clone();
    let prompt_for_spawn = prompt.clone();
    let attempt_spec_for_spawn = attempt_spec;
    tauri::async_runtime::spawn(async move {
        // Re-fetch the Tauri-managed states inside the spawned future —
        // `tauri::State<'_>` borrows from the AppHandle and can't cross
        // an `async move` boundary; pulling it here keeps the borrow
        // scoped to this future, which owns `app_for_spawn`.
        let api_state = match app_for_spawn.try_state::<Arc<ApiAgentState>>() {
            Some(s) => s,
            None => {
                warn!(
                    task_id = %task_id_for_spawn,
                    "create_task spawn: ApiAgentState not managed; marking task Failed"
                );
                mark_task_failed_and_emit(
                    &app_for_spawn,
                    &mission_id_for_spawn,
                    &milestone_id_for_spawn,
                    &task_id_for_spawn,
                    "ApiAgentState not managed",
                )
                .await;
                return;
            }
        };
        let sidecar_state = match app_for_spawn.try_state::<Arc<SidecarManager>>() {
            Some(s) => s,
            None => {
                warn!(
                    task_id = %task_id_for_spawn,
                    "create_task spawn: SidecarManager not managed; marking task Failed"
                );
                mark_task_failed_and_emit(
                    &app_for_spawn,
                    &mission_id_for_spawn,
                    &milestone_id_for_spawn,
                    &task_id_for_spawn,
                    "SidecarManager not managed",
                )
                .await;
                return;
            }
        };

        let launch_result = launch_flight_async(
            app_for_spawn.clone(),
            api_state,
            sidecar_state,
            mission_id_for_spawn.clone(),
            prompt_for_spawn,
            vec![attempt_spec_for_spawn],
        )
        .await;

        match launch_result {
            Ok(attempts) => {
                let attempt = match attempts.into_iter().next() {
                    Some(a) => a,
                    None => {
                        warn!(
                            task_id = %task_id_for_spawn,
                            "create_task spawn: launch_flight_async returned zero attempts"
                        );
                        mark_task_failed_and_emit(
                            &app_for_spawn,
                            &mission_id_for_spawn,
                            &milestone_id_for_spawn,
                            &task_id_for_spawn,
                            "launch_flight_async returned no attempts",
                        )
                        .await;
                        return;
                    }
                };
                let attempt_id = attempt.id.clone();
                let attempt_session_id = attempt.session_id.clone();

                // Flip Task → Running under the state lock. We don't have
                // a dedicated `attempt_id` field on Task (only
                // `session_id`), so the frontend join is
                // `attempt.session_id == task.session_id`.
                let task_id_inner = task_id_for_spawn.clone();
                let mission_id_inner = mission_id_for_spawn.clone();
                let milestone_id_inner = milestone_id_for_spawn.clone();
                let attempt_session_id_inner = attempt_session_id.clone();
                let lock_result = storage::with_state_lock(move |state| {
                    if let Some(task) = find_task_mut(
                        state,
                        &mission_id_inner,
                        &milestone_id_inner,
                        &task_id_inner,
                    ) {
                        task.session_id = Some(attempt_session_id_inner);
                        task.status = TaskStatus::Running;
                        task.started_at = Some(now_ms());
                    }
                    // Bump flight.updated_at regardless — even if the task
                    // moved, the flight row should ping the UI.
                    if let Some(flight) =
                        state.flights.iter_mut().find(|f| f.id == mission_id_inner)
                    {
                        flight.updated_at = now_ms();
                    }
                    std::future::ready(Ok::<(), String>(()))
                })
                .await;
                if let Err(e) = lock_result {
                    warn!(
                        task_id = %task_id_for_spawn,
                        error = %e,
                        "create_task spawn: failed to persist Running status; UI will be stale"
                    );
                }

                let _ = app_for_spawn.emit(
                    &format!("mission-planner:task-started:{}", mission_id_for_spawn),
                    serde_json::json!({
                        "missionId": mission_id_for_spawn,
                        "taskId": task_id_for_spawn,
                        "milestoneId": milestone_id_for_spawn,
                        "attemptId": attempt_id,
                        "sessionId": attempt_session_id,
                        "startedAt": now_ms(),
                    }),
                );
            }
            Err(e) => {
                warn!(
                    task_id = %task_id_for_spawn,
                    error = %e,
                    "create_task spawn: attempt launch failed"
                );
                mark_task_failed_and_emit(
                    &app_for_spawn,
                    &mission_id_for_spawn,
                    &milestone_id_for_spawn,
                    &task_id_for_spawn,
                    &e,
                )
                .await;
            }
        }
    });

    // 8. Return immediately. The launch runs to completion in the
    //    background; the planner is free to issue its next tool call.
    Ok(serde_json::json!({ "taskId": task_id }))
}

/// Locate a Task across a mission's milestones for in-place mutation. Kept
/// generic over milestone id so the lookup is unambiguous even if a
/// future model lets the same task id appear under multiple milestones
/// (it doesn't today, but the search is O(milestones) either way).
fn find_task_mut<'a>(
    state: &'a mut storage::PersistedState,
    mission_id: &str,
    milestone_id: &str,
    task_id: &str,
) -> Option<&'a mut Task> {
    let flight = state.flights.iter_mut().find(|f| f.id == mission_id)?;
    let milestone = flight
        .milestones
        .iter_mut()
        .find(|m| m.id == milestone_id)?;
    milestone.tasks.iter_mut().find(|t| t.id == task_id)
}

/// Flip a Task to `Failed` under the state lock and emit
/// `mission-planner:task-launch-failed:<missionId>` for the UI. Best-
/// effort — logs (outside the lock closure) if either step fails. Kept
/// out-of-line so both the "launch errored" and "managed-state missing"
/// branches share the same cleanup.
async fn mark_task_failed_and_emit(
    app: &AppHandle,
    mission_id: &str,
    milestone_id: &str,
    task_id: &str,
    error: &str,
) {
    let mission_id_inner = mission_id.to_string();
    let milestone_id_inner = milestone_id.to_string();
    let task_id_inner = task_id.to_string();
    let lock_result = storage::with_state_lock(move |state| {
        if let Some(task) =
            find_task_mut(state, &mission_id_inner, &milestone_id_inner, &task_id_inner)
        {
            task.status = TaskStatus::Failed;
        }
        if let Some(flight) = state.flights.iter_mut().find(|f| f.id == mission_id_inner) {
            flight.updated_at = now_ms();
        }
        std::future::ready(Ok::<(), String>(()))
    })
    .await;
    if let Err(e) = lock_result {
        warn!(
            task_id = %task_id,
            error = %e,
            "create_task spawn: failed to persist Failed status"
        );
    }

    let _ = app.emit(
        &format!("mission-planner:task-launch-failed:{}", mission_id),
        serde_json::json!({
            "missionId": mission_id,
            "taskId": task_id,
            "milestoneId": milestone_id,
            "error": error,
            "failedAt": now_ms(),
        }),
    );
}

/// Recursively walk a JSON value looking for any string equal to the
/// `(not set)` placeholder the wake-message renderer falls back to when a
/// snapshot field is missing. Used by the create_task handler to reject
/// tool calls that echo the placeholder back into a `target_spec` field
/// (most commonly `basePath`), since `launch_flight_async` would otherwise
/// silently misroute the attempt.
///
/// We walk recursively rather than string-matching the serialized form so
/// we don't false-positive on (a) a legitimate user-supplied string that
/// happens to *contain* the substring `(not set)` and (b) the
/// `Deserialize`-only `AttemptTargetSpec` type, which can't be re-
/// serialized for a containment check.
fn args_contains_placeholder(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::String(s) => s == "(not set)",
        serde_json::Value::Array(arr) => arr.iter().any(args_contains_placeholder),
        serde_json::Value::Object(map) => {
            map.values().any(args_contains_placeholder)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The placeholder guard runs on the raw `serde_json::Value` before
    /// deserialization, so it can be exercised without the Tauri runtime.
    /// We hand it a `target_spec` that mirrors what a careless planner
    /// would emit after copying `"(not set)"` out of the decomposition
    /// wake message and assert the helper flags it.
    #[test]
    fn create_task_rejects_placeholder_basepath() {
        let args = serde_json::json!({
            "milestone_id": "ms_1",
            "title": "Do something",
            "prompt": "Implement the thing.",
            "agent_id": "claude-code",
            "target_spec": {
                "kind": "local",
                "basePath": "(not set)",
                "baseBranch": "main",
                "agentConfigId": "claude-code",
                "provider": "claude-oauth",
                "model": "claude-sonnet-4-6"
            }
        });
        assert!(
            args_contains_placeholder(&args),
            "guard should reject target_spec.basePath == \"(not set)\""
        );
    }

    /// Negative case: a real path must not trip the placeholder guard.
    #[test]
    fn create_task_accepts_concrete_basepath() {
        let args = serde_json::json!({
            "milestone_id": "ms_1",
            "title": "Do something",
            "prompt": "Implement the thing.",
            "agent_id": "claude-code",
            "target_spec": {
                "kind": "local",
                "basePath": "/projects/PacketADE",
                "baseBranch": "main",
                "agentConfigId": "claude-code",
                "provider": "claude-oauth",
                "model": "claude-sonnet-4-6"
            }
        });
        assert!(
            !args_contains_placeholder(&args),
            "concrete basePath must not trip the placeholder guard"
        );
    }

    /// Substring matches inside larger strings should NOT trip the guard —
    /// only the exact literal `(not set)` is rejected. Otherwise a user's
    /// prompt mentioning "(not set)" verbatim would be unfair.
    #[test]
    fn create_task_guard_requires_exact_placeholder_match() {
        let args = serde_json::json!({
            "milestone_id": "ms_1",
            "title": "Some task",
            "prompt": "When the value is (not set), fall back to default.",
            "agent_id": "claude-code",
            "target_spec": {
                "kind": "local",
                "basePath": "/projects/PacketADE",
                "baseBranch": "main",
                "agentConfigId": "claude-code",
                "provider": "claude-oauth",
                "model": "claude-sonnet-4-6"
            }
        });
        assert!(
            !args_contains_placeholder(&args),
            "guard must require exact \"(not set)\" string equality, not substring"
        );
    }

    /// Nested placement: a placeholder inside an SSH-shaped target_spec
    /// should still trip the guard. Walks the recursion path the helper
    /// uses for objects nested under `target_spec`.
    #[test]
    fn create_task_guard_walks_nested_objects() {
        let args = serde_json::json!({
            "milestone_id": "ms_1",
            "title": "Some task",
            "prompt": "Do work.",
            "agent_id": "claude-code",
            "target_spec": {
                "kind": "ssh",
                "target_id": "srv_1",
                "host": "example.com",
                "port": 22,
                "user": "deploy",
                "base_path": "(not set)",
                "base_branch": "main",
                "agent_config_id": "claude-code",
                "provider": "claude-oauth",
                "model": "claude-sonnet-4-6"
            }
        });
        assert!(
            args_contains_placeholder(&args),
            "guard should walk into ssh target_spec and flag the placeholder"
        );
    }
}
