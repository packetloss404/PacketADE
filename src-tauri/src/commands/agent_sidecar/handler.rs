//! Inbound event dispatcher — translates a parsed sidecar event into the
//! matching `api-agent:*` Tauri event(s) and runs any side effects
//! (one-shot waiter resolution, executor cost accumulation, lifetime
//! bookkeeping for the `ready` handshake, etc.).

use std::time::Instant;

use serde_json::Value;
use tauri::Emitter;
use tracing::{info, warn};

use super::events::{
    chunk_event, done_event, edit_baseline_event, error_event, mcp_sources_event,
    pending_edit_event, permission_request_event, plan_block_event, thinking_event,
    thinking_stop_event, tool_output_extended_event, tool_result_event, tool_start_event,
    turn_summary_event, DonePayload, EditBaselinePayload, ErrorPayload, McpReadError,
    McpSourceInfo, McpSourcesPayload, PendingEditPayload, PermissionRequestPayload,
    PlanBlockPayload, PlanItemPayload, ThinkingPayload, ToolOutputExtendedPayload,
    ToolResultPayload, ToolStartPayload, TurnSummaryPayload,
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
                let _ = self
                    .app_handle
                    .emit(&chunk_event(&session_id), text.clone());

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
                // P1-7: forward the raw tool input (as a JSON string) so the
                // transcript edit layer can parse Write/Edit/apply_patch
                // calls — sidecar tool_result events don't echo it back.
                let input = value.get("input").map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                });
                let _ = self.app_handle.emit(
                    &tool_start_event(&session_id),
                    ToolStartPayload { id, name, input },
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
            "edit_baseline" => {
                // P1-7: non-blocking pre-edit baseline for auto-applied
                // writes. `before` absent = the file did not exist.
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
                let before = value
                    .get("before")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.app_handle.emit(
                    &edit_baseline_event(&session_id),
                    EditBaselinePayload { id, path, before },
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
                let cancelled = value
                    .get("cancelled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if !cancelled {
                    let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
                        &session_id,
                        crate::core::flight::AttemptStatus::Reviewing,
                        None,
                    )
                    .await;
                }
                let _ = self.app_handle.emit(
                    &done_event(&session_id),
                    DonePayload {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_creation_input_tokens,
                        cancelled,
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
            "mcp_sources" => {
                // S8-Phase-B (Slice B): pure translation of the remote
                // sidecar's MCP-sourcing summary. Names/transport/scope +
                // read errors only — the sidecar never puts secrets here.
                let sources: Vec<McpSourceInfo> = value
                    .get("sources")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let name = item.get("name").and_then(|v| v.as_str())?.to_string();
                                let transport = item
                                    .get("transport")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("stdio")
                                    .to_string();
                                let scope = item
                                    .get("scope")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("project")
                                    .to_string();
                                Some(McpSourceInfo {
                                    name,
                                    transport,
                                    scope,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let read_errors: Vec<McpReadError> = value
                    .get("readErrors")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| {
                                let scope = item
                                    .get("scope")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("project")
                                    .to_string();
                                let path = item.get("path").and_then(|v| v.as_str())?.to_string();
                                let message = item
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                Some(McpReadError {
                                    scope,
                                    path,
                                    message,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = self.app_handle.emit(
                    &mcp_sources_event(&session_id),
                    McpSourcesPayload {
                        sources,
                        read_errors,
                    },
                );
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
                // the owning Flight DTO for executor sidecar sessions linked
                // to a flight via `attempt.session_id` or `task.session_id`.
                // Rolls up onto `flight.total_tokens` / `total_cost`; lookup
                // via the on-disk PersistedState. The StatGrid chip in the
                // frontend derives the "Exec" cost as `totalCost -
                // plannerCost`; pre-E8 the chip always showed zero because
                // nothing wrote `total_cost`.
                //
                // Async-dispatched so we never block the sidecar event loop
                // on the `with_state_lock` mutex, and short-circuits cleanly
                // for sidecar sessions that own no flight role (e.g. a
                // standalone API-agent chat) — no-op fallthrough.
                let session_for_async = session_id.clone();
                let app_for_async = self.app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state_snap = crate::core::storage::load_state();
                    let owner = match crate::commands::flight_cost::flight_for_executor_session(
                        &state_snap,
                        &session_for_async,
                    ) {
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
                    if let Err(e) = crate::commands::flight_cost::accumulate_executor_cost(
                        &owner.flight_id,
                        exec_total_tokens,
                        exec_cost_usd,
                    )
                    .await
                    {
                        warn!(
                            flight_id = %owner.flight_id,
                            error = %e,
                            "E8-ACCUM: failed to accumulate executor cost"
                        );
                    } else {
                        let _ = app_for_async.emit(
                            &format!("flight-planner:cost-updated:{}", owner.flight_id),
                            serde_json::json!({
                                "flightId": owner.flight_id,
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
                let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
                    &session_id,
                    crate::core::flight::AttemptStatus::Failed,
                    Some(message.clone()),
                )
                .await;
                let _ = self.app_handle.emit(
                    &error_event(&session_id),
                    ErrorPayload {
                        message: message.clone(),
                    },
                );
                self.forget_owned_session(&session_id).await;
                self.close_remote_session(&session_id).await;

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
            }
            "rate_limited" => {
                // v6 (E6-CEILING-RATELIMIT): the Anthropic provider caught
                // a `RateLimitError` (HTTP 429) from the SDK and surfaced
                // it as a typed event alongside its regular `error` emit.
                // The regular `error` event has already been emitted (see
                // above), so the session surfaces the failure to the user;
                // here we just record the rate-limit signal to the log.
                let retry_after_seconds = value.get("retryAfterSeconds").and_then(|v| v.as_f64());
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
        // G03: `max` may land in the middle of a multibyte UTF-8 codepoint, which
        // would panic when slicing. Walk back to the nearest char boundary first.
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}
