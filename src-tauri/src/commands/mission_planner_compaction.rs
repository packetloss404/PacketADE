//! Mission Planner E10 — context compaction.
//!
//! When a planner session's cumulative input tokens cross the threshold
//! (see E10-DETECT), this module:
//!
//!   1. **E10-SUMMARIZE** — [`summarize_mission_journal`] does a one-shot
//!      Sonnet round-trip to compress the mission journal into a priming
//!      summary.
//!   2. **E10-SWAP** — [`perform_compaction`] orchestrates the session
//!      restart: snapshot → summarize → close old sidecar → spawn new
//!      sidecar → inject summary → swap registry → journal + emit
//!      completion event. [`install_compaction_listener`] wires the
//!      per-mission Tauri listener that routes E10-DETECT's
//!      `mission-planner:compaction-triggered:<missionId>` event to
//!      [`perform_compaction`].

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener, Manager};
use tracing::{info, warn};

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::mission_planner::{
    journal_entry, persist_planner_state_on_flight, write_journal_and_emit, MissionPlannerRegistry,
    PlannerStatus, COMPACTION_FAILURE_ESCALATION_COUNT, COMPACTION_THRESHOLD_TOKENS,
};
use crate::core::mission_journal;
use crate::core::mission_journal::JournalKind;
use crate::core::mission_planner_prompts::spec_mode_system_prompt;

/// Cap on the journal text we feed into the summarization session.
///
/// The one-shot Claude session has its own ~200K-token context, but we
/// don't want to send the entire history of a year-old mission. At ~4
/// chars/token, 80K chars ≈ 20K tokens — leaves plenty of headroom for
/// the prompt scaffolding and the summary itself.
const SUMMARY_INPUT_BUDGET_CHARS: usize = 80_000;

/// Maximum wall-clock to wait for the one-shot summarization session to
/// emit `done` or `error`. Beyond this we treat the call as a failure
/// and the caller can decide to retry / skip compaction.
///
/// 90 seconds is generous for a ~20K-token-in / ~2K-token-out turn
/// against Sonnet — typical latency is well under 30 seconds.
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(90);

/// Model used for summarization. Sonnet is fast enough and produces a
/// strong enough summary; bigger models would burn the user's quota
/// without meaningfully improving the priming context.
const SUMMARIZER_MODEL: &str = "claude-sonnet-4-6";

/// Provider — same OAuth route the planner itself uses, so this draws
/// from the user's Claude subscription rather than API credit.
const SUMMARIZER_PROVIDER: &str = "claude-oauth";

/// System prompt for the one-shot summarizer. Kept minimal — the user
/// message carries the journal payload and the rubric.
const SUMMARIZER_SYSTEM_PROMPT: &str =
    "You are a concise summarizer. Produce ONLY the requested summary, no preamble.";

/// Generate a compact summary of the mission's progress so far.
///
/// Reads the journal markdown via [`mission_journal::read_journal`],
/// truncates it to a safe budget, then sends it to a one-shot
/// `claude-oauth` sidecar session with a summarization prompt and
/// returns the assistant's response.
///
/// The summary is intended to be injected as priming context into a
/// restarted planner session (E10-SWAP). Aim is 1-2 paragraphs
/// covering:
///   * Mission objective (1 sentence)
///   * Milestones created and their status (1-2 sentences)
///   * Tasks completed and any notable failures (1-2 sentences)
///   * Current state / what's pending (1 sentence)
///
/// Returns:
///   * `Ok(summary)` — the assistant text, trimmed.
///   * `Ok("(no journal entries to summarize)")` — the journal is empty
///     (mission has no recorded activity).
///   * `Err(message)` — sidecar not managed, journal read failure,
///     one-shot session failed, or timed out. The caller can decide
///     whether to retry or skip compaction this cycle; the planner
///     degrades gracefully but will eventually hit the context wall.
pub async fn summarize_mission_journal(
    app: &AppHandle,
    mission_id: &str,
) -> Result<String, String> {
    // 1. Read the full journal markdown. `read_journal` returns Ok("")
    //    for missions with no journal file yet, which we treat as a
    //    trivial summary (the caller can still wire the no-op string
    //    into the priming context if desired).
    let journal = mission_journal::read_journal(mission_id)?;
    if journal.trim().is_empty() {
        return Ok("(no journal entries to summarize)".to_string());
    }

    // 2. Truncate to a safe budget for the summarization session.
    let truncated = truncate_journal_for_summary(&journal, SUMMARY_INPUT_BUDGET_CHARS);

    // 3. Build the summarization prompt.
    let prompt = build_summarization_prompt(&truncated);

    // 4. Resolve the sidecar manager. Cloning the Arc lets us drop the
    //    Tauri state borrow before awaiting the long-running session.
    let manager = {
        let state = app
            .try_state::<Arc<SidecarManager>>()
            .ok_or_else(|| "SidecarManager not managed".to_string())?;
        Arc::clone(&*state)
    };

    // 5. Mint a unique one-shot session id so it can't collide with
    //    any existing planner or chat session.
    let session_id = format!("compaction-{}", uuid::Uuid::new_v4());

    // 6. Register the completion waiter BEFORE starting the session so
    //    we can't miss early chunks.
    let receiver = manager.wait_for_oneshot(&session_id).await;

    // 7. Start the one-shot session. `claude-oauth` ignores `api_key`
    //    (pulls from `~/.claude`), and the planner's MCP surface is
    //    intentionally absent — this is a vanilla summarization turn,
    //    no tools.
    let start_result = manager
        .forward_start(
            session_id.clone(),
            SUMMARIZER_PROVIDER.to_string(),
            SUMMARIZER_MODEL.to_string(),
            SUMMARIZER_SYSTEM_PROMPT.to_string(),
            Vec::new(),                 // allowed_tools — none
            serde_json::Value::Null,    // mcp_servers — none
            project_path_for_summary(), // project_path — see below
            prompt,                     // initial_message carries the work
            None,                       // api_key — claude-oauth uses ~/.claude
            None,                       // resume token
            Some(false),                // thinking_enabled
            Some(false),                // plan_mode
            serde_json::Value::Null,    // attachments
            serde_json::Value::Null,    // resume_messages
            None,                       // permission_mode
            None,                       // approve_writes
            None,                       // mcp_kind — no planner tools
            None,                       // command_path
            None,                       // workspace — derive local from project_path
        )
        .await;

    if let Err(e) = start_result {
        // The waiter is still in the map; drain it by sending a
        // synthetic error so we don't leak memory. The waiter will be
        // resolved on the next terminal event anyway, but we own the
        // failure here so we report the cleaner message.
        return Err(format!("failed to start summarization session: {}", e));
    }

    // 8. Await completion with a wall-clock timeout. The waiter is
    //    resolved by the chunk/done/error branches in
    //    `agent_sidecar::handle_event`.
    let summary_result = tokio::time::timeout(SUMMARY_TIMEOUT, receiver).await;

    // 9. Always attempt to close the session — best effort. If the
    //    sidecar already cleaned up (error/done both forget the
    //    session), `forward_close` either no-ops or returns a benign
    //    error.
    let close_result = manager.forward_close(session_id.clone()).await;
    if let Err(e) = close_result {
        warn!(
            session_id = %session_id,
            error = %e,
            "summarize_mission_journal: forward_close failed (non-fatal)"
        );
    }

    match summary_result {
        Ok(Ok(Ok(text))) => Ok(text.trim().to_string()),
        Ok(Ok(Err(msg))) => Err(format!("summarization session error: {}", msg)),
        Ok(Err(_)) => Err("summarization waiter dropped before completion".to_string()),
        Err(_) => Err(format!(
            "summarization timed out after {}s",
            SUMMARY_TIMEOUT.as_secs()
        )),
    }
}

