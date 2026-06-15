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
//!   "target_spec": AttemptTargetSpec,
//!   "claimed_paths": string[]
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
//!   1. Resolves the owning flight via
//!      [`FlightPlannerRegistry::flight_id_for_sidecar_session`] — no
//!      bespoke flight scan.
//!   2. Validates `agent_id` against `state.agents` (falling back to
//!      `claude-code` on miss; matches the orchestrationStore pattern).
//!   3. Persists the new Task with `status=Queued` via
//!      [`storage::with_state_lock`] so concurrent planner tool calls
//!      can't lose updates.
//!   4. Emits `flight-planner:task-created:<flightId>` *before*
//!      spawning the launch so the UI sees the Queued task immediately.
//!   5. Spawns `launch_flight_async` via `tauri::async_runtime::spawn`
//!      and returns the new `taskId` immediately — the planner does not
//!      block on worktree provisioning / API agent start.
//!   6. The spawned background task waits for the launch result and,
//!      under a second `with_state_lock`, flips the Task to `Running`
//!      with its `session_id` (and on failure, to `Failed`). It then
//!      emits either `flight-planner:task-started:<flightId>` or
//!      `flight-planner:task-launch-failed:<flightId>`.
//!
//! Three Tauri events scope this lifecycle:
//!   * `flight-planner:task-created:<flightId>` — fired by the handler
//!     before returning; UI can render the Queued tile immediately.
//!   * `flight-planner:task-started:<flightId>` — fired by the spawned
//!     task after a successful `launch_flight_async`; carries the
//!     attempt id + session id.
//!   * `flight-planner:task-launch-failed:<flightId>` — fired by the
//!     spawned task if the attempt failed to start. The Task has been
//!     flipped to `Failed` so the next planner wake will see it.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::api_agent::ApiAgentState;
use crate::commands::flight_attempts::{launch_flight_async, AttemptTargetSpec};
use crate::commands::flight_planner::FlightPlannerRegistry;
use crate::core::flight::{Task, TaskStatus, TaskType};
use crate::core::storage;

/// Fallback agent id when the planner asks for an unknown agent. Matches
/// `orchestrationStore.launchFlight`'s substitution pattern on the
/// frontend so behavior is consistent across launch surfaces.
const FALLBACK_AGENT_ID: &str = "claude-code";

/// E6-CEILING-RATELIMIT — task ceiling per flight.
///
/// Per locked-design §Caps (`dev/flight-planner-plan.md`), a single flight
/// is capped at **60 tasks** across all milestones. When the planner tries
/// to call `create_task` for the 61st, the handler returns a structured
/// error string that the planner's system prompt and the dispatcher teach
/// the model to handle by escalating via `request_user_approval` instead
/// of pounding on `create_task`.
const TASK_CEILING: usize = 60;

/// Count all tasks across every milestone in a flight. Pulled out for use
/// in both the ceiling guard (inside [`handle`]'s `with_state_lock` closure)
/// and the unit test.
fn total_tasks_for_flight(flight: &crate::core::flight::Flight) -> usize {
    flight.milestones.iter().map(|m| m.tasks.len()).sum()
}

fn sanitize_claimed_paths(paths: &[String]) -> Vec<String> {
    let mut cleaned = Vec::new();
    for path in paths {
        let normalized = normalize_claimed_path(path);
        if normalized.is_empty() || cleaned.iter().any(|existing| existing == &normalized) {
            continue;
        }
        cleaned.push(normalized);
    }
    cleaned
}

fn normalize_claimed_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/").replace("//", "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    while normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
        .strip_prefix("./")
        .unwrap_or(&normalized)
        .to_string()
}

fn claimed_paths_overlap(left: &str, right: &str) -> bool {
    let a = normalize_claimed_path(left);
    let b = normalize_claimed_path(right);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a.clone() + "/"))
}

fn active_owned_path_collision(
    flight: &crate::core::flight::Flight,
    incoming_paths: &[String],
) -> Option<String> {
    if incoming_paths.is_empty() {
        return None;
    }
    for milestone in &flight.milestones {
        for task in &milestone.tasks {
            if !matches!(task.status, TaskStatus::Queued | TaskStatus::Running) {
                continue;
            }
            if task.owned_paths.is_empty() {
                continue;
            }
            for incoming in incoming_paths {
                if let Some(existing) = task
                    .owned_paths
                    .iter()
                    .find(|existing| claimed_paths_overlap(incoming, existing))
                {
                    return Some(format!(
                        "path_collision: task '{}' already claims '{}' while new task claims '{}'. Serialize the work with dependencies or ask for approval before launching overlapping paths.",
                        task.id, existing, incoming
                    ));
                }
            }
        }
    }
    None
}

