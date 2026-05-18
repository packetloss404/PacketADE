//! Inbound event dispatcher — translates a parsed sidecar event into the
//! matching `api-agent:*` Tauri event(s) and runs any side effects
//! (mission-planner registry updates, one-shot waiter resolution, lifetime
//! bookkeeping for the `ready` handshake, etc.).

use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use super::events::{
    chunk_event, done_event, error_event, pending_edit_event, permission_request_event,
    plan_block_event, thinking_event, thinking_stop_event, tool_output_extended_event,
    tool_result_event, tool_start_event, turn_summary_event, DonePayload, ErrorPayload,
    PendingEditPayload, PermissionRequestPayload, PlanBlockPayload, PlanItemPayload,
    ThinkingPayload, ToolOutputExtendedPayload, ToolResultPayload, ToolStartPayload,
    TurnSummaryPayload,
};
use super::status::SidecarState;
use super::supervisor::SidecarManager;
use super::EXPECTED_PROTOCOL_VERSION;

impl SidecarManager {
    /// Translate a parsed sidecar event into a Tauri event.
    pub(super) async fn handle_event(&self, value: Value) {
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let session_id = value
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        match event_type {
            "ready" => {
                let pid = value.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                let version = value.get("version").and_then(|v| v.as_str());
                let protocol_version = value
                    .get("protocolVersion")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);

                match (version, protocol_version) {
                    (Some(ver), Some(proto)) => {
                        info!(
                            pid,
                            version = ver,
                            protocol_version = proto,
                            "sidecar ready: pid={}, version={}, protocolVersion={}",
                            pid,
                            ver,
                            proto
                        );
                        if proto != EXPECTED_PROTOCOL_VERSION {
                            warn!(
                                expected = EXPECTED_PROTOCOL_VERSION,
                                got = proto,
                                "sidecar protocol version mismatch: expected {}, got {} — some features may misbehave",
                                EXPECTED_PROTOCOL_VERSION,
                                proto
                            );
                        }
                    }
                    _ => {
                        warn!(
                            pid,
                            "sidecar ready event is missing version/protocol — running against a pre-handshake build"
                        );
                    }
                }
                // Lift the `ready` signal into the lifecycle status so the
                // frontend chip flips from "restarting" / "not_started" to
                // "ready" and can surface pid + version on hover.
                let captured_version = version.map(|v| v.to_string());
                let captured_pid = if pid == 0 { None } else { Some(pid as u32) };
                self.update_status(|s| {
                    s.state = SidecarState::Ready;
                    s.pid = captured_pid;
                    if captured_version.is_some() {
                        s.version = captured_version.clone();
                    }
                    // Successful handshake clears the stale error. Hover text
                    // should only show the *current* trouble, not ancient.
                    s.last_error = None;
                    // Lifetime bookkeeping: every successful handshake is one
                    // more `total_starts`, records the version, and opens a
                    // new uptime window anchored at `session_start`.
                    s.lifetime.total_starts = s.lifetime.total_starts.saturating_add(1);
                    if captured_version.is_some() {
                        s.lifetime.last_version = captured_version;
                    }
                    s.session_start = Some(Instant::now());
                })
                .await;
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
                let _ = self.app_handle.emit(&chunk_event(&session_id), text.clone());

                // E10-SUMMARIZE — if a one-shot waiter exists for this
                // session, append the chunk to its buffer. Cheap lookup;
                // no-op for the vast majority of sessions that never
                // registered a waiter.
                if !text.is_empty() {
                    let mut waiters = self.oneshot_waiters.lock().await;
                    if let Some(waiter) = waiters.get_mut(&session_id) {
                        waiter.buffer.push_str(&text);
                    }
                }

                // E7-HOOKS site 6 (Option A) — aggregate planner chunks into
                // a per-session buffer that we drain on `done` to emit a
                // single `PlannerMessage` journal entry. Non-planner sidecar
                // sessions are a no-op inside `append_chunk` (reverse-lookup
                // miss). Spawned off-thread so the chunk event-loop never
                // waits on the registry lock.
                if !text.is_empty() {
                    let session_for_async = session_id.clone();
                    let app_for_async = self.app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(registry) = app_for_async
                            .try_state::<crate::commands::mission_planner::MissionPlannerRegistry>()
                        {
                            registry.append_chunk(&session_for_async, &text).await;
                        }
                    });
                }
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
                let batch_id = value
                    .get("batchId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let batch_size = value.get("batchSize").and_then(|v| v.as_u64());
                let _ = self.app_handle.emit(
                    &permission_request_event(&session_id),
                    PermissionRequestPayload {
                        id,
                        name,
                        arguments,
                        batch_id,
                        batch_size,
                    },
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
                // Sidecar protocol carries `after` as the new content; older
                // bundled sidecars may still emit `content`. Accept either.
                let content = value
                    .get("after")
                    .or_else(|| value.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let before = value
                    .get("before")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &pending_edit_event(&session_id),
                    PendingEditPayload {
                        id,
                        path,
                        content,
                        before,
                    },
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
                let resume_token = value
                    .get("resumeToken")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &done_event(&session_id),
                    DonePayload {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                        resume_token,
                    },
                );

                // E10-SUMMARIZE — resolve any one-shot waiter for this
                // session with the accumulated buffer. Remove the entry
                // so subsequent terminal events (in pathological races)
                // don't try to re-send. `send` ignores the result because
                // a dropped receiver (caller-side timeout / cancel) is
                // not an error from the supervisor's perspective.
                {
                    let mut waiters = self.oneshot_waiters.lock().await;
                    if let Some(mut waiter) = waiters.remove(&session_id) {
                        if let Some(sender) = waiter.sender.take() {
                            let _ = sender.send(Ok(std::mem::take(&mut waiter.buffer)));
                        }
                    }
                }

                // A `done` event marks the current turn complete, not the
                // lifetime of the sidecar conversation. Keep ownership so the
                // next send/cancel/model change still routes to the sidecar.

                // E6-KILL-AWAKE: tell the Mission Planner registry that this
                // turn finished so it can flip the owning planner's status
                // from `Awake` back to `Idle`. The registry no-ops on
                // non-planner sidecar sessions (lookup miss) and on every
                // status other than `Awake`, so this is safe to fire
                // unconditionally. Spawn off-thread to avoid holding any
                // borrow tied to `try_state` across an await.
                //
                // E7-HOOKS site 6 (Option A) — after on_planner_done runs,
                // drain the per-session chunk buffer and write a single
                // aggregated `PlannerMessage` journal entry. The drain
                // method returns `None` for non-planner sidecar sessions
                // (no buffer was ever written) so no extra guard is needed.
                let session_for_async = session_id.clone();
                let app_for_async = self.app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(registry) = app_for_async
                        .try_state::<crate::commands::mission_planner::MissionPlannerRegistry>()
                    {
                        // Resolve mission_id BEFORE on_planner_done — that
                        // call never removes sessions (it only flips status),
                        // but resolving up front keeps the two registry
                        // operations independent and easier to reason about
                        // under contention.
                        let mission_id_opt = registry
                            .mission_id_for_sidecar_session(&session_for_async)
                            .await;
                        registry.on_planner_done(&session_for_async).await;
                        if let Some(mission_id) = mission_id_opt {
                            if let Some(buffer) = registry
                                .drain_chunk_buffer(&session_for_async)
                                .await
                            {
                                let trimmed = buffer.trim();
                                if !trimmed.is_empty() {
                                    let entry = crate::commands::mission_planner::journal_entry(
                                        mission_id,
                                        crate::core::mission_journal::JournalKind::PlannerMessage,
                                        trimmed.to_string(),
                                        None,
                                    );
                                    crate::commands::mission_planner::write_journal_and_emit(
                                        &app_for_async,
                                        entry,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                });
            }
            "plan_block" => {
                let items: Vec<PlanItemPayload> = value
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let content =
                                    item.get("content").and_then(|v| v.as_str())?.to_string();
                                let status = item
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("pending")
                                    .to_string();
                                let id = item.get("id").and_then(|v| v.as_str()).map(String::from);
                                let active_form = item
                                    .get("activeForm")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                Some(PlanItemPayload {
                                    id,
                                    content,
                                    status,
                                    active_form,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = self
                    .app_handle
                    .emit(&plan_block_event(&session_id), PlanBlockPayload { items });
            }
            "tool_output_extended" => {
                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let exit_code = value.get("exitCode").and_then(|v| v.as_i64());
                let modified_paths =
                    value
                        .get("modifiedPaths")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|s| s.as_str().map(String::from))
                                .collect()
                        });
                let stdout = value
                    .get("stdout")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let stderr = value
                    .get("stderr")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &tool_output_extended_event(&session_id),
                    ToolOutputExtendedPayload {
                        id,
                        exit_code,
                        modified_paths,
                        stdout,
                        stderr,
                    },
                );
            }
            "turn_summary" => {
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
                let reasoning_tokens = value.get("reasoningTokens").and_then(|v| v.as_u64());
                let address = value
                    .get("address")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &turn_summary_event(&session_id),
                    TurnSummaryPayload {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                        reasoning_tokens,
                        address,
                    },
                );

                // E8-ACCUM — accumulate this turn's token + cost spend onto
                // the owning Flight DTO. Two cases, both async-dispatched so
                // we never block the sidecar event loop on the
                // `with_state_lock` mutex:
                //
                //   1. Planner sidecar session → roll up onto
                //      `flight.planner_tokens` / `planner_cost` (the dedicated
                //      planner chip fields). Lookup via the in-memory
                //      `MissionPlannerRegistry`.
                //   2. Executor sidecar session linked to a flight via
                //      `attempt.session_id` or `task.session_id` → roll up
                //      onto `flight.total_tokens` / `total_cost`. Lookup via
                //      the on-disk PersistedState (the executor path doesn't
                //      maintain an in-memory registry of its own). The
                //      StatGrid chip in the frontend derives the "Exec" cost
                //      as `totalCost - plannerCost`; pre-E8 the chip always
                //      showed zero because nothing wrote `total_cost`.
                //
                // Both lookups short-circuit cleanly for sidecar sessions
                // that own neither role (e.g. a standalone API-agent chat
                // not linked to any flight) — no-op fallthrough.
                let session_for_async = session_id.clone();
                let app_for_async = self.app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let registry_opt = app_for_async
                        .try_state::<crate::commands::mission_planner::MissionPlannerRegistry>();
                    if let Some(registry) = registry_opt {
                        if let Some(mission_id) = registry
                            .mission_id_for_sidecar_session(&session_for_async)
                            .await
                        {
                            let model = registry
                                .get_by_mission(&mission_id)
                                .await
                                .map(|s| s.model)
                                .unwrap_or_default();
                            let cost_usd = crate::commands::pricing::calculate_cost(
                                &model,
                                input_tokens,
                                output_tokens,
                                cache_read_input_tokens,
                                cache_creation_input_tokens,
                            );
                            // E8 FIX 2: include cache-read + cache-create
                            // tokens in the `planner_tokens` chip sum so it
                            // matches the token categories `cost_usd` already
                            // prices. Pre-fix this only summed input +
                            // output, which under-reported tokens for every
                            // cache-heavy turn (effectively every turn after
                            // the first on long-running planner sessions).
                            //
                            // E10-DETECT: feed input + cache directions into
                            // a single "input-direction" total for the
                            // compaction threshold counter (these are the
                            // pieces that grow with conversation length).
                            // Output tokens flow into the chip's
                            // displayed total but NOT into the compaction
                            // counter — output is small per turn.
                            let planner_input_direction = input_tokens
                                .saturating_add(cache_read_input_tokens)
                                .saturating_add(cache_creation_input_tokens);
                            let planner_total_tokens = planner_input_direction
                                .saturating_add(output_tokens);

                            // E10-DETECT + E10 FIX P1-E — bump the planner's
                            // cumulative-input counter and emit the
                            // compaction-triggered event when the threshold
                            // is crossed for the first time. The registry's
                            // atomic flip in `bump_cumulative_input_and_check`
                            // ensures only ONE event fires per crossing;
                            // E10-SWAP listens for the event and is
                            // responsible for `reset_cumulative_input` /
                            // `swap_sidecar_session_after_compaction` once
                            // the swap completes.
                            //
                            // FIX P1-E: this bump used to sit INSIDE the
                            // `else` arm of the `accumulate_planner_cost`
                            // call below — a transient `with_state_lock`
                            // error would silently skip the bump, causing
                            // the cumulative counter to under-report and
                            // delaying (or missing) compaction triggers.
                            // The two operations are independent (cost goes
                            // to the DTO; cumulative tokens are in-memory on
                            // the registry), so the bump now runs first and
                            // unconditionally.
                            let crossed = registry
                                .bump_cumulative_input_and_check(
                                    &mission_id,
                                    planner_input_direction,
                                )
                                .await;
                            if crossed {
                                let _ = app_for_async.emit(
                                    &format!(
                                        "mission-planner:compaction-triggered:{}",
                                        mission_id
                                    ),
                                    serde_json::json!({
                                        "missionId": mission_id,
                                        "threshold": crate::commands::mission_planner::COMPACTION_THRESHOLD_TOKENS,
                                    }),
                                );
                            }

                            if let Err(e) =
                                crate::commands::mission_planner::accumulate_planner_cost(
                                    &mission_id,
                                    planner_input_direction,
                                    output_tokens,
                                    cost_usd,
                                )
                                .await
                            {
                                warn!(
                                    mission_id = %mission_id,
                                    error = %e,
                                    "E8-ACCUM: failed to accumulate planner cost"
                                );
                            } else {
                                let _ = app_for_async.emit(
                                    &format!("mission-planner:cost-updated:{}", mission_id),
                                    serde_json::json!({
                                        "missionId": mission_id,
                                        "inputTokens": input_tokens,
                                        "outputTokens": output_tokens,
                                        "cacheReadInputTokens": cache_read_input_tokens,
                                        "cacheCreationInputTokens": cache_creation_input_tokens,
                                        "totalTokens": planner_total_tokens,
                                        "costUsd": cost_usd,
                                        "source": "planner",
                                    }),
                                );
                            }
                            return;
                        }
                    }
                    // Not a planner session — try the executor (flight-attempt
                    // / flight-task) linkage instead.
                    let state_snap = crate::core::storage::load_state();
                    let owner = match crate::commands::mission_planner::
                        flight_for_executor_session(&state_snap, &session_for_async)
                    {
                        Some(o) => o,
                        None => return,
                    };
                    let exec_total_tokens = input_tokens
                        .saturating_add(output_tokens)
                        .saturating_add(cache_read_input_tokens)
                        .saturating_add(cache_creation_input_tokens);
                    let exec_cost_usd = crate::commands::pricing::calculate_cost(
                        &owner.model,
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                    );
                    if let Err(e) =
                        crate::commands::mission_planner::accumulate_executor_cost(
                            &owner.flight_id,
                            exec_total_tokens,
                            exec_cost_usd,
                        )
                        .await
                    {
                        warn!(
                            mission_id = %owner.flight_id,
                            error = %e,
                            "E8-ACCUM: failed to accumulate executor cost"
                        );
                    } else {
                        let _ = app_for_async.emit(
                            &format!("mission-planner:cost-updated:{}", owner.flight_id),
                            serde_json::json!({
                                "missionId": owner.flight_id,
                                "inputTokens": input_tokens,
                                "outputTokens": output_tokens,
                                "cacheReadInputTokens": cache_read_input_tokens,
                                "cacheCreationInputTokens": cache_creation_input_tokens,
                                "totalTokens": exec_total_tokens,
                                "costUsd": exec_cost_usd,
                                "source": "executor",
                            }),
                        );
                    }
                });
            }
            "error" => {
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown sidecar error")
                    .to_string();
                let _ = self.app_handle.emit(
                    &error_event(&session_id),
                    ErrorPayload {
                        message: message.clone(),
                    },
                );
                self.forget_owned_session(&session_id).await;

                // E10-SUMMARIZE — resolve any one-shot waiter for this
                // session with the error. The compaction summarizer treats
                // `Err` as a hard fail and degrades gracefully (no compaction
                // this cycle), so we propagate the SDK / sidecar message
                // verbatim.
                {
                    let mut waiters = self.oneshot_waiters.lock().await;
                    if let Some(mut waiter) = waiters.remove(&session_id) {
                        if let Some(sender) = waiter.sender.take() {
                            let _ = sender.send(Err(message.clone()));
                        }
                    }
                }
                // Record the most-recent per-session error so the chip's
                // tooltip has something meaningful if the supervisor later
                // transitions to `down`. Does not change `state`.
                self.update_status(|s| {
                    s.last_error = Some(message.clone());
                })
                .await;

                // E7-HOOKS — `error` is a turn-terminal event for planner
                // sessions (no `done` will follow). Drain any partial
                // streamed text so the next turn's chunks don't bleed into
                // the abandoned buffer, and journal the partial as a
                // `PlannerMessage` so the timeline reflects what the
                // planner had said up to the failure point.
                let session_for_async = session_id.clone();
                let app_for_async = self.app_handle.clone();
                let error_for_async = message.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(registry) = app_for_async
                        .try_state::<crate::commands::mission_planner::MissionPlannerRegistry>()
                    {
                        let mission_id_opt = registry
                            .mission_id_for_sidecar_session(&session_for_async)
                            .await;
                        if let Some(mission_id) = mission_id_opt {
                            if let Some(buffer) = registry
                                .drain_chunk_buffer(&session_for_async)
                                .await
                            {
                                let trimmed = buffer.trim();
                                if !trimmed.is_empty() {
                                    let body = format!(
                                        "{}\n\n*(partial — error: {})*",
                                        trimmed, error_for_async
                                    );
                                    let entry = crate::commands::mission_planner::journal_entry(
                                        mission_id,
                                        crate::core::mission_journal::JournalKind::PlannerMessage,
                                        body,
                                        Some(serde_json::json!({
                                            "partial": true,
                                            "reason": "error",
                                            "error": error_for_async,
                                        })),
                                    );
                                    crate::commands::mission_planner::write_journal_and_emit(
                                        &app_for_async,
                                        entry,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                });
            }
            "planner_tool" => {
                // v5: the sidecar's in-process planner MCP server invoked
                // one of its `mcp__planner__*` tools. The handler is parked
                // on a pending promise keyed by `callId`; we dispatch the
                // tool call against the MissionPlannerRegistry and forward
                // the result back via `planner_tool_result` so the SDK's
                // tool_use → tool_result round-trip stays well-formed.
                //
                // Without this arm the sidecar would hang forever waiting
                // for a result that never comes (and the event would log as
                // "unknown event type"), blocking E2's MCP work.
                let tool = value
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let call_id = value
                    .get("callId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = value.get("args").cloned().unwrap_or(Value::Null);
                if call_id.is_empty() {
                    warn!(
                        tool = %tool,
                        "planner_tool event missing callId; cannot reply"
                    );
                } else if let Some(manager) = self
                    .app_handle
                    .try_state::<Arc<SidecarManager>>()
                    .map(|s| s.inner().clone())
                {
                    let app_handle = self.app_handle.clone();
                    let session_for_reply = session_id.clone();
                    let call_for_reply = call_id.clone();
                    let tool_for_reply = tool.clone();
                    tauri::async_runtime::spawn(async move {
                        let outcome = match app_handle
                            .try_state::<crate::commands::mission_planner::MissionPlannerRegistry>()
                        {
                            Some(registry) => {
                                registry
                                    .handle_tool_call(
                                        &app_handle,
                                        &session_for_reply,
                                        &tool_for_reply,
                                        args,
                                    )
                                    .await
                            }
                            None => Err(
                                "mission planner registry not managed".to_string(),
                            ),
                        };
                        let (success, result, error) = match outcome {
                            Ok(v) => (true, Some(v), None),
                            Err(e) => (false, None, Some(e)),
                        };
                        if let Err(e) = manager
                            .forward_planner_tool_result(
                                &session_for_reply,
                                &call_for_reply,
                                success,
                                result,
                                error,
                            )
                            .await
                        {
                            warn!(
                                error = %e,
                                tool = %tool_for_reply,
                                "failed to forward planner_tool_result"
                            );
                        }
                    });
                } else {
                    warn!(
                        tool = %tool,
                        "planner_tool event but SidecarManager not managed"
                    );
                }
            }
            "rate_limited" => {
                // v6 (E6-CEILING-RATELIMIT): the Anthropic provider caught
                // a `RateLimitError` (HTTP 429) from the SDK and surfaced
                // it as a typed event alongside its regular `error` emit.
                // Route it into the Mission Planner registry — the
                // planner-bound branch flips the owning mission's status
                // to `QuotaPaused`, arms an auto-resume timer, and fires
                // a `mission-planner:rate-limited:<missionId>` event so
                // the frontend can fan out an OS-level notification.
                //
                // Non-planner sidecar sessions land here too (any
                // `api-claude-oauth` session that hits 429), but the
                // registry's `mission_id_for_sidecar_session` lookup
                // returns `None` for them and `on_rate_limited` no-ops.
                // The regular `error` event has already been emitted, so
                // those sessions still surface the failure to the user.
                let retry_after_seconds = value
                    .get("retryAfterSeconds")
                    .and_then(|v| v.as_f64());
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                tracing::info!(
                    session_id = %session_id,
                    retry_after_seconds = ?retry_after_seconds,
                    message = ?message,
                    "sidecar reported rate-limit error"
                );
                // The registry is Tauri-managed for the app lifetime, so we
                // simply spawn an async task that re-fetches `try_state`
                // inside the future — that keeps the (non-`'static`) borrow
                // returned by `try_state` here scoped to this match arm,
                // while still letting the supervisor's status flip + emit +
                // sleep timer happen off the event-handler thread.
                let session_for_async = session_id.clone();
                let app_for_async = self.app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(registry) = app_for_async
                        .try_state::<crate::commands::mission_planner::MissionPlannerRegistry>()
                    {
                        registry
                            .on_rate_limited(
                                &session_for_async,
                                retry_after_seconds,
                                &app_for_async,
                            )
                            .await;

                        // E7-HOOKS — `rate_limited` is a turn-terminal
                        // event for planner sessions (the SDK throws
                        // `RateLimitError` and exits without firing
                        // `done`). Drain any partial streamed text so the
                        // next turn's chunks don't bleed into the
                        // abandoned buffer, and journal the partial so the
                        // timeline shows what the planner had said up to
                        // the throttle point.
                        let mission_id_opt = registry
                            .mission_id_for_sidecar_session(&session_for_async)
                            .await;
                        if let Some(mission_id) = mission_id_opt {
                            if let Some(buffer) = registry
                                .drain_chunk_buffer(&session_for_async)
                                .await
                            {
                                let trimmed = buffer.trim();
                                if !trimmed.is_empty() {
                                    let entry = crate::commands::mission_planner::journal_entry(
                                        mission_id,
                                        crate::core::mission_journal::JournalKind::PlannerMessage,
                                        format!(
                                            "{}\n\n*(partial — rate-limited mid-stream)*",
                                            trimmed
                                        ),
                                        Some(serde_json::json!({
                                            "partial": true,
                                            "reason": "rate_limited",
                                        })),
                                    );
                                    crate::commands::mission_planner::write_journal_and_emit(
                                        &app_for_async,
                                        entry,
                                    )
                                    .await;
                                }
                            }
                        }
                    } else {
                        warn!(
                            "rate_limited event but MissionPlannerRegistry not managed; cannot pause planner"
                        );
                    }
                });
            }
            other => {
                warn!(
                    event_type = %other,
                    "agent sidecar emitted unknown event type"
                );
            }
        }
    }
}

/// Trim a string for log output.
pub(super) fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