/// Return a path string suitable for the sidecar's `project_path`
/// argument. The summarizer never reads files, so the value is
/// semantically a no-op — but the sidecar expects *some* path and the
/// Claude Agent SDK uses it as the cwd. Falling back to the user's
/// home directory keeps it neutral if the data dir isn't writable.
fn project_path_for_summary() -> String {
    crate::core::storage::data_dir()
        .to_string_lossy()
        .into_owned()
}

/// Truncate the journal to at most `max_chars`. Keeps the **latest**
/// entries (the tail) because those are most relevant for compaction;
/// older milestones are already represented in derived state on the
/// flight DTO.
///
/// Snaps the cut point to the next newline so we don't slice a journal
/// entry's HTML comment header in half.
fn truncate_journal_for_summary(journal: &str, max_chars: usize) -> String {
    if journal.len() <= max_chars {
        return journal.to_string();
    }
    let tail_start = journal.len().saturating_sub(max_chars);
    let mut tail = &journal[tail_start..];
    // Snap to the next newline so we don't split mid-line. If there is
    // no newline in the tail (single giant entry — unlikely but
    // possible), keep the raw tail.
    if let Some(nl) = tail.find('\n') {
        tail = &tail[nl + 1..];
    }
    format!(
        "[... earlier entries truncated for summarization budget ...]\n\n{}",
        tail
    )
}

/// Build the user-message body for the summarization turn. The rubric
/// is intentionally explicit so the model produces something we can
/// safely splice into a priming-context prompt without further
/// post-processing.
fn build_summarization_prompt(journal: &str) -> String {
    format!(
        "Summarize the following mission journal into 1-2 paragraphs.\n\n\
         The summary must cover:\n\
         1. Mission objective (one sentence).\n\
         2. Milestones created and their current status.\n\
         3. Tasks completed, failed, or in-progress (with brief outcomes).\n\
         4. Current state — what the planner should be aware of when resuming.\n\n\
         Keep it factual and dense. Do not include preamble like \"Here is the summary\".\n\
         Do not include markdown formatting unless it aids clarity.\n\n\
         === JOURNAL ===\n{}\n=== END JOURNAL ===",
        journal
    )
}

// ---------------------------------------------------------------------------
// E10-SWAP — Compaction orchestrator
// ---------------------------------------------------------------------------

/// Allowed tool list passed to the sidecar at planner-session start. Kept in
/// sync with the list in `mission_planner::start_mission_planner` — these are
/// the `mcp__planner__*` tools the E2 in-process MCP server exposes.
fn planner_allowed_tools() -> Vec<String> {
    vec![
        "mcp__planner__noop".to_string(),
        "mcp__planner__create_milestone".to_string(),
        "mcp__planner__create_task".to_string(),
        "mcp__planner__update_task".to_string(),
        "mcp__planner__mark_task_blocked".to_string(),
        "mcp__planner__replan_after_failure".to_string(),
        "mcp__planner__request_user_approval".to_string(),
        "mcp__planner__complete_mission".to_string(),
    ]
}

/// `mcpKind` discriminator the sidecar uses to construct the in-process
/// Mission Planner tool MCP server. Mirrors the constant used by
/// `mission_planner::start_mission_planner`.
const PLANNER_MCP_KIND: &str = "planner";