/// Build the canonical "task ceiling reached" error string. The exact
/// wording is part of the planner's UX contract: the system prompt
/// (`core::flight_planner_prompts::spec_mode_system_prompt`) teaches the
/// model that, on this error, it must call `request_user_approval` with
/// the documented options before retrying. Keeping the construction in a
/// single helper means the test and the runtime path can't drift.
fn task_ceiling_error_message(total_tasks: usize) -> String {
    format!(
        "task_ceiling_reached: flight has {} tasks (cap {}). Call \
         request_user_approval to ask the user whether to continue past the \
         ceiling before creating any more tasks.",
        total_tasks, TASK_CEILING
    )
}

#[derive(Debug, Deserialize)]
struct CreateTaskArgs {
    milestone_id: String,
    title: String,
    prompt: String,
    agent_id: String,
    target_spec: AttemptTargetSpec,
    #[serde(
        default,
        alias = "claimedPaths",
        alias = "claimed_paths",
        alias = "ownedPaths",
        alias = "owned_paths"
    )]
    claimed_paths: Vec<String>,
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
            auth_method,
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
            auth_method,
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
    //     in `core::flight_planner_prompts` falls back to that literal
    //     when the flight snapshot has no projectPath, and a careless
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
    let parsed: CreateTaskArgs =
        serde_json::from_value(args).map_err(|e| format!("invalid args: {}", e))?;

    // 2. Resolve flight id via the planner registry (peer-review FIX 1).
    //    The registry already maps sidecar session id → flight id, so we
    //    don't need to scan persisted flights here.
    let registry = app
        .try_state::<FlightPlannerRegistry>()
        .ok_or_else(|| "flight planner registry not managed".to_string())?;
    let flight_id = registry
        .flight_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "no flight found for planner session '{}'; the planner may have been stopped",
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
    let claimed_paths = sanitize_claimed_paths(&parsed.claimed_paths);

    // The closure runs synchronously and returns a `Ready` future; the
    // `with_state_lock` signature is `FnOnce(&mut PersistedState) -> Fut`
    // which can't express HRTBs that would let an `async move` capture
    // `&mut state` cleanly, so we use the same `std::future::ready(...)`
    // pattern already established in `resolve_flight_approval`.
    let task_id_for_persist = task_id.clone();
    let title_for_persist = title.clone();
    let milestone_id_for_persist = milestone_id.clone();
    let flight_id_for_persist = flight_id.clone();
    let validated_agent_id_for_persist = validated_agent_id.clone();
    let claimed_paths_for_persist = claimed_paths.clone();
    storage::with_state_lock(move |state| {
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id_for_persist)
                .ok_or_else(|| format!("flight '{}' not found", flight_id_for_persist))?;

            // E6-CEILING-RATELIMIT — reject if the flight already has
            // [`TASK_CEILING`] tasks across all milestones. The error
            // string is structured so the planner's system prompt and
            // dispatcher together teach the model to call
            // `request_user_approval` instead of retrying `create_task`.
            //
            // We perform this check inside the same `with_state_lock`
            // closure that commits the new task so concurrent planner
            // tool calls can't race past the ceiling — between checking
            // the count and pushing the new task, no other writer can
            // squeeze in another task because we hold `ASYNC_STATE_LOCK`
            // for the duration.
            let total_tasks = total_tasks_for_flight(flight);
            if total_tasks >= TASK_CEILING {
                return Err(task_ceiling_error_message(total_tasks));
            }

            if let Some(message) = active_owned_path_collision(flight, &claimed_paths_for_persist) {
                return Err(message);
            }

            let milestone = flight
                .milestones
                .iter_mut()
                .find(|m| m.id == milestone_id_for_persist)
                .ok_or_else(|| {
                    format!(
                        "milestone '{}' not found on flight '{}'",
                        milestone_id_for_persist, flight_id_for_persist
                    )
                })?;
            let order = milestone.tasks.len();
            let new_task = Task {
                id: task_id_for_persist.clone(),
                milestone_id: milestone_id_for_persist.clone(),
                flight_id: flight_id_for_persist.clone(),
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
                owned_paths: claimed_paths_for_persist.clone(),
                // E5: new tasks start at 0 replans. `replan_after_failure`
                // will bump this when (and only when) the error is not
                // exempt per `is_replan_exempt`.
                replan_count: 0,
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
        &format!("flight-planner:task-created:{}", flight_id),
        serde_json::json!({
            "flightId": flight_id,
            "taskId": task_id,
            "milestoneId": milestone_id,
            "title": title,
            "agentId": validated_agent_id,
            "claimedPaths": claimed_paths,
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
    let flight_id_for_spawn = flight_id.clone();
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
                    &flight_id_for_spawn,
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
                    &flight_id_for_spawn,
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
            flight_id_for_spawn.clone(),
            prompt_for_spawn,
            vec![attempt_spec_for_spawn],
            Some(true),
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
                            &flight_id_for_spawn,
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
                let flight_id_inner = flight_id_for_spawn.clone();
                let milestone_id_inner = milestone_id_for_spawn.clone();
                let attempt_session_id_inner = attempt_session_id.clone();
                let lock_result = storage::with_state_lock(move |state| {
                    if let Some(task) = find_task_mut(
                        state,
                        &flight_id_inner,
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
                        state.flights.iter_mut().find(|f| f.id == flight_id_inner)
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
                    &format!("flight-planner:task-started:{}", flight_id_for_spawn),
                    serde_json::json!({
                        "flightId": flight_id_for_spawn,
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
                    &flight_id_for_spawn,
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

/// Locate a Task across a flight's milestones for in-place mutation. Kept
/// generic over milestone id so the lookup is unambiguous even if a
/// future model lets the same task id appear under multiple milestones
/// (it doesn't today, but the search is O(milestones) either way).
fn find_task_mut<'a>(
    state: &'a mut storage::PersistedState,
    flight_id: &str,
    milestone_id: &str,
    task_id: &str,
) -> Option<&'a mut Task> {
    let flight = state.flights.iter_mut().find(|f| f.id == flight_id)?;
    let milestone = flight
        .milestones
        .iter_mut()
        .find(|m| m.id == milestone_id)?;
    milestone.tasks.iter_mut().find(|t| t.id == task_id)
}

/// Flip a Task to `Failed` under the state lock and emit
/// `flight-planner:task-launch-failed:<flightId>` for the UI. Best-
/// effort — logs (outside the lock closure) if either step fails. Kept
/// out-of-line so both the "launch errored" and "managed-state missing"
/// branches share the same cleanup.
async fn mark_task_failed_and_emit(
    app: &AppHandle,
    flight_id: &str,
    milestone_id: &str,
    task_id: &str,
    error: &str,
) {
    let flight_id_inner = flight_id.to_string();
    let milestone_id_inner = milestone_id.to_string();
    let task_id_inner = task_id.to_string();
    let lock_result = storage::with_state_lock(move |state| {
        if let Some(task) = find_task_mut(
            state,
            &flight_id_inner,
            &milestone_id_inner,
            &task_id_inner,
        ) {
            task.status = TaskStatus::Failed;
        }
        if let Some(flight) = state.flights.iter_mut().find(|f| f.id == flight_id_inner) {
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
        &format!("flight-planner:task-launch-failed:{}", flight_id),
        serde_json::json!({
            "flightId": flight_id,
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
        serde_json::Value::Object(map) => map.values().any(args_contains_placeholder),
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

    // ----------------------------------------------------------------
    // E6-CEILING-RATELIMIT — task ceiling regression tests
    // ----------------------------------------------------------------

    use crate::core::flight::{
        Flight, FlightPriority, FlightStatus, Milestone, MilestoneStatus, Task as FlightTask,
        TaskStatus as FlightTaskStatus, TaskType as FlightTaskType,
    };

    /// Build a Task fixture with default fields. Mirrors the shape
    /// `core::flight::tests::make_task` uses so the test stays robust to
    /// non-load-bearing schema additions.
    fn fixture_task(id: &str, flight_id: &str, milestone_id: &str) -> FlightTask {
        FlightTask {
            id: id.to_string(),
            milestone_id: milestone_id.to_string(),
            flight_id: flight_id.to_string(),
            title: "Test task".to_string(),
            description: String::new(),
            order: 0,
            status: FlightTaskStatus::Queued,
            task_type: FlightTaskType::Implementation,
            agent_config_id: "claude-code".to_string(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: None,
            result: None,
            review_packet: None,
            created_at: 0,
            started_at: None,
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            owned_paths: Vec::new(),
            replan_count: 0,
        }
    }

    /// Build a Flight with `task_count` tasks spread across a single
    /// milestone. Convenient for ceiling-boundary tests.
    fn fixture_flight_with_tasks(task_count: usize) -> Flight {
        let flight_id = "f_ceil";
        let milestone_id = "m_ceil";
        let tasks: Vec<FlightTask> = (0..task_count)
            .map(|i| fixture_task(&format!("t_{}", i), flight_id, milestone_id))
            .collect();
        let milestone = Milestone {
            id: milestone_id.to_string(),
            flight_id: flight_id.to_string(),
            title: "M1".to_string(),
            description: String::new(),
            order: 0,
            status: MilestoneStatus::Active,
            tasks,
            validation_criteria: Vec::new(),
        };
        Flight {
            id: flight_id.to_string(),
            title: "Ceiling test".to_string(),
            objective: String::new(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "/tmp/test".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones: vec![milestone],
            linked_session_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: Vec::new(),
            planner_session_id: None,
            planner_status: None,
            planner_cost: None,
            planner_tokens: None,
            planner_provider: None,
            publish_attempts_as_prs: false,
        }
    }

    /// `TASK_CEILING` is the locked-design cap of 60 tasks per flight.
    /// If a future agent bumps this without coordinating, the error-string
    /// contract documented in the planner's system prompt and dispatcher
    /// guidance breaks. Guard the constant itself.
    #[test]
    fn task_ceiling_constant_is_60() {
        assert_eq!(
            TASK_CEILING, 60,
            "TASK_CEILING is part of the planner's UX contract — coordinate any bump with the system prompt and dispatcher"
        );
    }

    /// `total_tasks_for_flight` must sum tasks across **every** milestone,
    /// not just the first. The ceiling check would otherwise miss flights
    /// that fan out across multiple milestones.
    #[test]
    fn total_tasks_counts_across_milestones() {
        let mut flight = fixture_flight_with_tasks(5);
        // Add a second milestone with 7 tasks of its own.
        let extra = Milestone {
            id: "m_extra".to_string(),
            flight_id: flight.id.clone(),
            title: "M2".to_string(),
            description: String::new(),
            order: 1,
            status: MilestoneStatus::Active,
            tasks: (0..7)
                .map(|i| fixture_task(&format!("t_extra_{}", i), &flight.id, "m_extra"))
                .collect(),
            validation_criteria: Vec::new(),
        };
        flight.milestones.push(extra);
        assert_eq!(total_tasks_for_flight(&flight), 12);
    }

    /// Ceiling rejection: a flight already at 60 tasks must trip the
    /// guard before any new task is appended. Exercises the exact
    /// comparison the runtime closure performs (`total_tasks >= TASK_CEILING`).
    #[test]
    fn create_task_rejects_at_task_ceiling_60() {
        let flight = fixture_flight_with_tasks(TASK_CEILING);
        let total = total_tasks_for_flight(&flight);
        assert_eq!(
            total, 60,
            "fixture should produce exactly TASK_CEILING tasks"
        );
        // The guard's condition is `total_tasks >= TASK_CEILING`.
        assert!(total >= TASK_CEILING, "60 tasks must hit the ceiling guard");
        let err = task_ceiling_error_message(total);
        assert!(
            err.starts_with("task_ceiling_reached:"),
            "error string must start with the structured prefix the planner is taught to recognize: {}",
            err
        );
        assert!(
            err.contains("60"),
            "error string must surface the actual count for the planner: {}",
            err
        );
        assert!(
            err.contains("request_user_approval"),
            "error string must instruct the planner to call request_user_approval: {}",
            err
        );
    }

    /// Boundary check: 59 tasks must NOT trip the guard. The 60th task
    /// (the one being added) is what brings the flight to the cap; once
    /// it lands, the 61st call hits the ceiling.
    #[test]
    fn create_task_accepts_below_task_ceiling() {
        let flight = fixture_flight_with_tasks(TASK_CEILING - 1);
        let total = total_tasks_for_flight(&flight);
        assert_eq!(total, 59);
        assert!(
            total < TASK_CEILING,
            "59 tasks must be under the ceiling guard so the 60th create_task succeeds"
        );
    }

    #[test]
    fn active_owned_path_collision_blocks_overlapping_running_tasks() {
        let mut flight = fixture_flight_with_tasks(1);
        flight.milestones[0].tasks[0].status = FlightTaskStatus::Running;
        flight.milestones[0].tasks[0].owned_paths = vec!["src/features".to_string()];

        let collision =
            active_owned_path_collision(&flight, &["src/features/button.tsx".to_string()])
                .expect("nested claimed path should collide");

        assert!(collision.starts_with("path_collision:"));
        assert!(collision.contains("src/features"));
    }

    #[test]
    fn active_owned_path_collision_allows_disjoint_paths_in_same_repo() {
        let mut flight = fixture_flight_with_tasks(1);
        flight.milestones[0].tasks[0].status = FlightTaskStatus::Running;
        flight.milestones[0].tasks[0].owned_paths = vec!["src/features".to_string()];

        assert!(active_owned_path_collision(&flight, &["docs/plan.md".to_string()]).is_none());
    }
}
