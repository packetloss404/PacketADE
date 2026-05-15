//! Mission Planner — registry, wake bus, and Tauri commands. (Epic E1.)
//!
//! The Mission Planner is one long-lived `api-claude-oauth` session per
//! Mission (`core::flight::Flight`) that owns the mission's planning loop
//! end-to-end: spec-mode chat → initial decomposition → reactive replan on
//! task complete/fail / approval gate / collision / quota.
//!
//! This module is the **Rust-side coordination layer**:
//!   * [`MissionPlannerRegistry`] — Tauri-managed state keyed by mission id.
//!     Holds one [`MissionPlannerSession`] per active planner.
//!   * Five Tauri commands ([`start_mission_planner`] / `stop` / `pause` /
//!     `resume` / [`inject_planner_turn`]) that the frontend
//!     `missionPlannerStore` drives.
//!   * A wake-consumer task spawned at startup
//!     ([`spawn_wake_consumer`]) that receives [`PlannerWakeEvent`]s from
//!     orchestration hook sites, debounces a 2-3s window, formats the wake
//!     message via `core::mission_planner_prompts`, and forwards it to the
//!     sidecar over the new typed `inject_user_turn` message (protocol v5).
//!
//! What this module does **not** own (deliberately, by epic split):
//!   * The planner's MCP tool surface (`create_milestone`, `create_task`,
//!     ...) — that's E2 (`mcp/mission-planner-server.ts` on the sidecar
//!     side; tool dispatch handlers slot into this file in E2).
//!   * The actual system prompt content / per-trigger guidance — E4/E5
//!     (stubbed in `core/mission_planner_prompts.rs`).
//!   * Caps / replan limits / kill-switch / quota-pause backoff — E6.
//!   * The mission journal storage — E7.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::commands::agent_sidecar::SidecarManager;
use crate::core::flight::PlannerStatus as FlightPlannerStatus;
use crate::core::mission_planner_prompts::{spec_mode_system_prompt, wake_user_message};
use crate::core::storage;

// ---------------------------------------------------------------------------
// Wake consumer tuning constants
// ---------------------------------------------------------------------------

/// Default debounce window for the wake consumer.
///
/// The locked design calls for a 2-3s window so that bursts of task-complete
/// events (e.g. 8 parallel tasks finishing in 1s) coalesce into a single
/// planner turn rather than 8 sequential ones (which would trip Anthropic's
/// TPM throttle and waste cache reads).
///
/// 2s is the lower bound of the locked design's stated range — favors
/// responsiveness over coalescing. E6 may make this configurable.
const WAKE_DEBOUNCE_MS: u64 = 2_000;

/// Planner model. The locked design pins this to Claude Sonnet 4.6 for the
/// primary planner; the (deferred-to-v1.1) helper planner uses Opus 4.7.
const PLANNER_MODEL: &str = "claude-sonnet-4-6";

/// Provider string the sidecar dispatches on. Must match
/// `agent_sidecar::SIDECAR_PROVIDERS` (which it does — `"claude-oauth"`).
const PLANNER_PROVIDER: &str = "claude-oauth";

/// The `mcpKind` discriminator the sidecar uses to construct the in-process
/// Mission Planner tool MCP server. Mirrors the sidecar TS constant in
/// `agent-sidecar/src/mcp/mission-planner-server.ts`.
const PLANNER_MCP_KIND: &str = "planner";

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

/// Runtime status of a planner agent for a single mission. The persisted
/// mirror on the Flight DTO is [`crate::core::flight::PlannerStatus`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlannerStatus {
    /// Planner session is started but not currently processing a turn.
    Idle,
    /// Planner is actively processing a turn (wake-triggered or user-sent).
    Awake,
    /// User-initiated pause via the kill-switch / pause button. Resumes
    /// cleanly via [`resume_mission_planner`]. Wake events received while
    /// paused are dropped on the floor (intentional — see [`spawn_wake_consumer`]).
    Paused,
    /// Hit Anthropic rate-limit on a turn; the supervisor's backoff timer
    /// will retry. Distinct from [`PlannerStatus::Paused`] so the UI can
    /// surface the right reason. (E6 wires the actual backoff.)
    QuotaPaused,
    /// Planner called `complete_mission`. The session is closed.
    Completed,
    /// Planner failed in a way that we couldn't auto-recover from (kill
    /// switch, exhausted retries, etc.).
    Failed,
}