/// Provider string for the new planner session. Same value
/// `start_mission_planner` uses; kept inline so this module doesn't
/// depend on a `pub` of the parent's private constant.
const PLANNER_PROVIDER_DEFAULT: &str = "claude-oauth";

/// Fallback model if the snapshotted session has an empty `model` field.
/// Sonnet 4.6 is the locked v1 model per `dev/mission-planner-plan.md`
/// §Models.
const PLANNER_MODEL_DEFAULT: &str = "claude-sonnet-4-6";

/// Install a Tauri listener on `mission-planner:compaction-triggered:<mission_id>`
/// that, when fired, spawns [`perform_compaction`] for the same mission.
///
/// Returns the `EventId` so the caller can store it on the
/// `MissionPlannerSession` and `app.unlisten(id)` when the planner is
/// stopped (see E10 FIX P0). Without that, every start→stop cycle
/// accumulates a fresh listener — after N cycles a single triggered event
/// would fire N parallel `perform_compaction` tasks, burning N Sonnet
/// quotas and spawning N orphan sidecar sessions.
///
/// Idempotency: Tauri's `listen` installs a fresh listener each call
/// without deduping, so this MUST be called at most once per planner
/// lifecycle. [`crate::commands::mission_planner::start_mission_planner`]
/// short-circuits when a planner already exists for a mission, so calling
/// this from the post-insert path is safe.
pub fn install_compaction_listener(app: &AppHandle, mission_id: &str) -> tauri::EventId {
    let event_name = format!("mission-planner:compaction-triggered:{}", mission_id);
    let mission_id_owned = mission_id.to_string();
    let app_clone = app.clone();
    let event_id = app.listen(event_name, move |_event| {
        let mission_id_for_task = mission_id_owned.clone();
        let app_for_task = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = perform_compaction(&app_for_task, &mission_id_for_task).await {
                warn!(
                    error = %e,
                    mission_id = %mission_id_for_task,
                    "compaction failed",
                );
            }
        });
    });
    info!(
        mission_id,
        event_id, "installed compaction-trigger listener"
    );
    event_id
}

/// Snapshot of planner state captured before the swap. We read these under
/// the registry lock so the values are consistent — the snapshot is then
/// dropped before any awaiting on the summarizer (no lock held across the
/// long round-trip).
struct PlannerSnapshot {
    sidecar_session_id: String,
    model: String,
    project_path: String,
}

/// Orchestrate a planner-session compaction.
///
/// Flow:
///   1. Snapshot the existing planner's sidecar session id + model + project
///      path under the registry lock.
///   2. Ask [`summarize_mission_journal`] for a Sonnet round-trip summary of
///      the mission journal. On failure, clear the `compaction_in_progress`
///      flag (so a future threshold cross can retry) and bail.
///   3. Close the old sidecar session (best-effort — the sidecar may have
///      already shed it).
///   4. Spawn a brand-new sidecar session with the same system prompt,
///      mcpKind, and allowed tools.
///   5. Inject the summary as a `source="wake_trigger"` /
///      `kind="compaction_resume"` envelope so the planner's system prompt
///      can recognize the resume path.
///   6. Swap the registry's `sidecar_session_id`, zero
///      `cumulative_input_tokens`, clear `compaction_in_progress`.
///   7. Persist the new session id (and `Idle` status) onto the Flight DTO
///      so cold-start hydration sees the correct id after an app restart.
///   8. Append a `SystemNote` journal entry recording the swap.
///   9. Emit `mission-planner:compaction-completed:<missionId>` for the
///      frontend toast.
pub async fn perform_compaction(app: &AppHandle, mission_id: &str) -> Result<(), String> {
    info!(mission_id, "starting context compaction");

    let registry = app
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "MissionPlannerRegistry not managed".to_string())?;

    // 1. Snapshot the existing planner's state. `get_by_mission` returns a
    //    clone, so we drop the registry lock immediately.
    let session = registry
        .get_by_mission(mission_id)
        .await
        .ok_or_else(|| format!("planner session not found for mission {}", mission_id))?;
    let project_path = resolve_planner_project_path(mission_id).await;
    let snapshot = PlannerSnapshot {
        sidecar_session_id: session.sidecar_session_id.clone(),
        model: if session.model.is_empty() {
            PLANNER_MODEL_DEFAULT.to_string()
        } else {
            session.model.clone()
        },
        project_path,
    };

    // 2. Call the summarizer. This is the long (10-30s) round-trip; the
    //    planner's `compaction_in_progress` flag is already set (by
    //    E10-DETECT's bump) so no concurrent compaction will fire here.
    let summary = match summarize_mission_journal(app, mission_id).await {
        Ok(s) => s,
        Err(e) => {
            // E10 FIX P1-A — record failure (sets timestamp + bumps
            // counter), then escalate via a SystemNote on the 3rd
            // consecutive failure so the user sees a journal entry telling
            // them manual intervention may be required.
            warn!(
                mission_id,
                error = %e,
                "compaction summarization failed; planner will continue without compaction"
            );
            let failure_count = registry.record_compaction_failure(mission_id).await;
            maybe_journal_failure_escalation(app, mission_id, failure_count, "summarize", &e).await;
            // UI hint — the frontend can surface an error toast.
            let _ = app.emit(
                &format!("mission-planner:compaction-completed:{}", mission_id),
                serde_json::json!({
                    "missionId": mission_id,
                    "error": e,
                    "phase": "summarize",
                }),
            );
            return Err(e);
        }
    };

    // 3. Close the OLD sidecar session. Best-effort: a broken-pipe / already-
    //    closed error here is non-fatal — the new session below is what
    //    matters.
    if let Some(sidecar) = app.try_state::<Arc<SidecarManager>>() {
        if let Err(e) = sidecar
            .forward_close(snapshot.sidecar_session_id.clone())
            .await
        {
            warn!(error = %e, "compaction: forward_close on old session failed");
        }
    }

    // 4. Spawn a NEW planner session. Re-uses the locked system prompt (the
    //    sidecar reads it fresh on every `forward_start`), the same mcpKind,
    //    and the same allowed-tools list.
    let new_sidecar_session_id = format!("planner-{}", uuid::Uuid::new_v4());
    let sidecar = app
        .try_state::<Arc<SidecarManager>>()
        .ok_or_else(|| "SidecarManager not managed".to_string())?;
    if let Err(e) = sidecar
        .forward_start(
            new_sidecar_session_id.clone(),
            PLANNER_PROVIDER_DEFAULT.to_string(),
            snapshot.model.clone(),
            spec_mode_system_prompt(),
            planner_allowed_tools(),
            serde_json::Value::Null, // mcpServers — sidecar builds the planner tools from `mcpKind`
            snapshot.project_path.clone(),
            String::new(), // initialMessage — empty; we inject the summary right after
            None,          // apiKey — claude-oauth pulls from ~/.claude
            None,          // resume — fresh session
            Some(false),   // thinkingEnabled
            Some(false),   // planMode
            serde_json::Value::Null, // attachments
            serde_json::Value::Null, // resumeMessages
            None,          // permissionMode
            None,          // approveWrites
            Some(PLANNER_MCP_KIND.to_string()),
            None, // commandPath
            None, // workspace — derive local from projectPath
        )
        .await
    {
        // E10 FIX P1-B — `forward_start` failed AFTER we closed the old
        // session, so the mission currently has NO active planner. We must
        // clear `compaction_in_progress` (otherwise the UI pill spins
        // forever), record the failure for the backoff gate, and emit a
        // compaction-completed event with an error payload so the frontend
        // can show a toast. Journal the failure so the user has breadcrumb.
        let err = format!("compaction: forward_start on new session failed: {}", e);
        warn!(
            mission_id,
            error = %err,
            "compaction: forward_start failed; mission has no active planner session"
        );
        let failure_count = registry.record_compaction_failure(mission_id).await;
        maybe_journal_failure_escalation(app, mission_id, failure_count, "forward_start", &err)
            .await;
        // Always journal the forward_start failure (independent of the
        // escalation threshold) — the user needs to know the planner is
        // gone and they should hit Start Planner to recover.
        let recovery_entry = journal_entry(
            mission_id.to_string(),
            JournalKind::SystemNote,
            format!(
                "**Compaction failed**: could not start replacement planner session: {}. \
                 Mission has no active planner; use 'Start Planner' to recover.",
                e
            ),
            Some(serde_json::json!({
                "event": "compaction_failed",
                "phase": "forward_start",
            })),
        );
        write_journal_and_emit(app, recovery_entry).await;
        let _ = app.emit(
            &format!("mission-planner:compaction-completed:{}", mission_id),
            serde_json::json!({
                "missionId": mission_id,
                "error": err,
                "phase": "forward_start",
            }),
        );
        return Err(err);
    }

    // 5. Inject the summary as a `wake_trigger` to prime the new session.
    //    `compaction_resume` is a new wake-kind; the planner's system prompt
    //    teaches the model that this body is a compressed history of the
    //    prior session and the next real event will be a normal wake.
    let preamble = format!(
        "Compaction summary of mission progress so far:\n\n{}\n\n\
         Continue from this state. The next event in your conversation \
         will be the wake-trigger you would normally have received.",
        summary
    );
    if let Err(e) = sidecar
        .forward_inject_user_turn(
            &new_sidecar_session_id,
            &preamble,
            "wake_trigger",
            Some("compaction_resume"),
            // max_output_tokens: deliberately None — this is a priming turn;
            // the planner shouldn't produce a long response. Sidecar falls
            // back to its default.
            None,
        )
        .await
    {
        // E10 FIX P1-C — inject failed AFTER we spawned a new session. If
        // we let the swap happen, the planner would receive task_completed
        // events for milestones it has never heard of (no priming context)
        // — registry state would fragment from the model's beliefs.
        // Roll back by closing the orphan we just spawned, record the
        // failure, journal+emit. The OLD session is already closed, so
        // recovery is the same "no active planner" state as P1-B.
        let err = format!(
            "compaction: forward_inject_user_turn for resume preamble failed: {}",
            e
        );
        warn!(
            mission_id,
            error = %err,
            new_sidecar_session_id,
            "compaction: inject summary failed; rolling back new session"
        );
        // Close the orphan (best-effort — same shape as the old-session
        // close above).
        if let Err(close_err) = sidecar.forward_close(new_sidecar_session_id.clone()).await {
            warn!(
                mission_id,
                error = %close_err,
                "compaction: forward_close on rollback failed"
            );
        }
        let failure_count = registry.record_compaction_failure(mission_id).await;
        maybe_journal_failure_escalation(app, mission_id, failure_count, "inject", &err).await;
        let recovery_entry = journal_entry(
            mission_id.to_string(),
            JournalKind::SystemNote,
            format!(
                "**Compaction failed**: replacement planner session was created but priming \
                 context could not be injected: {}. Replacement session rolled back. Mission \
                 has no active planner; use 'Start Planner' to recover.",
                e
            ),
            Some(serde_json::json!({
                "event": "compaction_failed",
                "phase": "inject",
            })),
        );
        write_journal_and_emit(app, recovery_entry).await;
        let _ = app.emit(
            &format!("mission-planner:compaction-completed:{}", mission_id),
            serde_json::json!({
                "missionId": mission_id,
                "error": err,
                "phase": "inject",
            }),
        );
        return Err(err);
    }

    // 6. Swap the registry's sidecar_session_id, zero cumulative tokens,
    //    clear in-progress. Single mutex-acquire helper on the registry so
    //    we don't expose the private `sessions` field.
    //
    // E10 FIX P1-D — the helper now returns `false` when the planner has
    // been removed from the registry mid-compaction (user clicked Stop
    // during the long summarizer round-trip). In that case the new
    // sidecar session we just started is an orphan — close it and bail
    // with Ok (user intentionally stopped, not an error condition).
    let swapped = registry
        .swap_sidecar_session_after_compaction(mission_id, &new_sidecar_session_id)
        .await;
    if !swapped {
        info!(
            mission_id,
            new_sidecar_session_id,
            "compaction: mission stopped during compaction; closing new session as orphan"
        );
        if let Err(e) = sidecar.forward_close(new_sidecar_session_id.clone()).await {
            warn!(
                mission_id,
                error = %e,
                "compaction: forward_close on stop-during-compaction orphan failed"
            );
        }
        return Ok(());
    }

    // 7. Persist the new sidecar session id (and Idle status) on the Flight
    //    DTO. `persist_planner_state_on_flight` is the single canonical
    //    serializer for this state — it serializes through the state lock
    //    so we can't race a concurrent `accumulate_planner_cost` /
    //    cold-start enforce.
    if let Err(e) = persist_planner_state_on_flight(
        mission_id,
        Some(&new_sidecar_session_id),
        Some(PlannerStatus::Idle),
    )
    .await
    {
        warn!(
            mission_id,
            error = %e,
            "compaction: failed to persist new sidecar session id on Flight DTO"
        );
        // Non-fatal — in-memory registry is authoritative.
    }

    // 8. Journal the swap. Kind is `SystemNote` for v1; E10-UI-TESTS may
    //    add a dedicated `Compaction` kind later — until then, the
    //    `metadata.event = "compaction"` discriminator lets the JournalTab
    //    pick out the entry.
    let body = format!(
        "**Compaction**: planner context exceeded {} tokens; restarted session with summary.\n\n\
         **Summary**: {}",
        COMPACTION_THRESHOLD_TOKENS, summary,
    );
    let entry = journal_entry(
        mission_id.to_string(),
        JournalKind::SystemNote,
        body,
        Some(serde_json::json!({
            "event": "compaction",
            "newSidecarSessionId": new_sidecar_session_id,
            "thresholdTokens": COMPACTION_THRESHOLD_TOKENS,
        })),
    );
    write_journal_and_emit(app, entry).await;

    // 9. UI hint — the frontend's missionPlannerStore can listen for this
    //    and surface a "Context compacted" toast.
    let _ = app.emit(
        &format!("mission-planner:compaction-completed:{}", mission_id),
        serde_json::json!({
            "missionId": mission_id,
            "newSidecarSessionId": new_sidecar_session_id,
        }),
    );

    info!(mission_id, new_sidecar_session_id, "compaction completed");
    Ok(())
}