impl PlannerStatus {
    /// Map to the persisted Flight DTO variant. Kept manual rather than via
    /// `From` so a future divergence between runtime and persisted forms
    /// doesn't sneak through.
    pub fn to_flight_status(self) -> FlightPlannerStatus {
        match self {
            Self::Idle => FlightPlannerStatus::Idle,
            Self::Awake => FlightPlannerStatus::Awake,
            Self::Paused => FlightPlannerStatus::Paused,
            Self::QuotaPaused => FlightPlannerStatus::QuotaPaused,
            Self::Completed => FlightPlannerStatus::Completed,
            Self::Failed => FlightPlannerStatus::Failed,
        }
    }
}

/// Wake-trigger discriminant — the reason the planner is being re-entered.
///
/// Variant data is the minimum we need to format a useful wake message in
/// [`core::mission_planner_prompts::wake_user_message`]. Anything heavier
/// (full mission snapshot, journal tail) is gathered by the consumer at
/// wake time, not stuffed into the variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeTrigger {
    /// First wake after Launch — planner runs initial decomposition.
    Decomposition,
    /// A task in this mission completed (success).
    TaskCompleted(String),
    /// A task in this mission completed (failure).
    TaskFailed(String),
    /// A task hit an approval gate (`request_user_approval` or async-attempt
    /// approval-needed transition).
    ApprovalGateReached(String),
    /// File-collision detected across parallel attempts. The vec is the task
    /// ids that collided.
    CollisionDetected(Vec<String>),
    /// User typed a message into the journal panel — relayed as a wake so
    /// the planner can incorporate the steer.
    UserMessageInJournal(String),
    /// Anthropic API returned a rate-limit error on a previous turn.
    QuotaExhausted,
}

impl WakeTrigger {
    /// Stable snake_case string for the `<wake_trigger kind="…">` attribute.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Decomposition => "decomposition",
            Self::TaskCompleted(_) => "task_completed",
            Self::TaskFailed(_) => "task_failed",
            Self::ApprovalGateReached(_) => "approval_gate_reached",
            Self::CollisionDetected(_) => "collision_detected",
            Self::UserMessageInJournal(_) => "user_message_in_journal",
            Self::QuotaExhausted => "quota_exhausted",
        }
    }
}

/// Outbound wake-bus event. Emitted by orchestration hook sites (see
/// `commands::orchestration`) and consumed by the wake consumer task.
///
/// `payload` is arbitrary structured context the orchestrator wants to
/// surface — e.g. the task's stdout tail on failure, the colliding paths
/// for `CollisionDetected`. The wake consumer hands it to the
/// `wake_user_message` builder verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerWakeEvent {
    pub mission_id: String,
    pub trigger: WakeTrigger,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Runtime record of a planner agent attached to a mission.