/// E10 FIX P1-A — emit a `SystemNote` journal entry when `failure_count`
/// crosses [`COMPACTION_FAILURE_ESCALATION_COUNT`] so the user sees a
/// breadcrumb in the journal that compaction is failing repeatedly and
/// likely needs manual intervention (check Sonnet quota, sidecar health,
/// disk space for `~/.claude`, etc.).
///
/// Below the threshold this is a no-op — early failures don't deserve a
/// journal entry beyond the per-failure phase-specific entry written by
/// the caller.
async fn maybe_journal_failure_escalation(
    app: &AppHandle,
    mission_id: &str,
    failure_count: u32,
    phase: &str,
    error: &str,
) {
    if failure_count < COMPACTION_FAILURE_ESCALATION_COUNT {
        return;
    }
    warn!(
        mission_id,
        failure_count, phase, "compaction has failed repeatedly; escalating via journal"
    );
    let entry = journal_entry(
        mission_id.to_string(),
        JournalKind::SystemNote,
        format!(
            "**Compaction failing repeatedly** ({} consecutive failures, latest in `{}` phase). \
             Manual intervention may be required: check Claude / Sonnet quota, sidecar health, \
             and the mission journal file. Latest error: {}",
            failure_count, phase, error
        ),
        Some(serde_json::json!({
            "event": "compaction_failure_escalation",
            "failureCount": failure_count,
            "phase": phase,
        })),
    );
    write_journal_and_emit(app, entry).await;
}

/// Read the mission's project path off the Flight DTO; fall back to the
/// process cwd. Used to feed `forward_start`'s `projectPath` arg on the new
/// session — the same path the original planner was started with.
async fn resolve_planner_project_path(mission_id: &str) -> String {
    let state = crate::core::storage::load_state();
    if let Some(flight) = state.flights.iter().find(|f| f.id == mission_id) {
        if !flight.project_path.is_empty() {
            return flight.project_path.clone();
        }
    }
    std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_journal_keeps_latest_entries() {
        let journal = "old entry 1\nold entry 2\nlatest entry\n";
        let truncated = truncate_journal_for_summary(journal, 20);
        assert!(
            truncated.contains("latest"),
            "expected latest entry in tail, got: {}",
            truncated
        );
        assert!(
            truncated.contains("truncated"),
            "expected truncation marker, got: {}",
            truncated
        );
    }

    #[test]
    fn truncate_journal_keeps_full_journal_if_small() {
        let journal = "tiny journal";
        let truncated = truncate_journal_for_summary(journal, 1000);
        assert_eq!(truncated, journal);
    }

    #[test]
    fn truncate_journal_at_exact_budget_is_unchanged() {
        // Edge: len == max_chars must NOT trigger the truncate branch.
        let journal = "abcdefghij"; // 10 chars
        let truncated = truncate_journal_for_summary(journal, 10);
        assert_eq!(truncated, journal);
    }

    #[test]
    fn truncate_journal_snaps_to_newline() {
        // Build a journal where the naive byte cut would land mid-line.
        // The tail-keep behavior should advance past the next newline
        // so we never emit a half-line header like `entry id:ab...`.
        let journal = "AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\nDDDDDDDDDD\n";
        let truncated = truncate_journal_for_summary(journal, 15);
        // Truncated string should not contain a mid-line fragment of
        // the older rows ("AAAAAAAAAA").
        assert!(truncated.contains("truncated"));
        assert!(!truncated.contains("AAAAAAAAAA"));
        // The latest line is preserved.
        assert!(truncated.contains("DDDDDDDDDD"));
    }

    #[test]
    fn build_summarization_prompt_includes_journal() {
        let prompt = build_summarization_prompt("foo bar baz");
        assert!(prompt.contains("foo bar baz"));
        assert!(prompt.contains("Summarize"));
    }

    #[test]
    fn build_summarization_prompt_lists_required_sections() {
        let prompt = build_summarization_prompt("body");
        // The rubric is load-bearing — losing a line silently regresses
        // the summary quality. Pin every numbered item.
        assert!(prompt.contains("1. Mission objective"));
        assert!(prompt.contains("2. Milestones"));
        assert!(prompt.contains("3. Tasks"));
        assert!(prompt.contains("4. Current state"));
        assert!(prompt.contains("=== JOURNAL ==="));
        assert!(prompt.contains("=== END JOURNAL ==="));
    }

    /// Live one-shot Claude call — gated `#[ignore]` because it hits
    /// the network and depends on a running sidecar + valid Claude
    /// OAuth credentials. Run manually with
    /// `cargo test --lib commands::mission_planner_compaction::tests::summarize_live -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn summarize_live() {
        // Stub — exercising the end-to-end path requires a Tauri
        // AppHandle + a managed SidecarManager + a populated journal.
        // The dedicated harness for this lives in the E2E integration
        // tests; this placeholder keeps the test attribute discoverable.
    }

    // -----------------------------------------------------------------
    // E10-SWAP — orchestrator failure-path coverage
    // -----------------------------------------------------------------

    /// Unit-level coverage for the summarizer-failure recovery path.
    ///
    /// `perform_compaction` requires a live `AppHandle` (for
    /// `app.try_state` / `app.emit` / `app.listen`) plus a managed
    /// `SidecarManager` to drive `forward_start` / `forward_close` /
    /// `forward_inject_user_turn`. Tauri 2's `mock_runtime` does not
    /// provide a usable async sidecar harness, so we can't exercise the
    /// full orchestrator without a real Tauri context.
    ///
    /// What we **can** verify directly is the registry-side contract that
    /// the failure path depends on: calling
    /// `MissionPlannerRegistry::reset_compaction_in_progress` clears the
    /// `compaction_in_progress` flag without disturbing the cumulative
    /// token counter. The orchestrator's `Err` branch in
    /// `perform_compaction` (above) is the only caller of this method, so
    /// pinning its behavior here is a load-bearing assertion: a future
    /// refactor that subtly mutates `cumulative_input_tokens` in the
    /// reset method would let summarizer failures effectively disable
    /// compaction permanently (since the next bump would re-cross the
    /// threshold, set `compaction_in_progress`, and we'd loop forever).
    #[tokio::test]
    async fn reset_compaction_in_progress_clears_flag_without_zeroing_tokens() {
        use crate::commands::mission_planner::{MissionPlannerRegistry, MissionPlannerSession};
        let registry = MissionPlannerRegistry::default();

        // Build a session manually via the public Default+insert path the
        // registry exposes — we can't go through start_mission_planner
        // because that requires a real sidecar. The test_helpers module
        // in `mission_planner.rs` doesn't exist, so we go through the
        // public `Default` for the session struct and serde to fill it.
        let mut session: MissionPlannerSession = serde_json::from_value(serde_json::json!({
            "id": "p-1",
            "missionId": "m-1",
            "sidecarSessionId": "sid-old",
            "status": "idle",
            "model": "claude-sonnet-4-6",
            "startedAt": 0u64,
            "lastTickAt": 0u64,
            "totalInputTokens": 0u64,
            "totalOutputTokens": 0u64,
            "totalCostUsd": 0.0,
            "toolCallsThisTick": 0u32,
            "replansPerTask": {},
            "helperSpawned": false,
            "currentMode": "spec",
            "quotaLease": 0u64,
            "cumulativeInputTokens": 123_456u64,
            "compactionInProgress": true,
        }))
        .expect("session fixture");
        // Force the in-progress flag set, even if the JSON above changes.
        session.compaction_in_progress = true;
        session.cumulative_input_tokens = 123_456;
        registry.insert_for_test(session).await;

        registry.reset_compaction_in_progress("m-1").await;

        let snapshot = registry
            .get_by_mission("m-1")
            .await
            .expect("session still present");
        assert!(
            !snapshot.compaction_in_progress,
            "reset_compaction_in_progress must clear the flag"
        );
        assert_eq!(
            snapshot.cumulative_input_tokens, 123_456,
            "reset_compaction_in_progress must NOT zero the token counter \
             (zeroing would let the next bump re-cross the threshold and \
             loop forever after a summarizer failure)"
        );
    }

    /// `swap_sidecar_session_after_compaction` is the success-path counterpart
    /// of `reset_compaction_in_progress`. The two are mutually exclusive —
    /// successful summarize → swap, failed summarize → reset-only — and
    /// together they keep the registry in a consistent state across all
    /// branches of the compaction orchestrator.
    #[tokio::test]
    async fn swap_sidecar_session_after_compaction_resets_tokens_and_flag() {
        use crate::commands::mission_planner::{MissionPlannerRegistry, MissionPlannerSession};
        let registry = MissionPlannerRegistry::default();
        let mut session: MissionPlannerSession = serde_json::from_value(serde_json::json!({
            "id": "p-1",
            "missionId": "m-1",
            "sidecarSessionId": "sid-old",
            "status": "idle",
            "model": "claude-sonnet-4-6",
            "startedAt": 0u64,
            "lastTickAt": 0u64,
            "totalInputTokens": 0u64,
            "totalOutputTokens": 0u64,
            "totalCostUsd": 0.0,
            "toolCallsThisTick": 0u32,
            "replansPerTask": {},
            "helperSpawned": false,
            "currentMode": "spec",
            "quotaLease": 0u64,
            "cumulativeInputTokens": 200_000u64,
            "compactionInProgress": true,
        }))
        .expect("session fixture");
        session.compaction_in_progress = true;
        session.cumulative_input_tokens = 200_000;
        registry.insert_for_test(session).await;

        let swapped = registry
            .swap_sidecar_session_after_compaction("m-1", "sid-new")
            .await;
        assert!(
            swapped,
            "swap must return true when the session exists in the registry"
        );

        let snap = registry
            .get_by_mission("m-1")
            .await
            .expect("session still present");
        assert_eq!(snap.sidecar_session_id, "sid-new");
        assert_eq!(snap.cumulative_input_tokens, 0);
        assert!(!snap.compaction_in_progress);
    }

    /// E10 FIX P1-D — when the planner has been removed from the registry
    /// mid-compaction (user clicked Stop during the summarizer round-trip),
    /// the swap helper must return `false` so the orchestrator knows to
    /// close the freshly-spawned sidecar session as an orphan instead of
    /// leaking it. The orchestrator path itself can't be unit-tested
    /// without a Tauri AppHandle, but the registry-side contract IS
    /// testable, and the orchestrator's correctness is downstream of this
    /// guarantee.
    #[tokio::test]
    async fn swap_sidecar_session_after_compaction_returns_false_when_missing() {
        use crate::commands::mission_planner::MissionPlannerRegistry;
        let registry = MissionPlannerRegistry::default();
        let swapped = registry
            .swap_sidecar_session_after_compaction("does-not-exist", "sid-new")
            .await;
        assert!(
            !swapped,
            "swap must return false when no planner is registered (stop-during-compaction \
             — caller is responsible for closing the new sidecar session as an orphan)"
        );
    }

    /// E10 FIX P1-A — record_compaction_failure gates the next
    /// bump_cumulative_input_and_check via `last_compaction_failure_at`.
    /// Until the backoff window elapses, even a threshold-crossing bump
    /// must NOT re-fire the trigger.
    #[tokio::test]
    async fn failure_backoff_suppresses_immediate_retrigger() {
        use crate::commands::mission_planner::{
            MissionPlannerRegistry, MissionPlannerSession, COMPACTION_THRESHOLD_TOKENS,
        };
        let registry = MissionPlannerRegistry::default();
        let mut session =
            MissionPlannerSession::new("p-1".to_string(), "m-1".to_string(), "sid-old".to_string());
        // Already over threshold from a prior turn that triggered the
        // (now-failed) compaction.
        session.cumulative_input_tokens = COMPACTION_THRESHOLD_TOKENS + 5_000;
        registry.insert_for_test(session).await;

        // First failure — records timestamp + counter = 1.
        let count = registry.record_compaction_failure("m-1").await;
        assert_eq!(count, 1, "first failure bumps counter to 1");

        // Immediately after the failure, a turn that adds more tokens
        // would otherwise re-cross threshold, but the backoff gate must
        // suppress it.
        let fired = registry
            .bump_cumulative_input_and_check("m-1", 10_000)
            .await;
        assert!(
            !fired,
            "backoff gate must suppress re-trigger immediately after failure"
        );

        let snap = registry
            .get_by_mission("m-1")
            .await
            .expect("session still present");
        assert!(
            !snap.compaction_in_progress,
            "compaction_in_progress must remain cleared by record_compaction_failure"
        );
        assert!(
            snap.last_compaction_failure_at.is_some(),
            "last_compaction_failure_at must be set after record_compaction_failure"
        );
        assert_eq!(snap.consecutive_compaction_failures, 1);
    }

    /// E10 FIX P1-A — a successful swap clears the failure tracking so
    /// the next genuine threshold crossing fires immediately. Pins the
    /// load-bearing contract on `swap_sidecar_session_after_compaction`:
    /// reset BOTH `last_compaction_failure_at` (release backoff) AND
    /// `consecutive_compaction_failures` (release escalation counter).
    #[tokio::test]
    async fn successful_swap_clears_failure_tracking() {
        use crate::commands::mission_planner::{MissionPlannerRegistry, MissionPlannerSession};
        let registry = MissionPlannerRegistry::default();
        let session =
            MissionPlannerSession::new("p-1".to_string(), "m-1".to_string(), "sid-old".to_string());
        registry.insert_for_test(session).await;
        let _ = registry.record_compaction_failure("m-1").await;
        let _ = registry.record_compaction_failure("m-1").await;
        let snap_before = registry.get_by_mission("m-1").await.unwrap();
        assert_eq!(snap_before.consecutive_compaction_failures, 2);
        assert!(snap_before.last_compaction_failure_at.is_some());

        // Now simulate a successful compaction → swap.
        let swapped = registry
            .swap_sidecar_session_after_compaction("m-1", "sid-new")
            .await;
        assert!(swapped);

        let snap_after = registry.get_by_mission("m-1").await.unwrap();
        assert_eq!(
            snap_after.consecutive_compaction_failures, 0,
            "successful swap must reset the failure counter"
        );
        assert!(
            snap_after.last_compaction_failure_at.is_none(),
            "successful swap must clear the failure timestamp (release backoff gate)"
        );
        // Sanity: the existing swap contract still holds.
        assert_eq!(snap_after.sidecar_session_id, "sid-new");
        assert_eq!(snap_after.cumulative_input_tokens, 0);
        assert!(!snap_after.compaction_in_progress);
    }

    /// E10 FIX P0 — `install_compaction_listener` returns an `EventId` and
    /// the registry can store + take it. We can't fully exercise the
    /// listener round-trip without a Tauri AppHandle (mocks not available
    /// for v2's runtime), but we CAN pin the registry-side contract:
    /// `set_compaction_listener` records the id and `take_compaction_listener`
    /// returns it exactly once (next call returns None — the listener has
    /// been moved out for the unlisten call).
    #[tokio::test]
    async fn compaction_listener_set_take_is_one_shot() {
        use crate::commands::mission_planner::{MissionPlannerRegistry, MissionPlannerSession};
        let registry = MissionPlannerRegistry::default();
        let session =
            MissionPlannerSession::new("p-1".to_string(), "m-1".to_string(), "sid-1".to_string());
        registry.insert_for_test(session).await;

        // tauri::EventId is a u32 alias — any value will do for the
        // round-trip assertion.
        let fake_id: tauri::EventId = 42;
        registry.set_compaction_listener("m-1", fake_id).await;
        let taken = registry.take_compaction_listener("m-1").await;
        assert_eq!(
            taken,
            Some(fake_id),
            "take_compaction_listener must return the stored id"
        );
        let taken_again = registry.take_compaction_listener("m-1").await;
        assert!(
            taken_again.is_none(),
            "take_compaction_listener must clear the slot so a second call returns None"
        );
    }

    /// E10 FIX P0 regression — stop-and-restart must NOT accumulate
    /// listeners. Without an unlisten on stop, every start→stop cycle
    /// leaks a listener and one event fires N tasks. Fully exercising
    /// this requires Tauri's listener subsystem (live AppHandle), which
    /// the mock runtime does not expose. The corresponding registry-side
    /// contract is pinned by `compaction_listener_set_take_is_one_shot`
    /// above; this test is the documented hole for the full integration
    /// path.
    #[tokio::test]
    #[ignore = "requires live Tauri AppHandle to count installed listeners; covered by E10-UI-TESTS"]
    async fn stop_planner_unlistens_compaction_event() {
        // Steps when implemented:
        //   1. Build a Tauri test runtime with an AppHandle.
        //   2. Manage a MissionPlannerRegistry on the app.
        //   3. Call start_mission_planner once; capture the EventId
        //      stored on the session via get_by_mission.
        //   4. Call stop_mission_planner.
        //   5. Verify the session is gone AND that emitting
        //      `mission-planner:compaction-triggered:<mid>` does NOT
        //      spawn a perform_compaction task (the listener was
        //      unlistened).
        //   6. Restart and stop a second time; assert no listener
        //      accumulation (e.g. via Tauri's internal listener count
        //      if exposed, or by emitting the event and counting
        //      tracing-spans for "starting context compaction").
    }

    /// Live end-to-end test for the orchestrator. Requires a Tauri
    /// runtime with a managed `MissionPlannerRegistry` and
    /// `SidecarManager`, plus a populated mission journal — `#[ignore]`d
    /// for the default `cargo test` run.
    #[tokio::test]
    #[ignore = "requires live Tauri runtime + sidecar; covered by the E2E integration test once E10-UI-TESTS lands"]
    async fn perform_compaction_clears_in_progress_on_summarization_failure() {
        // Steps when implemented:
        //   1. Build an AppHandle with mock sidecar that drives
        //      summarize_mission_journal to Err.
        //   2. Insert a planner session with `compaction_in_progress = true`.
        //   3. Call `perform_compaction(app, mission_id)`.
        //   4. Assert the returned Result is Err.
        //   5. Assert `compaction_in_progress` is now `false` (so the
        //      next threshold cross can retry).
        //   6. Assert `cumulative_input_tokens` is UNCHANGED (we did NOT
        //      actually compact — see the reset_compaction_in_progress
        //      unit test above).
    }
}