///
/// Field set is the locked-design v1 surface. Most counters are written by
/// later epics:
///   * `total_input_tokens` / `total_output_tokens` / `total_cost_usd` — E8
///     (planner cost split on the StatGrid).
///   * `tool_calls_this_tick` — E6 (per-tick caps).
///   * `replans_per_task` — E6 (replan-per-task ≤ 3 ceiling, excluding
///     RateLimit / Network categories).
///   * `helper_spawned` — v1.1, but the field exists so the journal flag
///     has somewhere to land.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionPlannerSession {
    /// Stable id we hand back to the frontend. Distinct from
    /// `sidecar_session_id` so we can re-open a sidecar session after a
    /// crash without changing the user-visible planner identity. For now
    /// they're set in lockstep.
    pub id: String,
    pub mission_id: String,
    /// The `api-agent:*` event id the sidecar streams under.
    pub sidecar_session_id: String,
    pub status: PlannerStatus,
    /// Model string — always [`PLANNER_MODEL`] in v1; E6 may swap for a
    /// helper one-shot.
    pub model: String,
    /// Epoch millis when the session was first started in this app run.
    pub started_at: u64,
    /// Epoch millis of the most recent wake turn (or start, before any wake).
    pub last_tick_at: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost_usd: f64,
    /// Reset every tick; bumped per MCP-tool dispatch in E2.
    pub tool_calls_this_tick: u32,
    /// Per-task replan attempt counter — keyed by task id. E6 enforces the
    /// ≤ 3 ceiling. RateLimit / Network errors do NOT count (handled at
    /// the call site, not here).
    pub replans_per_task: HashMap<String, u32>,
    /// True after a successful helper-planner spawn (v1.1 only).
    pub helper_spawned: bool,
}

impl MissionPlannerSession {
    fn new(id: String, mission_id: String, sidecar_session_id: String) -> Self {
        let now = now_millis();
        Self {
            id,
            mission_id,
            sidecar_session_id,
            status: PlannerStatus::Idle,
            model: PLANNER_MODEL.to_string(),
            started_at: now,
            last_tick_at: now,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost_usd: 0.0,
            tool_calls_this_tick: 0,
            replans_per_task: HashMap::new(),
            helper_spawned: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Registry — Tauri-managed shared state
// ---------------------------------------------------------------------------

/// Tauri-managed state holding live planner sessions keyed by mission id,
/// plus the wake-bus sender that orchestration hooks fan events into.
///
/// Wrapped in `Arc<Mutex<…>>` for the registry table itself; the sender is
/// `Clone` and `Send` so call sites just clone-and-send without locking.
#[derive(Default)]
pub struct MissionPlannerRegistry {
    sessions: Mutex<HashMap<String, MissionPlannerSession>>,
    wake_tx: Mutex<Option<mpsc::UnboundedSender<PlannerWakeEvent>>>,
}

impl MissionPlannerRegistry {
    /// Install the wake-bus sender. Called once at app startup from
    /// [`spawn_wake_consumer`].
    pub async fn install_wake_sender(&self, tx: mpsc::UnboundedSender<PlannerWakeEvent>) {
        let mut guard = self.wake_tx.lock().await;
        *guard = Some(tx);
    }

    /// Send a wake event onto the bus. Safe to call from any orchestration
    /// hook site. Silently drops the event if the registry hasn't been
    /// hooked up yet (only happens during very early startup).
    pub async fn send_wake(&self, event: PlannerWakeEvent) {
        let tx = {
            let guard = self.wake_tx.lock().await;
            guard.clone()
        };
        match tx {
            Some(tx) => {
                if let Err(e) = tx.send(event) {
                    warn!(error = %e, "mission planner wake channel send failed");
                }
            }
            None => {
                // Pre-setup. Not an error — orchestration tests fire wakes
                // without a wake consumer registered.
            }
        }
    }

    /// Look up a session by mission id and return a clone.
    pub async fn get_by_mission(&self, mission_id: &str) -> Option<MissionPlannerSession> {
        let guard = self.sessions.lock().await;
        guard.get(mission_id).cloned()
    }

    /// Look up the sidecar session id for a mission, if any. Synchronous-
    /// looking helper for orchestration hook sites that just need to know
    /// "is there an active planner for this mission?". Used by future
    /// epics (E2 tool dispatch, E5 reactive replan) — kept here so the
    /// signature is locked alongside the rest of the registry surface.
    #[allow(dead_code)]
    pub fn try_sidecar_session_for(&self, mission_id: &str) -> Option<String> {
        self.sessions
            .try_lock()
            .ok()
            .and_then(|g| g.get(mission_id).map(|s| s.sidecar_session_id.clone()))
    }

    /// Set or replace the planner session for a mission. Returns the
    /// previous session, if any (so caller can decide whether to close it).
    async fn insert(&self, session: MissionPlannerSession) -> Option<MissionPlannerSession> {
        let mut guard = self.sessions.lock().await;
        guard.insert(session.mission_id.clone(), session)
    }

    /// Drop a session by mission id.
    async fn remove(&self, mission_id: &str) -> Option<MissionPlannerSession> {
        let mut guard = self.sessions.lock().await;
        guard.remove(mission_id)
    }

    /// Mutate a session's status (and `last_tick_at`) in place. No-op if
    /// the mission has no session.
    async fn set_status(&self, mission_id: &str, status: PlannerStatus) {
        let mut guard = self.sessions.lock().await;
        if let Some(s) = guard.get_mut(mission_id) {
            s.status = status;
            s.last_tick_at = now_millis();
        }
    }

    /// Dispatch an in-process planner MCP tool call. Invoked by
    /// `SidecarManager::handle_event` when a `planner_tool` envelope lands;
    /// the returned `Result` becomes the `planner_tool_result` reply that
    /// resolves the parked SDK tool handler in the sidecar.
    ///
    /// E1 scope is intentionally minimal: only the `mcp__planner__noop` /
    /// `noop` stub is supported, returning the `message` field from `args`
    /// untouched. E2 will replace this body with the real
    /// `create_milestone` / `create_task` / `update_task` /
    /// `mark_task_blocked` / `replan_after_failure` / `request_user_approval`
    /// / `complete_mission` dispatch.
    ///
    /// `session_id` is the sidecar session id (NOT the planner / mission
    /// id) — E2 may need it to look up the owning mission via the registry;
    /// E1 ignores it.
    pub async fn handle_tool_call(
        &self,
        _session_id: &str,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // The sidecar's `mcpServers["planner"]` key produces tool names with
        // the `mcp__planner__` prefix. Accept the bare name too so the
        // dispatcher is reusable from a non-MCP context (e.g. direct
        // command-line drive of the registry in tests).
        let bare = tool.strip_prefix("mcp__planner__").unwrap_or(tool);
        match bare {
            "noop" => Ok(serde_json::json!({
                "ok": true,
                "message": args.get("message").cloned().unwrap_or_default(),
            })),
            other => Err(format!(
                "E2: tool '{}' not yet implemented",
                other
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence helper — keep Flight DTO in sync with registry state
// ---------------------------------------------------------------------------

/// Write `planner_session_id` and `planner_status` onto the Flight DTO so
/// the frontend sees a consistent view after a refresh and so a cold restart
/// can surface "your planner sessions were interrupted" via the existing
/// recovery path.
///
/// Tolerant of a missing flight (e.g. mission was deleted between start and
/// status update) — silently no-ops.
fn persist_planner_state_on_flight(
    mission_id: &str,
    session_id: Option<&str>,
    status: Option<PlannerStatus>,
) {
    let mut state = storage::load_state();
    let mut changed = false;
    if let Some(flight) = state.flights.iter_mut().find(|f| f.id == mission_id) {
        if flight.planner_session_id.as_deref() != session_id {
            flight.planner_session_id = session_id.map(|s| s.to_string());
            changed = true;
        }
        let new_status = status.map(|s| s.to_flight_status());
        if flight.planner_status != new_status {
            flight.planner_status = new_status;
            changed = true;
        }
    }
    if changed {
        if let Err(e) = storage::save_state(&state) {
            warn!(error = %e, mission_id, "failed to persist planner state on flight");
        }
    }
}

// ---------------------------------------------------------------------------
// Wake consumer — debounce + dispatch
// ---------------------------------------------------------------------------

/// Spawn the wake-consumer task. Call once at app startup, after the
/// `SidecarManager` is in Tauri-managed state. Wires the registry's
/// `wake_tx` and drives a `select!` loop that pulls events off the
/// channel, debounces a [`WAKE_DEBOUNCE_MS`] window per mission, and then
/// dispatches one consolidated `inject_user_turn` per mission via the
/// sidecar.
pub fn spawn_wake_consumer(app_handle: AppHandle) {
    let (tx, mut rx) = mpsc::unbounded_channel::<PlannerWakeEvent>();

    // Install the sender so orchestration hooks can fan events in.
    let app_for_install = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(registry) = app_for_install.try_state::<MissionPlannerRegistry>() {
            registry.install_wake_sender(tx).await;
        } else {
            warn!("MissionPlannerRegistry not managed before wake consumer spawn");
        }
    });

    // The actual consumer loop.
    tauri::async_runtime::spawn(async move {
        // Pending wakes keyed by mission id. We replace-on-write so the
        // newest trigger for a given mission wins inside the debounce
        // window (per locked design: bursts coalesce, not stack).
        //
        // The locked design's reactive intent is that the planner reacts
        // to the latest state of the mission, not to N redundant copies
        // of "task completed" — picking the freshest event is fine because
        // the wake-message builder reads a fresh mission snapshot at
        // dispatch time anyway.
        let mut pending: HashMap<String, PlannerWakeEvent> = HashMap::new();
        let debounce = std::time::Duration::from_millis(WAKE_DEBOUNCE_MS);

        loop {
            // First, block until we get *something*. Then drain everything
            // available right now, then wait the debounce window for any
            // late arrivals before dispatching.
            let first = match rx.recv().await {
                Some(ev) => ev,
                None => {
                    info!("mission planner wake channel closed; consumer exiting");
                    return;
                }
            };
            pending.insert(first.mission_id.clone(), first);

            // Drain anything else already queued without blocking.
            while let Ok(ev) = rx.try_recv() {
                pending.insert(ev.mission_id.clone(), ev);
            }

            // Debounce window — collect anything that arrives within
            // [WAKE_DEBOUNCE_MS] of the first event. Resets if a new
            // event arrives so a steady drip keeps the window open
            // (bounded by total drain at most ~5x debounce in practice;
            // we accept the unbounded worst case because the sidecar
            // serializes turns anyway).
            loop {
                match tokio::time::timeout(debounce, rx.recv()).await {
                    Ok(Some(ev)) => {
                        pending.insert(ev.mission_id.clone(), ev);
                    }
                    Ok(None) => {
                        info!("mission planner wake channel closed mid-debounce");
                        return;
                    }
                    Err(_elapsed) => break, // debounce elapsed; dispatch
                }
            }

            // Dispatch one consolidated wake per mission.
            for (_mission, event) in pending.drain() {
                dispatch_wake(&app_handle, event).await;
            }
        }
    });
}

/// Format and forward a single consolidated wake event to the sidecar.
async fn dispatch_wake(app_handle: &AppHandle, event: PlannerWakeEvent) {
    let registry = match app_handle.try_state::<MissionPlannerRegistry>() {
        Some(r) => r,
        None => return,
    };

    // Skip dispatch if the planner is paused/quota-paused/completed/failed.
    let session = match registry.get_by_mission(&event.mission_id).await {
        Some(s) => s,
        None => return,
    };
    match session.status {
        PlannerStatus::Paused | PlannerStatus::QuotaPaused | PlannerStatus::Completed
        | PlannerStatus::Failed => {
            return;
        }
        PlannerStatus::Idle | PlannerStatus::Awake => {}
    }

    let sidecar = match app_handle.try_state::<Arc<SidecarManager>>() {
        Some(s) => s,
        None => {
            warn!("SidecarManager not managed; cannot dispatch planner wake");
            return;
        }
    };

    // Gather a mission snapshot for the wake-message builder. E1 ships
    // a minimal pass — just the trigger payload + a near-empty snapshot
    // — and E4/E5 enrich this with milestones, task statuses, etc.
    let mission_snapshot = serde_json::json!({
        "missionId": event.mission_id,
        "triggerPayload": event.payload,
    });
    let journal_tail = String::new(); // E7 populates the journal.

    let content = wake_user_message(&event.trigger, &journal_tail, &mission_snapshot);
    let trigger_kind = event.trigger.kind_str();

    // Inject FIRST, then flip status. The previous ordering left the
    // planner permanently `Awake` if the sidecar rejected the inject
    // (e.g. session already closed), because we'd write the status before
    // the inject and never roll back. Status flips to `Awake` only on
    // success here; on failure we keep the prior status (typically `Idle`)
    // so a subsequent wake doesn't think we're already mid-turn.
    //
    // Status flips back to `Idle` when the sidecar emits `done` (handled
    // by the planner status listener that lands with E2's tool dispatch —
    // for now it stays `Awake` until the next explicit status update). E6
    // owns the watchdog.
    if let Err(e) = sidecar
        .forward_inject_user_turn(
            &session.sidecar_session_id,
            &content,
            "wake_trigger",
            Some(trigger_kind),
        )
        .await
    {
        warn!(
            mission_id = %event.mission_id,
            error = %e,
            "failed to inject wake turn into planner sidecar"
        );
        return;
    }

    registry
        .set_status(&event.mission_id, PlannerStatus::Awake)
        .await;
    persist_planner_state_on_flight(
        &event.mission_id,
        Some(&session.sidecar_session_id),
        Some(PlannerStatus::Awake),
    );
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start the planner agent for `mission_id` rooted at `project_path`.
///
/// Returns the *planner session id* (which is currently the same as the
/// sidecar session id, but the frontend should treat it as opaque so we
/// can fan it through a stable id even if the sidecar session gets
/// re-established on crash).
///
/// Idempotent for `Idle` / `Awake` / `QuotaPaused` / `Paused` planners:
/// re-calling for an already-running mission returns the existing id
/// without spawning a second session (`Paused` callers are nudged toward
/// `resume_mission_planner` via a log hint). Terminal states (`Completed`
/// / `Failed`) return an error so the caller can choose to remove the
/// stale session and start a fresh one.
///
/// `provisional_session_id` lets the frontend choose the id up front so it
/// can install `api-agent:*` listeners BEFORE the sidecar is spawned and
/// any events fire. When `None`, the backend generates a UUID.
#[tauri::command]
pub async fn start_mission_planner(
    app_handle: AppHandle,
    mission_id: String,
    project_path: String,
    provisional_session_id: Option<String>,
) -> Result<String, String> {
    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;

    if let Some(existing) = registry.get_by_mission(&mission_id).await {
        match existing.status {
            PlannerStatus::Completed | PlannerStatus::Failed => {
                return Err(
                    "mission planner session has terminated; remove the existing session and start a new one".to_string(),
                );
            }
            PlannerStatus::Paused => {
                info!(
                    mission_id = %mission_id,
                    "start_mission_planner called for a paused planner; returning existing id (call resume_mission_planner to dispatch wakes again)"
                );
                return Ok(existing.id);
            }
            PlannerStatus::Idle
            | PlannerStatus::Awake
            | PlannerStatus::QuotaPaused => {
                return Ok(existing.id);
            }
        }
    }

    let sidecar = app_handle
        .try_state::<Arc<SidecarManager>>()
        .ok_or_else(|| "sidecar not yet ready; try again in a moment".to_string())?;

    let sidecar_session_id =
        provisional_session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let session_id = sidecar_session_id.clone();

    sidecar
        .forward_start(
            sidecar_session_id.clone(),
            PLANNER_PROVIDER.to_string(),
            PLANNER_MODEL.to_string(),
            spec_mode_system_prompt(),
            // allowedTools: only the E1 stub tool. Per the Claude Agent SDK,
            // an empty list means no tools are callable, which would make
            // the planner's `mcp__planner__noop` stub unreachable and block
            // the protocol-v5 in-process MCP round-trip smoke. E2 extends
            // this list with the 7 real planner tool names.
            vec!["mcp__planner__noop".to_string()],
            // mcpServers: null. The sidecar's `mcpKind: "planner"` flag
            // tells it to construct the planner tool surface locally; the
            // raw `mcpServers` channel still carries user-defined stdio
            // MCP servers separately, but the planner doesn't need any of
            // those (planner is a fresh session that only sees the planner
            // tools + journal context).
            serde_json::Value::Null,
            project_path.clone(),
            // initialMessage: empty — the planner waits for the user's
            // spec-mode opening message.
            String::new(),
            None, // apiKey — claude-oauth pulls from ~/.claude
            None, // resume token
            Some(false), // thinkingEnabled — E4 may flip this
            Some(false), // planMode
            serde_json::Value::Null, // attachments
            serde_json::Value::Null, // resumeMessages
            None, // permissionMode
            None, // approveWrites
            Some(PLANNER_MCP_KIND.to_string()),
        )
        .await
        .map_err(|e| format!("start planner sidecar session: {}", e))?;

    let session = MissionPlannerSession::new(session_id.clone(), mission_id.clone(), sidecar_session_id);
    registry.insert(session).await;
    persist_planner_state_on_flight(&mission_id, Some(&session_id), Some(PlannerStatus::Idle));

    info!(mission_id = %mission_id, planner_session = %session_id, "started mission planner");
    Ok(session_id)
}

/// Stop the planner agent for `mission_id`. Closes the underlying sidecar
/// session and clears the persisted planner state on the Flight.
#[tauri::command]
pub async fn stop_mission_planner(app_handle: AppHandle, mission_id: String) -> Result<(), String> {
    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let session = match registry.remove(&mission_id).await {
        Some(s) => s,
        None => return Ok(()), // nothing to stop is success
    };

    if let Some(sidecar) = app_handle.try_state::<Arc<SidecarManager>>() {
        // forward_close emits its own warnings; we tolerate failure here
        // because the session entry is already gone from the registry.
        if let Err(e) = sidecar.forward_close(session.sidecar_session_id.clone()).await {
            warn!(error = %e, "stop_mission_planner: forward_close failed");
        }
    }
    persist_planner_state_on_flight(&mission_id, None, None);
    info!(mission_id = %mission_id, "stopped mission planner");
    Ok(())
}

/// Mark the planner as Paused so the wake consumer drops further events
/// on the floor until [`resume_mission_planner`] flips it back.
///
/// Does NOT cancel an in-flight turn — that's the kill-switch (E6) which
/// will call `forward_cancel` separately.
#[tauri::command]
pub async fn pause_mission_planner(
    app_handle: AppHandle,
    mission_id: String,
) -> Result<(), String> {
    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    if registry.get_by_mission(&mission_id).await.is_none() {
        return Err(format!("no planner running for mission '{}'", mission_id));
    }
    registry.set_status(&mission_id, PlannerStatus::Paused).await;
    persist_planner_state_on_flight(&mission_id, None, Some(PlannerStatus::Paused));
    info!(mission_id = %mission_id, "paused mission planner");
    Ok(())
}

/// Inverse of [`pause_mission_planner`]. Flips status back to Idle so the
/// next wake event dispatches.
#[tauri::command]
pub async fn resume_mission_planner(
    app_handle: AppHandle,
    mission_id: String,
) -> Result<(), String> {
    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let session = registry
        .get_by_mission(&mission_id)
        .await
        .ok_or_else(|| format!("no planner running for mission '{}'", mission_id))?;
    registry.set_status(&mission_id, PlannerStatus::Idle).await;
    persist_planner_state_on_flight(
        &mission_id,
        Some(&session.sidecar_session_id),
        Some(PlannerStatus::Idle),
    );
    info!(mission_id = %mission_id, "resumed mission planner");
    Ok(())
}

/// Inject a turn into the planner session.
///
/// `source` is `"user"` for human-typed turns (the spec-mode chat input)
/// and `"wake_trigger"` for synthetic wakes — though the latter is normally
/// driven by [`spawn_wake_consumer`] reading off the wake bus rather than
/// the frontend calling this command directly. We expose both so the
/// frontend can fire one-off `user_message_in_journal` turns without going
/// through the orchestrator.
#[tauri::command]
pub async fn inject_planner_turn(
    app_handle: AppHandle,
    mission_id: String,
    content: String,
    source: String,
) -> Result<(), String> {
    if source != "user" && source != "wake_trigger" {
        return Err(format!(
            "invalid source '{}' for inject_planner_turn (expected 'user' or 'wake_trigger')",
            source
        ));
    }

    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let session = registry
        .get_by_mission(&mission_id)
        .await
        .ok_or_else(|| format!("no planner running for mission '{}'", mission_id))?;

    let sidecar = app_handle
        .try_state::<Arc<SidecarManager>>()
        .ok_or_else(|| "sidecar not yet ready".to_string())?;

    // For `source = "user"` we send the content verbatim — the planner
    // system prompt treats anything NOT inside <wake_trigger> as a real
    // human turn. For `source = "wake_trigger"` from the frontend, we
    // assume the caller already wrapped or wants the raw content (matches
    // the wake consumer's contract).
    let trigger_kind: Option<&str> = if source == "wake_trigger" {
        Some("user_message_in_journal")
    } else {
        None
    };

    sidecar
        .forward_inject_user_turn(
            &session.sidecar_session_id,
            &content,
            &source,
            trigger_kind,
        )
        .await?;

    registry.set_status(&mission_id, PlannerStatus::Awake).await;
    persist_planner_state_on_flight(
        &mission_id,
        Some(&session.sidecar_session_id),
        Some(PlannerStatus::Awake),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_trigger_kind_str_matches_locked_design() {
        assert_eq!(WakeTrigger::Decomposition.kind_str(), "decomposition");
        assert_eq!(
            WakeTrigger::TaskCompleted("t1".into()).kind_str(),
            "task_completed"
        );
        assert_eq!(WakeTrigger::TaskFailed("t1".into()).kind_str(), "task_failed");
        assert_eq!(
            WakeTrigger::ApprovalGateReached("t1".into()).kind_str(),
            "approval_gate_reached"
        );
        assert_eq!(
            WakeTrigger::CollisionDetected(vec!["a".into()]).kind_str(),
            "collision_detected"
        );
        assert_eq!(
            WakeTrigger::UserMessageInJournal("hi".into()).kind_str(),
            "user_message_in_journal"
        );
        assert_eq!(WakeTrigger::QuotaExhausted.kind_str(), "quota_exhausted");
    }

    #[test]
    fn planner_status_round_trips_through_flight_status() {
        for s in [
            PlannerStatus::Idle,
            PlannerStatus::Awake,
            PlannerStatus::Paused,
            PlannerStatus::QuotaPaused,
            PlannerStatus::Completed,
            PlannerStatus::Failed,
        ] {
            let flight_form = s.to_flight_status();
            // Sanity: every runtime status has a persisted mirror.
            match (s, flight_form) {
                (PlannerStatus::Idle, FlightPlannerStatus::Idle)
                | (PlannerStatus::Awake, FlightPlannerStatus::Awake)
                | (PlannerStatus::Paused, FlightPlannerStatus::Paused)
                | (PlannerStatus::QuotaPaused, FlightPlannerStatus::QuotaPaused)
                | (PlannerStatus::Completed, FlightPlannerStatus::Completed)
                | (PlannerStatus::Failed, FlightPlannerStatus::Failed) => {}
                _ => panic!("PlannerStatus → FlightPlannerStatus mismatch for {:?}", s),
            }
        }
    }
}
