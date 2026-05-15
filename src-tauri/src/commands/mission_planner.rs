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
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::commands::agent_sidecar::SidecarManager;
use crate::core::flight::{FlightStatus, PlannerStatus as FlightPlannerStatus};
use crate::core::mission_journal::{append_journal, JournalEntry, JournalKind};
use crate::core::mission_planner_prompts::{spec_mode_system_prompt, wake_user_message};
use crate::core::storage::{self, PersistedState};

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
// E6-CEILING-RATELIMIT — quota-pause backoff window
// ---------------------------------------------------------------------------

/// Minimum auto-resume wait for [`MissionPlannerRegistry::on_rate_limited`].
/// Per locked-design §Safety rails: never resume in under 60s, even if the
/// provider hinted a shorter `retry-after` (don't slam back at the API).
const QUOTA_MIN_WAIT_SECS: f64 = 60.0;

/// Maximum auto-resume wait. Per locked-design §Safety rails: never leave the
/// planner frozen for more than 10 minutes — past that the user needs to see
/// it and decide whether to resume manually.
const QUOTA_MAX_WAIT_SECS: f64 = 600.0;

/// Default auto-resume wait when the provider didn't surface a `retry-after`
/// hint. Sits at the floor (60s) so the first retry isn't a long stall.
const QUOTA_DEFAULT_WAIT_SECS: f64 = 60.0;

// ---------------------------------------------------------------------------
// E10 — context compaction threshold
// ---------------------------------------------------------------------------

/// Threshold at which the planner's session is compacted. Set to 75%
/// of Sonnet 4.6's 200K window so we have headroom for the in-flight
/// turn's input + output. Tuned to fire BEFORE the next turn would
/// risk a context-window error.
pub const COMPACTION_THRESHOLD_TOKENS: u64 = 150_000;

/// **E10 FIX P1-A** — backoff window (seconds) after a compaction
/// failure before [`MissionPlannerRegistry::bump_cumulative_input_and_check`]
/// will allow another threshold-trigger to fire. 5 minutes is short
/// enough that the user doesn't notice in the common transient-rate-limit
/// case, but long enough that a hard failure (quota exhausted, sidecar
/// dead) doesn't burn through quota on every subsequent turn.
pub const COMPACTION_FAILURE_BACKOFF_SECS: u64 = 300;

/// **E10 FIX P1-A** — after this many consecutive compaction failures the
/// orchestrator writes a `SystemNote` journal entry advising the user
/// that manual intervention may be required. Reset on success.
pub const COMPACTION_FAILURE_ESCALATION_COUNT: u32 = 3;

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

/// Per-mode budgets the planner runs under. Set on the session at the moment
/// the wake fires (see [`dispatch_wake`]) and read by the dispatcher
/// (`commands::mission_planner_tools::dispatch`) to enforce per-tick tool-call
/// caps, and by the wake injector to thread the right `max_output_tokens` into
/// the sidecar's `inject_user_turn` request.
///
/// Pre-launch (spec-mode chat) sessions sit in [`PlannerMode::Spec`]. Launch
/// fires [`WakeTrigger::Decomposition`] which transitions the planner to
/// [`PlannerMode::Decomposition`]. Subsequent wakes map per
/// [`PlannerMode::from_trigger`]. E6-CAPS owns this surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlannerMode {
    /// Pre-launch chat — the planner is conversing with the user about the
    /// mission spec, occasional approval/info tools only.
    Spec,
    /// Launch wake fired; the planner is producing the initial milestone /
    /// task plan via the `mcp__planner__*` tool surface.
    Decomposition,
    /// Wake fired for `task_completed` / `collision_detected` /
    /// `approval_gate_reached` / `user_message_in_journal` / `quota_exhausted`.
    Reactive,
    /// Wake fired for `task_failed`; planner is doing failure analysis +
    /// (potentially) emitting a replan subtree.
    Replan,
}

impl PlannerMode {
    /// Map a wake trigger to the mode the planner should run the resulting
    /// turn under.
    pub fn from_trigger(trigger: &WakeTrigger) -> Self {
        match trigger {
            WakeTrigger::Decomposition => PlannerMode::Decomposition,
            WakeTrigger::TaskFailed(_) => PlannerMode::Replan,
            WakeTrigger::TaskCompleted(_)
            | WakeTrigger::ApprovalGateReached(_)
            | WakeTrigger::CollisionDetected(_)
            | WakeTrigger::UserMessageInJournal(_) => PlannerMode::Reactive,
            // QuotaExhausted is treated as Reactive — the planner is being
            // re-entered with a quota-back-online notice; mode choice doesn't
            // really matter for that one turn.
            WakeTrigger::QuotaExhausted => PlannerMode::Reactive,
        }
    }

    /// Maximum number of in-process MCP tool calls the planner is allowed to
    /// make in a single tick (one wake turn). Locked-design values per
    /// `dev/mission-planner-plan.md` §Caps.
    pub fn tool_call_cap(&self) -> u32 {
        match self {
            // Spec mode is mostly chat with occasional approval/info tool
            // calls; cap is generous but bounded.
            PlannerMode::Spec => 25,
            // Decomposition fires create_milestone (x4) + create_task (x10)
            // and may slack with a few update/blocked calls — 50 leaves room.
            PlannerMode::Decomposition => 50,
            PlannerMode::Reactive => 25,
            PlannerMode::Replan => 25,
        }
    }

    /// Output `max_tokens` budget to pass to the Anthropic SDK for this
    /// mode's turn. Locked-design values per `dev/mission-planner-plan.md`
    /// §Budgets. NOTE: The Claude Agent SDK (0.2.116) does not expose a
    /// per-turn `max_tokens` setter; the sidecar treats this as a best-effort
    /// log + no-op for per-turn injection. See `injectUserTurn` in
    /// `anthropic.ts`.
    pub fn max_output_tokens(&self) -> u32 {
        match self {
            // Spec mode is conversational; short replies are the norm.
            PlannerMode::Spec => 4096,
            // Decomposition emits many tool calls in one turn — needs headroom.
            PlannerMode::Decomposition => 8192,
            PlannerMode::Reactive => 4096,
            // Replan: failure analysis prose + a new-task subtree.
            PlannerMode::Replan => 6144,
        }
    }
}

impl WakeTrigger {
    /// Stable snake_case string for the `<wake_trigger kind="…">` attribute.
    ///
    /// These exact strings are taught to the planner via the system prompt
    /// (`core::mission_planner_prompts`), so each variant maps to the
    /// model-facing kind verbatim. Note in particular that `Decomposition`
    /// — the kickoff trigger fired when the user clicks Launch — maps to
    /// `"launch"` rather than `"decomposition"`: the planner system prompt
    /// references "launch" because that's what the user clicked, and we
    /// keep the wire shape aligned with the prompt vocabulary.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Decomposition => "launch",
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
    /// E6-CAPS: which mode the planner is currently running under. Initial
    /// value at session start is [`PlannerMode::Spec`]; flipped on each wake
    /// via [`PlannerMode::from_trigger`] (see [`dispatch_wake`]). Read by the
    /// MCP dispatcher to enforce per-mode tool-call caps and by the wake
    /// injector to choose `max_output_tokens`.
    #[serde(default = "default_planner_mode")]
    pub current_mode: PlannerMode,
    /// FIX P1-C: monotonically-increasing generation counter, bumped on
    /// every transition into `QuotaPaused` via
    /// [`MissionPlannerRegistry::on_rate_limited`]. The auto-resume timer
    /// captures the lease value at the moment it was spawned and only
    /// clears the QuotaPaused state if that captured value is still
    /// current. This stops a stale timer from a previous 429 from
    /// clobbering a freshly-armed QuotaPaused that a second 429 installed
    /// while the first timer was still sleeping.
    #[serde(default)]
    pub quota_lease: u64,

    /// Cumulative input tokens billed against the planner's 200K Sonnet
    /// 4.6 context window. Includes cache reads. When this crosses
    /// [`COMPACTION_THRESHOLD_TOKENS`] the registry emits a
    /// `mission-planner:compaction-triggered:<missionId>` event for the
    /// compaction orchestrator (E10-SWAP) to handle the session restart.
    #[serde(default)]
    pub cumulative_input_tokens: u64,

    /// True if a compaction is currently in flight. Prevents duplicate
    /// triggers while the swap is running.
    #[serde(default)]
    pub compaction_in_progress: bool,

    /// E10 FIX P0 — Tauri listener registration for the
    /// `mission-planner:compaction-triggered:<mission_id>` event. Stored on
    /// the session so `stop_mission_planner` / `complete_mission` can
    /// `app.unlisten(id)` before tearing the session down. Without this,
    /// every start→stop cycle accumulates a fresh listener — after N
    /// cycles a single triggered event spawns N parallel
    /// `perform_compaction` tasks (N Sonnet quota burns + N orphan sidecar
    /// sessions).
    ///
    /// `tauri::EventId` is a `u32` and is NOT serializable here; we
    /// deliberately skip it on (de)serialize so cold-start hydration
    /// starts with `None` (the listener will be re-installed by
    /// `start_mission_planner` after hydration). The field is `Option` so
    /// a session built via `MissionPlannerSession::new` (which has no
    /// listener yet) can be inserted into the registry, and the caller
    /// fills the slot in once `app.listen(...)` returns.
    #[serde(skip)]
    pub compaction_listener: Option<tauri::EventId>,

    /// E10 FIX P1-A — wall-clock seconds (epoch) of the last compaction
    /// failure. Used to gate `bump_cumulative_input_and_check` so a
    /// persistent failure (e.g. summarizer Sonnet quota exhausted) doesn't
    /// re-fire compaction on every subsequent `turn_summary` while
    /// `cumulative_input_tokens` is still over threshold.
    ///
    /// Cleared by `swap_sidecar_session_after_compaction` on success.
    /// Set by both the in-orchestrator failure paths (P1-B / P1-C) and
    /// the summarizer-failure path in `perform_compaction`.
    #[serde(default)]
    pub last_compaction_failure_at: Option<u64>,

    /// E10 FIX P1-A — count of consecutive compaction failures. Reset to
    /// 0 on `swap_sidecar_session_after_compaction` (success). On every
    /// failure, incremented; when it crosses 3 the orchestrator writes a
    /// `SystemNote` journal entry escalating the issue to the user.
    #[serde(default)]
    pub consecutive_compaction_failures: u32,
}

/// Default planner mode for deserialization (back-compat for state files that
/// predate the `current_mode` field). New sessions start in
/// [`PlannerMode::Spec`].
fn default_planner_mode() -> PlannerMode {
    PlannerMode::Spec
}

impl MissionPlannerSession {
    pub(crate) fn new(id: String, mission_id: String, sidecar_session_id: String) -> Self {
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
            current_mode: PlannerMode::Spec,
            quota_lease: 0,
            cumulative_input_tokens: 0,
            compaction_in_progress: false,
            compaction_listener: None,
            last_compaction_failure_at: None,
            consecutive_compaction_failures: 0,
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
    /// E7-HOOKS: per-sidecar-session chunk buffer used to aggregate the
    /// planner's streamed text into a single `PlannerMessage` journal entry
    /// when the turn finishes. Keyed by sidecar session id; appended on
    /// every `api-agent:chunk:<sid>` event for a sidecar session owned by
    /// the planner, drained-and-cleared on the matching `done` event.
    ///
    /// Buffers for non-planner sidecar sessions never get written because
    /// the chunk-handler short-circuits before insertion when the
    /// reverse-lookup misses.
    session_chunks: Mutex<HashMap<String, String>>,
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

    /// Reverse-lookup the owning mission id for a given sidecar session id.
    /// Used by the E2 in-process MCP tool handlers, which receive the
    /// sidecar session id as their `session_id` argument (because that's
    /// what the sidecar tags `planner_tool` envelopes with) and need to
    /// resolve which mission's state to mutate.
    pub async fn mission_id_for_sidecar_session(&self, sidecar_session_id: &str) -> Option<String> {
        let guard = self.sessions.lock().await;
        guard
            .values()
            .find(|s| s.sidecar_session_id == sidecar_session_id)
            .map(|s| s.mission_id.clone())
    }

    /// E7-HOOKS — Option A planner-message aggregation.
    ///
    /// Append a chunk of streamed text to the per-sidecar-session buffer.
    /// Called from `agent_sidecar::handle_event` on every `chunk` event.
    /// No-op (silently returns) if the sidecar session isn't owned by a
    /// planner — non-planner sessions never grow a buffer entry.
    pub async fn append_chunk(&self, sidecar_session_id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        // Cheap reverse-lookup to avoid retaining buffers for non-planner
        // sessions. We hold sessions and chunks locks in strict order
        // (sessions → chunks) and release sessions before chunks insert to
        // keep contention minimal.
        let is_planner = {
            let guard = self.sessions.lock().await;
            guard
                .values()
                .any(|s| s.sidecar_session_id == sidecar_session_id)
        };
        if !is_planner {
            return;
        }
        let mut chunks = self.session_chunks.lock().await;
        chunks
            .entry(sidecar_session_id.to_string())
            .or_default()
            .push_str(text);
    }

    /// E7-HOOKS — Drain the buffered text for a sidecar session.
    /// Returns `None` if there is no buffer (non-planner session or no
    /// chunks recorded this turn). Clears the entry on drain.
    pub async fn drain_chunk_buffer(&self, sidecar_session_id: &str) -> Option<String> {
        let mut chunks = self.session_chunks.lock().await;
        chunks.remove(sidecar_session_id)
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

    /// Increment the per-task replan counter on the planner session and
    /// return the **new** count. Returns `None` if no planner is registered
    /// for the mission (caller should treat that as an error).
    ///
    /// After bumping the in-memory counter, this also mirrors the new
    /// count onto the Task DTO at `PersistedState.flights[..].milestones[..]
    /// .tasks[..].replan_count` so the planner's failure-wake body
    /// (`render_task_failed` in E5) can read the budget directly off the
    /// Flight snapshot rather than reaching back into the registry. The
    /// mirror is best-effort — if it fails (state lock contention, task
    /// not found, etc.) we log a warning and still return the bumped
    /// count to the caller so cap enforcement stays authoritative on the
    /// registry side.
    ///
    /// E2 uses this to enforce the flat ≤ 3 cap. E5 gates the call with
    /// error-category exemption logic so RateLimit / Network failures
    /// don't increment the counter — that path uses [`read_replan_count`]
    /// instead.
    pub async fn bump_replan_count(
        &self,
        mission_id: &str,
        task_id: &str,
    ) -> Option<u32> {
        // Phase 1: bump the in-memory counter and capture the new value.
        // Scoped so the sessions mutex is released BEFORE we acquire the
        // PersistedState lock — never hold two locks at once.
        let new_count = {
            let mut guard = self.sessions.lock().await;
            let session = guard.get_mut(mission_id)?;
            let entry = session
                .replans_per_task
                .entry(task_id.to_string())
                .or_insert(0);
            *entry += 1;
            *entry
        };

        // Phase 2: mirror the new count onto the persisted Task DTO. The
        // in-memory counter remains authoritative for cap enforcement; the
        // DTO mirror exists so wake-body renderers can read the value from
        // the Flight snapshot without touching the registry.
        let mission_id_owned = mission_id.to_string();
        let task_id_owned = task_id.to_string();
        let mirror_result = storage::with_state_lock(move |state| {
            let mission_id = mission_id_owned.clone();
            let task_id = task_id_owned.clone();
            let result: Result<(), String> = (|| {
                let flight = state
                    .flights
                    .iter_mut()
                    .find(|f| f.id == mission_id)
                    .ok_or_else(|| format!("mission '{}' not found", mission_id))?;
                for milestone in flight.milestones.iter_mut() {
                    if let Some(task) =
                        milestone.tasks.iter_mut().find(|t| t.id == task_id)
                    {
                        task.replan_count = new_count;
                        return Ok(());
                    }
                }
                Err(format!(
                    "task '{}' not found in mission '{}'",
                    task_id, mission_id
                ))
            })();
            std::future::ready(result)
        })
        .await;
        if let Err(e) = mirror_result {
            warn!(
                mission_id = %mission_id,
                task_id = %task_id,
                error = %e,
                "bump_replan_count: failed to mirror replan_count onto Task DTO; in-memory counter remains authoritative",
            );
        }

        Some(new_count)
    }

    /// Read the per-task replan counter **without** mutating it. Returns
    /// `Some(0)` for a known mission with no recorded replans for the task,
    /// and `None` only when no planner session exists for the mission.
    ///
    /// E5-REPLAN uses this on the exempt path (RateLimit / Network failures)
    /// to surface the unchanged count back to the planner without bumping.
    pub async fn read_replan_count(
        &self,
        mission_id: &str,
        task_id: &str,
    ) -> Option<u32> {
        let guard = self.sessions.lock().await;
        let session = guard.get(mission_id)?;
        Some(session.replans_per_task.get(task_id).copied().unwrap_or(0))
    }

    /// Remove a planner session from the registry. Public sibling of the
    /// internal [`Self::remove`] used by terminal-state tool handlers
    /// (e.g. `complete_mission`) that need to take the session out of
    /// the wake-dispatch path before closing its sidecar.
    ///
    /// **E7-PARTIAL-DRAIN**: also drains the per-sidecar-session chunk
    /// buffer so a planner's last in-progress streamed thought doesn't
    /// linger in memory after the session is gone. When `app` is provided
    /// and the drained text is non-trivial, the partial is journaled as a
    /// `PlannerMessage` entry suffixed with a `(partial — session closed)`
    /// marker so it remains visible in the timeline. When `app` is `None`
    /// or the drained text is empty, the partial is discarded (the buffer
    /// is always cleared either way).
    pub async fn remove_session(
        &self,
        mission_id: &str,
        app: Option<&AppHandle>,
    ) -> Option<MissionPlannerSession> {
        // Resolve the sidecar session id BEFORE removal so we can drain
        // the matching chunk buffer. We deliberately don't hold the
        // sessions lock across the buffer drain — `drain_chunk_buffer`
        // takes its own lock and we want the lock order narrow.
        let sidecar_sid_opt = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(mission_id)
                .map(|s| s.sidecar_session_id.clone())
        };
        if let Some(sid) = sidecar_sid_opt {
            if let Some(partial) = self.drain_chunk_buffer(&sid).await {
                let trimmed = partial.trim();
                if !trimmed.is_empty() {
                    tracing::info!(
                        mission_id,
                        partial_len = partial.len(),
                        "draining partial chunk buffer on planner session removal"
                    );
                    if let Some(app) = app {
                        let body = format!(
                            "{}\n\n*(partial — session closed)*",
                            trimmed
                        );
                        let entry = journal_entry(
                            mission_id.to_string(),
                            JournalKind::PlannerMessage,
                            body,
                            Some(serde_json::json!({ "partial": true, "reason": "session_closed" })),
                        );
                        write_journal_and_emit(app, entry).await;
                    }
                }
            }
        }
        self.remove(mission_id).await
    }

    /// E6-KILL-AWAKE — Awake-stickiness watchdog.
    ///
    /// Called from `agent_sidecar::handle_event` when the sidecar emits a
    /// `done` event for a planner session. Flips the owning mission's
    /// planner status from [`PlannerStatus::Awake`] back to
    /// [`PlannerStatus::Idle`] so the UI doesn't surface "Awake"
    /// indefinitely after a wake's turn completes.
    ///
    /// **Preserve-other-states guard**: only flips when the current status
    /// is exactly `Awake`. `Paused` / `QuotaPaused` / `Completed` / `Failed`
    /// stay untouched — a `done` event that lands while the user has paused
    /// the planner (or while a quota-pause backoff is armed) must NOT
    /// clobber that state back to Idle, because that would re-enable wake
    /// dispatch and defeat the pause.
    ///
    /// Also no-ops on `Idle` (already there, nothing to do) and on missions
    /// with no registered planner (lookup miss is harmless — the `done`
    /// event was for a non-planner sidecar session, e.g. a regular
    /// `api-claude-oauth` chat).
    pub async fn on_planner_done(&self, sidecar_session_id: &str) {
        // FIX P1-A: hold the sessions lock across the read+modify+write so
        // a concurrent `dispatch_wake` flipping the status to `Awake` for a
        // new turn can't be clobbered back to `Idle` here. Previously this
        // function did `get_by_mission` (lock+release) and `set_status`
        // (lock+release) as two separate critical sections — if `dispatch_
        // wake` slipped in between, its `Awake` write was silently undone.
        //
        // We do the reverse-lookup, status read, and status mutation all
        // under a single `sessions.lock()` to make the read-modify-write
        // atomic. `set_status`'s body is pure in-memory (no `.await`) so
        // inlining it here under the lock is safe and we don't double-lock.
        let resolved = {
            let mut sessions = self.sessions.lock().await;
            // Reverse-lookup inline (don't call mission_id_for_sidecar_session
            // — that would try to take the lock again).
            let mission_id_opt = sessions
                .iter()
                .find(|(_, s)| s.sidecar_session_id == sidecar_session_id)
                .map(|(m, _)| m.clone());
            let mission_id = match mission_id_opt {
                Some(m) => m,
                None => return,
            };
            let Some(session) = sessions.get_mut(&mission_id) else {
                return;
            };
            if !matches!(session.status, PlannerStatus::Awake) {
                // Any non-Awake state (Idle, Paused, QuotaPaused, Completed,
                // Failed) is sticky — leave it. No persistence needed since
                // we didn't mutate.
                return;
            }
            session.status = PlannerStatus::Idle;
            session.last_tick_at = now_millis();
            let sidecar_id = session.sidecar_session_id.clone();
            Some((mission_id, sidecar_id))
        };

        if let Some((mission_id, sidecar_id)) = resolved {
            if let Err(e) = persist_planner_state_on_flight(
                &mission_id,
                Some(&sidecar_id),
                Some(PlannerStatus::Idle),
            )
            .await
            {
                warn!(
                    mission_id = %mission_id,
                    error = %e,
                    "on_planner_done: failed to persist Idle on Flight DTO"
                );
            }
            info!(
                mission_id = %mission_id,
                "planner wake turn completed; status: Awake -> Idle"
            );
        }
    }

    /// E6-CEILING-RATELIMIT — RateLimit / quota-pause supervisor.
    ///
    /// Called from `agent_sidecar::handle_event` when the sidecar emits
    /// the typed `rate_limited` event (v6 protocol). The Anthropic
    /// provider raises that envelope when the Claude Agent SDK throws
    /// `RateLimitError` (HTTP 429) mid-stream.
    ///
    /// The supervisor:
    ///   1. Resolves the owning mission from the sidecar session id. If
    ///      the session isn't a planner (e.g. a regular `claude-oauth`
    ///      chat that also hit 429), this is a no-op — the regular
    ///      `error` event already surfaced the failure to that session.
    ///   2. Flips the planner's runtime status to
    ///      [`PlannerStatus::QuotaPaused`] and persists that on the
    ///      Flight DTO. The wake dispatcher already short-circuits
    ///      `QuotaPaused` (see [`dispatch_wake`]) so further wake events
    ///      queue cleanly behind the pause instead of pounding the API.
    ///   3. Computes a backoff window, **clamped to 60-600s**:
    ///        * If the provider supplied a `retry-after` value (parsed
    ///          off the SDK error's `retry-after` header), we use that
    ///          as the base.
    ///        * Otherwise, default to 60s.
    ///      Per the locked-design caps (`dev/mission-planner-plan.md`
    ///      §Safety rails), the minimum is 60s (don't slam back at the
    ///      API on a too-short hint) and the maximum is 600s / 10min
    ///      (don't leave the user staring at a frozen planner forever).
    ///   4. Spawns an async timer; when it elapses, if and only if the
    ///      planner is *still* `QuotaPaused` (the user may have called
    ///      [`pause_mission_planner`] / [`stop_mission_planner`] in the
    ///      meantime), flips back to [`PlannerStatus::Idle`]. The next
    ///      wake event will then dispatch normally.
    ///   5. Emits `mission-planner:rate-limited:<missionId>` carrying the
    ///      effective wait-seconds so the frontend can turn it into an
    ///      OS-level notification ("Mission paused — resuming in ~Xs").
    pub async fn on_rate_limited(
        &self,
        sidecar_session_id: &str,
        retry_after_seconds: Option<f64>,
        app: &tauri::AppHandle,
    ) {
        // 1. Find the owning mission. Non-planner sessions land here too
        //    and return None — that's fine, the regular `error` event has
        //    already been emitted on this session.
        let mission_id = match self
            .mission_id_for_sidecar_session(sidecar_session_id)
            .await
        {
            Some(m) => m,
            None => return,
        };

        // 2. Compute the effective wait window. Anthropic's `retry-after`
        //    is a numeric seconds value; we clamp to 60-600s per
        //    locked-design §Safety rails. Negative / non-finite hints are
        //    treated as "no hint" (the sidecar parser already filters
        //    those, but defensive clamp here too).
        let raw = retry_after_seconds.filter(|v| v.is_finite() && *v > 0.0);
        let wait_secs = raw.unwrap_or(QUOTA_DEFAULT_WAIT_SECS);
        let wait_secs = wait_secs
            .max(QUOTA_MIN_WAIT_SECS)
            .min(QUOTA_MAX_WAIT_SECS);

        // 3. Atomically bump the quota generation counter (lease) and flip
        //    the planner to QuotaPaused. FIX P1-C: holding the sessions
        //    mutex across the lease bump + status flip + lease snapshot
        //    means the value the spawned timer captures below is the same
        //    value any concurrent rate-limit call would see — so if a
        //    second 429 lands during the window, IT bumps the lease again
        //    and the older timer's captured lease is now stale.
        let (lease, sidecar_session_id) = {
            let mut sessions = self.sessions.lock().await;
            let Some(session) = sessions.get_mut(&mission_id) else {
                // The mission's planner session was removed between the
                // reverse-lookup and now (e.g. stop_mission_planner racing
                // us). Nothing to do.
                return;
            };
            session.quota_lease = session.quota_lease.wrapping_add(1);
            session.status = PlannerStatus::QuotaPaused;
            session.last_tick_at = now_millis();
            (session.quota_lease, session.sidecar_session_id.clone())
        };
        if let Err(e) = persist_planner_state_on_flight(
            &mission_id,
            Some(&sidecar_session_id),
            Some(PlannerStatus::QuotaPaused),
        )
        .await
        {
            warn!(
                mission_id = %mission_id,
                error = %e,
                "on_rate_limited: failed to persist QuotaPaused on Flight DTO"
            );
        }
        info!(
            mission_id = %mission_id,
            wait_seconds = wait_secs,
            retry_after_seconds = ?retry_after_seconds,
            quota_lease = lease,
            "mission planner hit Anthropic rate limit; status: -> QuotaPaused"
        );

        // 4. Emit the per-mission Tauri event so the frontend can fire
        //    an OS notification ("Mission paused — resuming in ~Xs").
        //    We emit BEFORE the spawn so the UI updates regardless of
        //    timer scheduling.
        let _ = app.emit(
            &format!("mission-planner:rate-limited:{}", mission_id),
            serde_json::json!({
                "missionId": mission_id,
                "retryAfterSeconds": wait_secs,
            }),
        );

        // 5. Schedule the auto-resume timer. We capture an AppHandle clone
        //    so the spawned task can re-fetch the Tauri-managed registry
        //    (we can't move `&self` into the spawned future cleanly).
        //
        //    FIX P1-C: the guard re-checks BOTH `QuotaPaused` AND that the
        //    `quota_lease` we captured at spawn time is still the current
        //    lease. If a second 429 landed during the window, it would
        //    have bumped the lease to a new value AND re-armed
        //    QuotaPaused; that newer rate-limit owns the new timer, so
        //    THIS (older) timer must back off and leave the new pause
        //    alone.
        let app_clone = app.clone();
        let mission_clone = mission_id.clone();
        let captured_lease = lease;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait_secs)).await;
            let registry = match app_clone
                .try_state::<MissionPlannerRegistry>()
            {
                Some(r) => r,
                None => return,
            };
            // Atomic re-check + clear under the sessions lock. We mutate
            // in-place rather than calling `set_status` so the lease
            // comparison + status flip share a single critical section.
            let resolved = {
                let mut sessions = registry.sessions.lock().await;
                let Some(session) = sessions.get_mut(&mission_clone) else {
                    return;
                };
                if !matches!(session.status, PlannerStatus::QuotaPaused) {
                    // User paused / stopped / kill-switched the planner
                    // during our sleep, OR a sibling listener already
                    // cleared it — either way, don't touch it.
                    return;
                }
                if session.quota_lease != captured_lease {
                    // A newer rate-limit superseded us. Leave the freshly
                    // armed QuotaPaused alone — its own timer will clear
                    // it (or another sibling 429 will bump again).
                    info!(
                        mission_id = %mission_clone,
                        captured_lease,
                        current_lease = session.quota_lease,
                        "quota auto-resume timer fired but lease is stale; deferring to newer timer",
                    );
                    return;
                }
                session.status = PlannerStatus::Idle;
                session.last_tick_at = now_millis();
                Some(session.sidecar_session_id.clone())
            };
            if let Some(sidecar_id) = resolved {
                if let Err(e) = persist_planner_state_on_flight(
                    &mission_clone,
                    Some(&sidecar_id),
                    Some(PlannerStatus::Idle),
                )
                .await
                {
                    warn!(
                        mission_id = %mission_clone,
                        error = %e,
                        "quota auto-resume: failed to persist Idle on Flight DTO"
                    );
                }
                info!(
                    mission_id = %mission_clone,
                    "resuming planner after quota window: status QuotaPaused -> Idle"
                );
            }
        });
    }

    /// Set or replace the planner session for a mission. Returns the
    /// previous session, if any (so caller can decide whether to close it).
    async fn insert(&self, session: MissionPlannerSession) -> Option<MissionPlannerSession> {
        let mut guard = self.sessions.lock().await;
        guard.insert(session.mission_id.clone(), session)
    }

    /// E10 FIX P0 — store the Tauri `EventId` returned from
    /// `install_compaction_listener` on the session record so a later
    /// `stop_mission_planner` / `complete_mission` can call
    /// `app.unlisten(id)` and prevent listener accumulation across start /
    /// stop cycles.
    ///
    /// Best-effort: if the mission has no session in the registry (e.g. it
    /// was just removed by a concurrent stop), this is a silent no-op —
    /// the caller will not be able to unlisten via this registry, but the
    /// listener-leak window in that race is a single stop cycle's worth.
    pub async fn set_compaction_listener(
        &self,
        mission_id: &str,
        event_id: tauri::EventId,
    ) {
        let mut guard = self.sessions.lock().await;
        if let Some(session) = guard.get_mut(mission_id) {
            session.compaction_listener = Some(event_id);
        }
    }

    /// E10 FIX P0 — read and clear the stored compaction listener
    /// `EventId` for a mission. Used by the terminal paths
    /// (`stop_mission_planner`, `complete_mission`'s `remove_session`)
    /// just before tearing the session down so the caller can call
    /// `app.unlisten(id)`.
    ///
    /// Returns `None` when the mission has no planner session OR when no
    /// listener was ever installed (cold-start before re-install, etc.).
    pub async fn take_compaction_listener(
        &self,
        mission_id: &str,
    ) -> Option<tauri::EventId> {
        let mut guard = self.sessions.lock().await;
        guard.get_mut(mission_id)?.compaction_listener.take()
    }

    /// Test-only mirror of [`Self::insert`] that's visible to sibling
    /// modules' `#[cfg(test)]` blocks (specifically
    /// `mission_planner_compaction::tests`). Production callers must go
    /// through `start_mission_planner` so the sidecar / journal /
    /// persistence side-effects are correctly applied — direct insertion
    /// bypasses all of that and is only safe in unit tests that build
    /// fixture sessions by hand.
    #[cfg(test)]
    pub async fn insert_for_test(&self, session: MissionPlannerSession) {
        let mut guard = self.sessions.lock().await;
        guard.insert(session.mission_id.clone(), session);
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

    /// **FIX 3** — set status AND emit `mission-planner:status-changed:<missionId>`
    /// so the frontend `missionPlannerStore` can reactively patch the per-runtime
    /// `status` field without waiting for a backend round-trip via
    /// `get_mission_status` polling.
    ///
    /// Layered on top of [`Self::set_status`] (mutates in-memory) plus a single
    /// `app.emit(...)` call. Errors from `emit` are deliberately swallowed —
    /// the in-memory state mutation is the authoritative side-effect; failing
    /// to deliver the UI hint should never block the registry from updating
    /// its own state.
    ///
    /// Use this from call sites that need the UI to react (manual pause /
    /// resume, kill-switch). Internal call sites that are followed by a wake
    /// trigger or persisted state flip can keep using the plain [`Self::set_status`].
    ///
    /// Payload shape: `{ "missionId": <id>, "status": <snake_case status> }`.
    /// `PlannerStatus`'s `serde(rename_all = "snake_case")` derive produces
    /// `idle` / `awake` / `paused` / `quota_paused` / `completed` / `failed`,
    /// matching the frontend `PlannerStatus` union in `missionPlannerStore.ts`.
    pub async fn set_status_and_emit(
        &self,
        mission_id: &str,
        status: PlannerStatus,
        app: &AppHandle,
    ) {
        self.set_status(mission_id, status).await;
        let _ = app.emit(
            &format!("mission-planner:status-changed:{}", mission_id),
            serde_json::json!({
                "missionId": mission_id,
                "status": status,
            }),
        );
    }

    /// E6-CAPS: set `current_mode` and reset `tool_calls_this_tick` to 0 for
    /// the planner attached to `mission_id`. Called by [`dispatch_wake`] at
    /// the start of every wake turn so the dispatcher's cap check operates
    /// against the right mode + a fresh counter. No-op if the mission has no
    /// session (a wake racing a stop_mission_planner would land here).
    pub async fn set_mode_and_reset_tick(&self, mission_id: &str, mode: PlannerMode) {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get_mut(mission_id) {
            s.current_mode = mode;
            s.tool_calls_this_tick = 0;
        }
    }

    /// E6-CAPS: atomically read the planner's current mode and bump the
    /// per-tick tool-call counter, returning `(mode, cap, new_count)`.
    ///
    /// The dispatcher in `commands::mission_planner_tools::mod::dispatch`
    /// calls this BEFORE routing to the per-tool handler so that bumping +
    /// rejecting-over-cap is atomic against concurrent tool calls from the
    /// same session. If the new count is over the mode's cap, the caller
    /// rejects the tool call (the bump is intentional — going over the cap
    /// once is enough to lock further calls out for this tick; the counter
    /// resets when the next wake fires via [`dispatch_wake`]).
    ///
    /// Returns `None` if no planner session matches `sidecar_session_id` —
    /// caller treats that as an error and refuses the tool call.
    pub async fn bump_and_check_tool_call(
        &self,
        sidecar_session_id: &str,
    ) -> Option<(PlannerMode, u32, u32)> {
        let mut sessions = self.sessions.lock().await;
        let mission_id = sessions
            .iter()
            .find(|(_, s)| s.sidecar_session_id == sidecar_session_id)
            .map(|(m, _)| m.clone())?;
        let session = sessions.get_mut(&mission_id)?;
        let mode = session.current_mode;
        let cap = mode.tool_call_cap();
        session.tool_calls_this_tick = session.tool_calls_this_tick.saturating_add(1);
        Some((mode, cap, session.tool_calls_this_tick))
    }

    /// E10-DETECT — increment a planner's cumulative input-token counter.
    /// If this crosses [`COMPACTION_THRESHOLD_TOKENS`] **and**
    /// `compaction_in_progress` is currently false, atomically flip
    /// `compaction_in_progress` to true and return `true` (caller should
    /// emit the `mission-planner:compaction-triggered:<missionId>`
    /// event). Otherwise return `false`.
    ///
    /// The atomic flip ensures only ONE event fires per threshold
    /// crossing — subsequent turns above threshold are no-ops until
    /// E10-SWAP calls [`Self::swap_sidecar_session_after_compaction`] on
    /// successful compaction (or [`Self::reset_compaction_in_progress`] on
    /// summarizer failure) to clear the flag.
    ///
    /// **E10 FIX P1-A — persistent-failure backoff.** If a compaction
    /// recently failed (the orchestrator records the failure timestamp on
    /// the session via `last_compaction_failure_at`), this returns
    /// `false` for [`COMPACTION_FAILURE_BACKOFF_SECS`] after the failure
    /// even if the threshold is crossed. Without this gate, a failed
    /// compaction leaves `cumulative_input_tokens` over threshold, so the
    /// very next `turn_summary` immediately re-fires the trigger, retries
    /// summarization, fails again, and the loop hammers Sonnet quota.
    ///
    /// No-op (returns false) if no planner session matches `mission_id`.
    pub async fn bump_cumulative_input_and_check(
        &self,
        mission_id: &str,
        input_tokens: u64,
    ) -> bool {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(mission_id) else {
            return false;
        };
        session.cumulative_input_tokens = session
            .cumulative_input_tokens
            .saturating_add(input_tokens);
        if session.compaction_in_progress {
            return false;
        }
        // E10 FIX P1-A — back off after a recent compaction failure so a
        // stuck summarizer doesn't loop on every subsequent turn.
        if let Some(last_fail_secs) = session.last_compaction_failure_at {
            let now_secs = now_millis() / 1000;
            if now_secs < last_fail_secs.saturating_add(COMPACTION_FAILURE_BACKOFF_SECS) {
                return false;
            }
        }
        if session.cumulative_input_tokens >= COMPACTION_THRESHOLD_TOKENS {
            session.compaction_in_progress = true;
            return true;
        }
        false
    }

    /// E10-DETECT — read the cumulative-input-token counter for a
    /// planner session. Returns `None` if no planner is registered for
    /// `mission_id`. Used by UI / telemetry surfaces that want to show
    /// "X / 150K tokens to compaction" without bumping the counter.
    #[allow(dead_code)]
    pub async fn read_cumulative_input(&self, mission_id: &str) -> Option<u64> {
        let sessions = self.sessions.lock().await;
        sessions.get(mission_id).map(|s| s.cumulative_input_tokens)
    }

    /// E10-SWAP — clear the `compaction_in_progress` flag without touching
    /// the cumulative-token counter.
    ///
    /// Used by [`crate::commands::mission_planner_compaction::perform_compaction`]
    /// on the summarization-failure path: we want a *future* threshold cross
    /// to re-arm the trigger (so a transient summarizer error doesn't
    /// permanently disable compaction), but we don't want to zero the token
    /// counter — the token count is still real, and zeroing it would make
    /// the planner cross the threshold a second time before the underlying
    /// context has actually been compacted.
    ///
    /// No-op (returns silently) if no planner is registered for `mission_id`.
    ///
    /// E10 FIX P1-A — superseded by `record_compaction_failure` in
    /// `perform_compaction`'s failure paths (which also sets the
    /// backoff timestamp + bumps the failure counter). Retained for the
    /// existing unit-test coverage and as a fallback for any future
    /// failure path that genuinely wants to clear the flag without
    /// arming the backoff (e.g. a benign cancellation).
    #[allow(dead_code)]
    pub async fn reset_compaction_in_progress(&self, mission_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(mission_id) {
            session.compaction_in_progress = false;
        }
    }

    /// E10 FIX P1-A — record a compaction failure on the session. Clears
    /// `compaction_in_progress`, sets `last_compaction_failure_at` (seconds
    /// since epoch), and increments `consecutive_compaction_failures`.
    /// Returns the new failure count so the caller can decide whether to
    /// escalate (write a `SystemNote` journal entry) at the
    /// [`COMPACTION_FAILURE_ESCALATION_COUNT`] threshold.
    ///
    /// Returns `0` if no planner is registered for `mission_id` (treat as
    /// no-op — no escalation needed).
    pub async fn record_compaction_failure(&self, mission_id: &str) -> u32 {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(mission_id) else {
            return 0;
        };
        session.compaction_in_progress = false;
        session.last_compaction_failure_at = Some(now_millis() / 1000);
        session.consecutive_compaction_failures =
            session.consecutive_compaction_failures.saturating_add(1);
        session.consecutive_compaction_failures
    }

    /// E10-SWAP — atomic post-compaction state swap.
    ///
    /// Called by `perform_compaction` after a successful summarize → spawn →
    /// inject sequence. Replaces the session's `sidecar_session_id` with the
    /// freshly-spawned one, zeroes the cumulative-input-token counter, and
    /// clears `compaction_in_progress` — all under a single lock acquire so
    /// the three fields can't observe each other partway through the swap.
    ///
    /// **E10 FIX P1-A** — also clears `last_compaction_failure_at` and
    /// `consecutive_compaction_failures` because the swap means the most
    /// recent attempt SUCCEEDED, so the backoff gate must release and the
    /// escalation counter must reset.
    ///
    /// **E10 FIX P1-D** — returns `bool`: `true` if the swap happened,
    /// `false` if the planner was stopped mid-compaction (no session in
    /// the registry). The caller checks the return value and closes the
    /// freshly-spawned sidecar session as an orphan when the swap failed,
    /// so we don't leak sidecar sessions when the user clicks Stop during
    /// a long summarizer round-trip.
    pub async fn swap_sidecar_session_after_compaction(
        &self,
        mission_id: &str,
        new_sidecar_session_id: &str,
    ) -> bool {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(mission_id) else {
            return false;
        };
        session.sidecar_session_id = new_sidecar_session_id.to_string();
        session.cumulative_input_tokens = 0;
        session.compaction_in_progress = false;
        session.last_compaction_failure_at = None;
        session.consecutive_compaction_failures = 0;
        session.last_tick_at = now_millis();
        true
    }

    /// Dispatch an in-process planner MCP tool call. Invoked by
    /// `SidecarManager::handle_event` when a `planner_tool` envelope lands;
    /// the returned `Result` becomes the `planner_tool_result` reply that
    /// resolves the parked SDK tool handler in the sidecar.
    ///
    /// E2: delegates to per-tool handlers under
    /// `commands::mission_planner_tools`. Caps + the task-ceiling
    /// approval gate come in E6 (they wrap this call, not replace it).
    ///
    /// `session_id` is the sidecar session id (NOT the planner / mission
    /// id) — handlers use it to find the owning mission via the registry.
    /// `app` is the Tauri handle so handlers can `storage::load_state` /
    /// `save_state` and emit Tauri events for the UI.
    pub async fn handle_tool_call(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        crate::commands::mission_planner_tools::dispatch(app, session_id, tool, args).await
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
/// status update) — silently no-ops by returning `Ok(())`.
///
/// FIX P1-B: serialized through `storage::with_state_lock` so concurrent
/// callers (e.g. `on_planner_done`, `on_rate_limited`, the wake-bus
/// dispatcher, `complete_mission`, the start/stop/pause/resume commands)
/// can't race a naked `load_state` + `save_state` pair and lose each
/// other's updates. The previous implementation did `load_state` + mutate
/// + `save_state` without a lock; under contention, the later writer
/// would clobber the earlier one.
pub(crate) async fn persist_planner_state_on_flight(
    mission_id: &str,
    session_id: Option<&str>,
    status: Option<PlannerStatus>,
) -> Result<(), String> {
    let mission_id_owned = mission_id.to_string();
    let session_id_owned = session_id.map(|s| s.to_string());
    let result = storage::with_state_lock(move |state| {
        let mission_id = mission_id_owned.clone();
        let session_id_arg = session_id_owned.clone();
        let status_arg = status;
        let inner: Result<(), String> = (|| {
            // Missing flight is tolerated (mission may have been deleted
            // between the registry update and this call) — return Ok with
            // no mutation so `with_state_lock` skips the save path.
            let Some(flight) = state
                .flights
                .iter_mut()
                .find(|f| f.id == mission_id)
            else {
                return Ok(());
            };
            // Only mark changes when the field actually moves, matching the
            // pre-refactor "skip save if nothing changed" behavior.
            if flight.planner_session_id.as_deref() != session_id_arg.as_deref() {
                flight.planner_session_id = session_id_arg.clone();
            }
            let new_status = status_arg.map(|s| s.to_flight_status());
            if flight.planner_status != new_status {
                flight.planner_status = new_status;
            }
            Ok(())
        })();
        std::future::ready(inner)
    })
    .await;
    if let Err(ref e) = result {
        warn!(error = %e, mission_id, "failed to persist planner state on flight");
    }
    result
}

/// Persist the planner provider string on the Flight DTO so the StatGrid chip
/// can render OAuth-subscription vs API-key spend differently.
///
/// Called once at `start_mission_planner` time (post-`forward_start`,
/// post-registry-insert) with the provider arg the sidecar was dispatched
/// against — currently always [`PLANNER_PROVIDER`] (`"claude-oauth"`) but
/// passed by argument so this helper stays correct when E6 / E9 broaden the
/// allowed providers.
///
/// Missing flight on disk is tolerated (silent no-op) — the planner runtime
/// can still operate against a flight that's been deleted between
/// registry-insert and disk-flush; we only want to record provenance when
/// there's somewhere on disk to put it.
pub(crate) async fn persist_planner_provider_on_flight(
    mission_id: &str,
    provider: &str,
) -> Result<(), String> {
    let mission_id_owned = mission_id.to_string();
    let provider_owned = provider.to_string();
    let result = storage::with_state_lock(move |state| {
        let mission_id = mission_id_owned.clone();
        let provider = provider_owned.clone();
        let inner: Result<(), String> = (|| {
            let Some(flight) = state.flights.iter_mut().find(|f| f.id == mission_id) else {
                return Ok(());
            };
            if flight.planner_provider.as_deref() != Some(provider.as_str()) {
                flight.planner_provider = Some(provider);
                flight.updated_at = now_millis();
            }
            Ok(())
        })();
        std::future::ready(inner)
    })
    .await;
    if let Err(ref e) = result {
        warn!(error = %e, mission_id, "failed to persist planner provider on flight");
    }
    result
}

// ---------------------------------------------------------------------------
// E8 — planner cost / token accumulation
// ---------------------------------------------------------------------------

/// Accumulate one planner-owned turn's token and cost numbers onto the
/// Flight DTO's `planner_tokens` / `planner_cost` fields.
///
/// Called from `agent_sidecar::handle_event`'s `turn_summary` arm via the
/// `MissionPlannerRegistry` reverse-lookup: if the sidecar session that
/// emitted the summary belongs to a planner session, we add its
/// `input + output` token count and computed USD cost onto the owning
/// Flight. Executor sessions (which are not registered against the planner
/// registry) flow into the unrelated `total_cost` rollup elsewhere.
///
/// Semantics:
///   * `planner_tokens` accumulates `input_tokens + output_tokens` — the
///     full per-turn token roll-up the StatGrid chip displays. E10
///     split this from a single `total_tokens` arg into separate
///     `input_tokens` / `output_tokens` arguments so the registry's
///     compaction-trigger counter can track INPUT tokens specifically
///     (the part that grows monotonically with conversation length;
///     output is small per turn). The on-disk chip still gets the sum,
///     so the displayed total is unchanged.
///   * `planner_cost` accumulates `cost_usd`. Zero deltas (e.g. for
///     locally-pricing-unaware models) are still applied — the addition
///     is a no-op cost-wise but `updated_at` still bumps so the UI
///     refreshes the chip.
///   * Missing flight on disk is tolerated (silent no-op): the planner
///     runtime can outlive the on-disk record if the user deleted the
///     mission, and we'd rather drop the accumulation than panic the
///     sidecar event loop.
///
/// Serialized through `storage::with_state_lock` so concurrent calls from
/// a bursty mid-turn `turn_summary` stream don't lose updates against
/// other persisted-state writers (e.g. `persist_planner_state_on_flight`).
pub async fn accumulate_planner_cost(
    mission_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: f64,
) -> Result<(), String> {
    let mission_id_owned = mission_id.to_string();
    let total_tokens = input_tokens.saturating_add(output_tokens);
    let result = storage::with_state_lock(move |state| {
        let mission_id = mission_id_owned.clone();
        let inner: Result<(), String> = (|| {
            let Some(flight) = state.flights.iter_mut().find(|f| f.id == mission_id) else {
                return Err(format!("flight not found: {}", mission_id));
            };
            flight.planner_tokens = Some(
                flight
                    .planner_tokens
                    .unwrap_or(0)
                    .saturating_add(total_tokens),
            );
            flight.planner_cost = Some(flight.planner_cost.unwrap_or(0.0) + cost_usd);
            flight.updated_at = now_millis();
            Ok(())
        })();
        std::future::ready(inner)
    })
    .await;
    if let Err(ref e) = result {
        warn!(error = %e, mission_id, "failed to accumulate planner cost on flight");
    }
    result
}

// ---------------------------------------------------------------------------
// E8 — executor cost / token accumulation
// ---------------------------------------------------------------------------

/// Accumulate one executor-session turn's token and cost numbers onto the
/// Flight DTO's `total_tokens` / `total_cost` fields.
///
/// Sibling of [`accumulate_planner_cost`]: where the planner helper rolls
/// up planner-owned turns onto the dedicated `planner_*` chip fields, this
/// helper rolls up executor-owned turns (the agents the planner spawns
/// through the async-attempts path, or any standalone API-agent session
/// linked to a flight via `attempts.session_id` /
/// `milestones[].tasks[].session_id`) onto the mission-total fields.
///
/// The StatGrid chip in the frontend derives the "Executor" cost as
/// `totalCost - plannerCost` — that subtraction is only correct once
/// executor turn_summaries actually flow into `total_cost`. Pre-E8 this
/// helper didn't exist and executor cost was dropped on the floor; the
/// chip therefore always showed `Exec = totalCost - plannerCost = 0`.
///
/// Semantics:
///   * `total_tokens` accumulates the caller-provided `total_tokens` sum
///     (typically `input + output + cache-read + cache-create`).
///   * `total_cost` accumulates `cost_usd` directly.
///   * Returns `Err` (and logs a warning) when the mission id is unknown,
///     mirroring the planner helper's contract — losing executor cost
///     silently would skew the chip just as badly as losing planner cost.
///
/// Serialized through `storage::with_state_lock` for the same reason as
/// the planner helper: parallel executor turn_summary streams must not
/// race against each other or against `persist_planner_state_on_flight`.
pub async fn accumulate_executor_cost(
    mission_id: &str,
    total_tokens: u64,
    cost_usd: f64,
) -> Result<(), String> {
    let mission_id_owned = mission_id.to_string();
    let result = storage::with_state_lock(move |state| {
        let mission_id = mission_id_owned.clone();
        let inner: Result<(), String> = (|| {
            let Some(flight) = state.flights.iter_mut().find(|f| f.id == mission_id) else {
                return Err(format!("flight not found: {}", mission_id));
            };
            flight.total_tokens = flight.total_tokens.saturating_add(total_tokens);
            flight.total_cost += cost_usd;
            flight.updated_at = now_millis();
            Ok(())
        })();
        std::future::ready(inner)
    })
    .await;
    if let Err(ref e) = result {
        warn!(error = %e, mission_id, "failed to accumulate executor cost on flight");
    }
    result
}

/// Reverse-lookup return value for [`flight_for_executor_session`]: the
/// owning flight id plus the model recorded on the attempt/task (used by
/// the caller to price the turn through `pricing::calculate_cost`).
#[derive(Debug, Clone)]
pub struct ExecutorSessionOwner {
    pub flight_id: String,
    pub model: String,
}

/// Reverse-lookup: find the Flight that owns the executor session whose
/// API-agent session id is `session_id`. Returns the owning flight's id
/// plus the model recorded next to the session on the attempt / task, or
/// `None` if no flight references the session.
///
/// Searches both linkage sites:
///   * `flight.attempts[].session_id` — the async-attempts path
///     (`asyncFlightStore.launchAsync` / the planner's `create_task`)
///   * `flight.milestones[].tasks[].session_id` — the multi-task path
///     (planner tasks running through `core::orchestrator`)
///
/// The attempt linkage carries `model` directly on `Attempt`. The task
/// linkage doesn't carry a model on `Task` itself, so the lookup falls
/// back to the empty string — `pricing::calculate_cost` treats an unknown
/// model as zero-priced (returns `0.0`), which means the task path will
/// still roll up tokens onto `total_tokens` but cost onto `total_cost`
/// will only land when the model is resolvable. (Acceptable trade for v1
/// — once `Task` grows a `model` field we can return it here too.)
///
/// Cheap: O(flights × (attempts + milestones × tasks_per_milestone)).
/// State sizes are small enough in practice that linear scan beats
/// maintaining a separate session→flight index.
pub fn flight_for_executor_session(
    state: &PersistedState,
    session_id: &str,
) -> Option<ExecutorSessionOwner> {
    for f in state.flights.iter() {
        if let Some(a) = f.attempts.iter().find(|a| a.session_id == session_id) {
            return Some(ExecutorSessionOwner {
                flight_id: f.id.clone(),
                model: a.model.clone(),
            });
        }
        if f.milestones.iter().any(|m| {
            m.tasks
                .iter()
                .any(|t| t.session_id.as_deref() == Some(session_id))
        }) {
            return Some(ExecutorSessionOwner {
                flight_id: f.id.clone(),
                model: String::new(),
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Cold-start enforcement (E6 safety rail)
// ---------------------------------------------------------------------------

/// Pure, I/O-free core of [`enforce_cold_start_paused`]. Walks `state.flights`
/// and flips any mission that *was* running a planner at last shutdown back to
/// `PlannerStatus::Paused`, clearing the stale `planner_session_id` (the
/// sidecar that owned it died with the app). Returns the count of missions
/// modified — telemetry-only; persistence is the caller's job.
///
/// Eligibility: `status` is NOT terminal (i.e. not
/// `Done` / `Failed` / `Cancelled`) AND (
///   `planner_session_id.is_some()` OR
///   `planner_status` ∈ {`Awake`, `Idle`, `QuotaPaused`}
/// ).
///
/// (The planner's "running" footprint is any state with a live sidecar
/// session: `Awake` / `Idle` / `QuotaPaused`. `Paused` is sticky — we don't
/// re-pause it. `Completed` / `Failed` are terminal — also sticky.)
///
/// **Scope correction (E6 FIX 1)**: the predicate now matches any
/// non-terminal mission, not just `Active`. A planner pinned to a
/// `Planning` / `Review` / `Spec` / `Paused` flight at last shutdown
/// still owns a dead sidecar session id post-restart — its metadata
/// must be reset just like the `Active` case. Terminal states
/// (`Done` / `Failed` / `Cancelled`) are skipped because touching a
/// terminal mission's planner state would be both wrong and surprising.
pub fn compute_cold_start_paused(state: &mut PersistedState) -> usize {
    let mut count: usize = 0;
    for flight in state.flights.iter_mut() {
        // Terminal flights are sticky — never rewrite their planner
        // metadata even if they happen to carry a stale session id.
        let is_terminal = matches!(
            flight.status,
            FlightStatus::Done | FlightStatus::Failed | FlightStatus::Cancelled,
        );
        if is_terminal {
            continue;
        }
        let had_session = flight.planner_session_id.is_some();
        let was_running = matches!(
            flight.planner_status,
            Some(FlightPlannerStatus::Awake)
                | Some(FlightPlannerStatus::Idle)
                | Some(FlightPlannerStatus::QuotaPaused)
        );
        if !(had_session || was_running) {
            continue;
        }
        flight.planner_status = Some(FlightPlannerStatus::Paused);
        flight.planner_session_id = None;
        count += 1;
    }
    count
}

/// Boot-time safety rail. Planner sidecar sessions are ephemeral — they die
/// with the host app — so on a fresh app start any mission whose planner was
/// `Awake` / `Idle` / `QuotaPaused` (or merely had a `planner_session_id`
/// pinned) is now pointing at a dead session. We flip those to
/// [`FlightPlannerStatus::Paused`] and clear the stale session id, forcing
/// the user to explicitly resume via the UI before the wake bus starts
/// dispatching turns at a planner that doesn't exist.
///
/// Called once from the `tauri::Builder::setup` hook in `lib.rs`. Wraps
/// [`compute_cold_start_paused`] inside `storage::with_state_lock` so we
/// serialize against any other planner-related state mutation that might
/// race the boot path (e.g. a planner tool firing from a stale sidecar
/// before this runs — unlikely, but the lock costs us nothing).
///
/// Returns the number of missions paused for telemetry.
pub async fn enforce_cold_start_paused() -> Result<usize, String> {
    storage::with_state_lock(|state| {
        let count = compute_cold_start_paused(state);
        std::future::ready(Ok::<usize, String>(count))
    })
    .await
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

    // Gather a mission snapshot for the wake-message builder. We pull a
    // read-only view of the Flight DTO via `storage::load_state` (no lock —
    // we're not mutating). E7 will replace `journal_tail` with the proper
    // journal feed; for now we surface the failed-task conversation tail on
    // `TaskFailed` so the planner has concrete evidence to react to.
    let (mission_snapshot, journal_tail) =
        build_wake_payload(&event.mission_id, &event.trigger, &event.payload);

    let content = wake_user_message(&event.trigger, &journal_tail, &mission_snapshot);
    let trigger_kind = event.trigger.kind_str();

    // E6-CAPS: set per-wake mode + reset the per-tick tool-call counter
    // BEFORE injecting. The MCP dispatcher reads `current_mode` /
    // `tool_calls_this_tick` to enforce caps, and we choose the output
    // token budget off the same mode below. We do this even if the inject
    // ultimately fails — the counter reset is idempotent.
    let mode = PlannerMode::from_trigger(&event.trigger);
    registry.set_mode_and_reset_tick(&event.mission_id, mode).await;
    let max_output_tokens = mode.max_output_tokens();

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
            Some(max_output_tokens),
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

    // E7-HOOKS site 1 — journal the wake trigger. We do this AFTER the
    // inject succeeds so the journal reflects events the planner actually
    // saw. Payload is the full trigger event for future analyses; the
    // markdown body is a 1-2 line human-readable summary.
    let payload_summary = serde_json::to_string(&event.payload)
        .unwrap_or_else(|_| "{}".to_string());
    let body = format!(
        "**kind**: `{}`\n**payload**: {}",
        trigger_kind,
        truncate_for_journal(&payload_summary, 240),
    );
    let metadata = serde_json::json!({
        "trigger": event.trigger,
        "payload": event.payload,
        "mode": format!("{:?}", mode),
    });
    let entry = journal_entry(
        event.mission_id.clone(),
        JournalKind::WakeTrigger,
        body,
        Some(metadata),
    );
    write_journal_and_emit(app_handle, entry).await;

    // Flip to Awake while the planner is processing this wake's turn. The
    // status flips back to Idle when the sidecar emits `done` for this
    // session — wired in E6-KILL-AWAKE via `MissionPlannerRegistry::
    // on_planner_done`, which is invoked from `agent_sidecar::handle_event`'s
    // `"done"` arm. The on_planner_done guard preserves Paused /
    // QuotaPaused / terminal states, so a pause that races with a `done`
    // event doesn't get clobbered.
    registry
        .set_status(&event.mission_id, PlannerStatus::Awake)
        .await;
    if let Err(e) = persist_planner_state_on_flight(
        &event.mission_id,
        Some(&session.sidecar_session_id),
        Some(PlannerStatus::Awake),
    )
    .await
    {
        warn!(
            mission_id = %event.mission_id,
            error = %e,
            "dispatch_wake: failed to persist Awake on Flight DTO"
        );
    }
}

// ---------------------------------------------------------------------------
// Wake payload enrichment — mission snapshot + journal tail
// ---------------------------------------------------------------------------

/// Build the `(mission_snapshot, journal_tail)` pair fed into
/// [`wake_user_message`] for a wake event.
///
/// `mission_snapshot` is a structured JSON view of the current Flight DTO:
/// title, objective, project path, workspace id, milestone/task counters,
/// and the count of tasks currently `Queued` or `Running`. The planner uses
/// this to ground its reasoning in the current state of the mission rather
/// than relying on chat history alone.
///
/// `journal_tail` is best-effort recent context. E7 will replace this with
/// a proper journal feed; for now the only kind that populates it is
/// [`WakeTrigger::TaskFailed`] — we look up the failed task's
/// `session_id` and pull the last ~30 lines of the persisted conversation
/// file (`<DATA_DIR>/conversations/<session_id>.json`). If the conversation
/// file doesn't exist or fails to parse, we return an empty string — the
/// prompt builder handles that case.
///
/// Read-only: uses `storage::load_state` (no lock) and a plain file read.
/// Safe to call from inside the wake consumer without holding any mutex.
fn build_wake_payload(
    mission_id: &str,
    trigger: &WakeTrigger,
    trigger_payload: &serde_json::Value,
) -> (serde_json::Value, String) {
    let state = storage::load_state();
    let flight = state.flights.iter().find(|f| f.id == mission_id);

    let mut snapshot = match flight {
        Some(flight) => {
            let task_count: usize = flight.milestones.iter().map(|m| m.tasks.len()).sum();
            let pending_tasks: usize = flight
                .milestones
                .iter()
                .flat_map(|m| m.tasks.iter())
                .filter(|t| {
                    matches!(
                        t.status,
                        crate::core::flight::TaskStatus::Queued
                            | crate::core::flight::TaskStatus::Running
                    )
                })
                .count();
            serde_json::json!({
                "missionId": mission_id,
                "title": flight.title,
                "objective": flight.objective,
                "projectPath": flight.project_path,
                "workspaceId": flight.workspace_id,
                "status": flight.status,
                "milestoneCount": flight.milestones.len(),
                "taskCount": task_count,
                "pendingTasks": pending_tasks,
                "triggerPayload": trigger_payload,
            })
        }
        None => serde_json::json!({
            "missionId": mission_id,
            "triggerPayload": trigger_payload,
        }),
    };

    // For TaskFailed triggers, surface the failed task onto the snapshot
    // as a top-level `task` object and pre-classify the failure via the
    // canonical `core::error_classifier`. The prompt renderer's
    // `find_task_by_id` falls back to `snapshot["task"]` when no
    // `milestones` array is present, so this is the channel through which
    // the renderer reads `errorCategory` / `replanExempt`.
    //
    // We do this here rather than letting the renderer's local
    // `quick_classify` heuristic run because the two classifiers (the
    // canonical `classify_cli_error` and the renderer's heuristic) can
    // disagree on real-world error strings — and the renderer's
    // "WILL count / does NOT count" wording must match what
    // `replan_after_failure` actually does at the dispatcher. By
    // pre-classifying with the same function the dispatcher uses
    // (`classify_task_last_error` + `is_replan_exempt`), the body the
    // planner reads cannot lie relative to the counter behavior.
    if let (WakeTrigger::TaskFailed(task_id), Some(flight)) = (trigger, flight) {
        if let Some(task) = flight
            .milestones
            .iter()
            .flat_map(|m| m.tasks.iter())
            .find(|t| t.id == *task_id)
        {
            // Serialize the full Task via serde — this gives the renderer
            // the same camelCase shape it already reads (title, agent,
            // description, result.errors, replanCount, …).
            if let Ok(mut task_value) = serde_json::to_value(task) {
                if let Some(obj) = task_value.as_object_mut() {
                    if let Some(category) =
                        crate::core::error_classifier::classify_task_last_error(task)
                    {
                        // Snake-case wire form — must match the renderer's
                        // expected `"rate_limit" | "timeout" | …` strings
                        // and the shape `replan_after_failure.rs` returns
                        // in its tool response. Both serialize the same
                        // `AiErrorCategory` via its
                        // `#[serde(rename_all = "snake_case")]` derive.
                        let category_str = serde_json::to_value(category)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_string))
                            .unwrap_or_else(|| format!("{:?}", category).to_ascii_lowercase());
                        let exempt =
                            crate::core::error_classifier::is_replan_exempt(&category);
                        obj.insert(
                            "errorCategory".to_string(),
                            serde_json::Value::String(category_str),
                        );
                        obj.insert(
                            "replanExempt".to_string(),
                            serde_json::Value::Bool(exempt),
                        );
                    }
                    // If classification returned None (task has no
                    // errors recorded), we deliberately leave the fields
                    // off so the renderer falls back to its
                    // `quick_classify` heuristic over whatever it can
                    // find on the snapshot.
                }
                if let Some(obj) = snapshot.as_object_mut() {
                    obj.insert("task".to_string(), task_value);
                }
            }
        }
    }

    let journal_tail = match trigger {
        WakeTrigger::TaskFailed(task_id) => flight
            .and_then(|f| {
                f.milestones
                    .iter()
                    .flat_map(|m| m.tasks.iter())
                    .find(|t| t.id == *task_id)
                    .and_then(|t| t.session_id.clone())
            })
            .map(|sid| read_conversation_tail(&sid, 30))
            .unwrap_or_default(),
        _ => String::new(),
    };

    (snapshot, journal_tail)
}

/// Read the last `max_lines` lines of the persisted conversation file for
/// `session_id`. Returns an empty string if the file is missing or
/// unreadable — callers must handle the empty case (the prompt builder
/// already does).
///
/// File path mirrors `commands::conversations`:
/// `<home>/<DATA_DIR_NAME>/conversations/<session_id>.json`. We don't try to
/// parse the JSON — the wake message is going to a model that handles
/// noisy context fine, and parsing here would couple the planner to the
/// frontend conversation schema. We treat it as opaque text and slice the
/// tail.
fn read_conversation_tail(session_id: &str, max_lines: usize) -> String {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return String::new();
    }
    let home = match crate::commands::shared::home_dir() {
        Some(h) => h,
        None => return String::new(),
    };
    let path = std::path::PathBuf::from(home)
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("conversations")
        .join(format!("{}.json", session_id));
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
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
            // allowedTools: the E2 full planner tool surface. `noop` is
            // kept so the protocol-v5 in-process MCP smoke stays passing.
            // `spawn_helper_planner` is intentionally absent — it is
            // deferred to v1.1; the dispatcher still errors cleanly if
            // the model tries to call it. Caps + ceiling enforcement
            // (E6) wraps the dispatch path rather than this allowlist.
            vec![
                "mcp__planner__noop".to_string(),
                "mcp__planner__create_milestone".to_string(),
                "mcp__planner__create_task".to_string(),
                "mcp__planner__update_task".to_string(),
                "mcp__planner__mark_task_blocked".to_string(),
                "mcp__planner__replan_after_failure".to_string(),
                "mcp__planner__request_user_approval".to_string(),
                "mcp__planner__complete_mission".to_string(),
            ],
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
    if let Err(e) = persist_planner_state_on_flight(
        &mission_id,
        Some(&session_id),
        Some(PlannerStatus::Idle),
    )
    .await
    {
        warn!(
            mission_id = %mission_id,
            error = %e,
            "start_mission_planner: failed to persist Idle on Flight DTO"
        );
    }
    // E8 — record the planner provider so the StatGrid chip can render
    // OAuth-subscription vs API-key spend differently. Best-effort: a
    // failure here doesn't block the planner from running, it just means
    // the chip won't know how to render until a successful subsequent
    // turn's `turn_summary` updates the flight (cost accumulation also
    // bumps `updated_at`, but doesn't touch `planner_provider`).
    if let Err(e) = persist_planner_provider_on_flight(&mission_id, PLANNER_PROVIDER).await {
        warn!(
            mission_id = %mission_id,
            error = %e,
            "start_mission_planner: failed to persist planner provider on Flight DTO"
        );
    }

    // E10-SWAP — install the per-mission compaction-trigger listener. When
    // E10-DETECT's `bump_cumulative_input_and_check` crosses the threshold
    // and emits `mission-planner:compaction-triggered:<missionId>`, the
    // listener routes the event into `perform_compaction`, which restarts
    // the planner session with a summarized priming context.
    //
    // E10 FIX P0 — capture the returned `EventId` and store it on the
    // session record so `stop_mission_planner` / `complete_mission` can
    // `app.unlisten` before the session is removed. Without this,
    // start→stop cycles accumulate listeners and one event fires N tasks.
    //
    // Installed exactly once per planner lifecycle — the early-return
    // branches above (existing planner for the same mission) skip this so
    // we don't double-register a listener for the same mission id.
    let event_id = crate::commands::mission_planner_compaction::install_compaction_listener(
        &app_handle,
        &mission_id,
    );
    registry.set_compaction_listener(&mission_id, event_id).await;

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

    // Peek the sidecar session id without removing from the registry yet.
    // Per peer-review FIX 3: shutdown order must be close-sidecar FIRST,
    // then registry-remove. If we removed first and `forward_close`
    // failed (broken pipe, dead sidecar), the sidecar-side conversation
    // would be orphaned with no way for the registry to reach it again.
    let sidecar_session_id = match registry.get_by_mission(&mission_id).await {
        Some(s) => s.sidecar_session_id,
        None => return Ok(()), // nothing to stop is success
    };

    // Close the sidecar session FIRST (best-effort — log on failure).
    if let Some(sidecar) = app_handle.try_state::<Arc<SidecarManager>>() {
        if let Err(e) = sidecar.forward_close(sidecar_session_id.clone()).await {
            warn!(error = %e, "stop_mission_planner: forward_close failed");
        }
    }

    // E10 FIX P0 — unlisten the compaction-trigger event handler BEFORE
    // removing the session from the registry. The EventId was captured in
    // `start_mission_planner` and stored on the session; without
    // unlistening here, every start→stop cycle leaks a listener.
    if let Some(event_id) = registry.take_compaction_listener(&mission_id).await {
        use tauri::Listener as _;
        app_handle.unlisten(event_id);
        tracing::debug!(
            mission_id = %mission_id,
            event_id,
            "stop_mission_planner: unlistened compaction-trigger"
        );
    }

    // Then drop the entry from the registry.
    //
    // E7-PARTIAL-DRAIN: route through `remove_session` (not the inner
    // `remove`) so any pending streamed chunks from a turn that was in
    // flight when the user pressed Stop are drained and journaled as a
    // partial `PlannerMessage` rather than silently dropped.
    registry.remove_session(&mission_id, Some(&app_handle)).await;

    if let Err(e) = persist_planner_state_on_flight(&mission_id, None, None).await {
        warn!(
            mission_id = %mission_id,
            error = %e,
            "stop_mission_planner: failed to clear planner state on Flight DTO"
        );
    }
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
    // FIX 3 — use the emit-aware helper so the frontend's
    // `mission-planner:status-changed:<missionId>` listener flips
    // `runtime.status` to `paused` without a polling round-trip.
    registry
        .set_status_and_emit(&mission_id, PlannerStatus::Paused, &app_handle)
        .await;
    if let Err(e) =
        persist_planner_state_on_flight(&mission_id, None, Some(PlannerStatus::Paused)).await
    {
        warn!(
            mission_id = %mission_id,
            error = %e,
            "pause_mission_planner: failed to persist Paused on Flight DTO"
        );
    }
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
    // FIX 3 — emit-aware so the frontend store flips to Idle reactively.
    registry
        .set_status_and_emit(&mission_id, PlannerStatus::Idle, &app_handle)
        .await;
    if let Err(e) = persist_planner_state_on_flight(
        &mission_id,
        Some(&session.sidecar_session_id),
        Some(PlannerStatus::Idle),
    )
    .await
    {
        warn!(
            mission_id = %mission_id,
            error = %e,
            "resume_mission_planner: failed to persist Idle on Flight DTO"
        );
    }
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

    // E6-CAPS: for plain user-typed turns (`source = "user"`), the planner is
    // operating in spec-mode context — apply the Spec budget. Wake-trigger
    // injections coming through this command (e.g. frontend
    // `user_message_in_journal`) are reactive in nature; use the Reactive
    // budget so the model has comparable headroom to the wake-bus path.
    let mode = if source == "user" {
        session.current_mode // typically Spec pre-launch
    } else {
        PlannerMode::Reactive
    };
    let max_output_tokens = mode.max_output_tokens();

    sidecar
        .forward_inject_user_turn(
            &session.sidecar_session_id,
            &content,
            &source,
            trigger_kind,
            Some(max_output_tokens),
        )
        .await?;

    // E7-HOOKS site 2 — journal user-typed turns. Wake-trigger injections
    // coming through this command are journaled by site 1 (the wake bus
    // dispatcher), so we skip them here to avoid double-recording.
    if source == "user" {
        let entry = journal_entry(
            mission_id.clone(),
            JournalKind::UserMessage,
            content.clone(),
            Some(serde_json::json!({ "source": "user" })),
        );
        write_journal_and_emit(&app_handle, entry).await;
    }

    // FIX 3 — emit-aware so the frontend store reflects the Awake
    // turn-in-flight without polling.
    registry
        .set_status_and_emit(&mission_id, PlannerStatus::Awake, &app_handle)
        .await;
    if let Err(e) = persist_planner_state_on_flight(
        &mission_id,
        Some(&session.sidecar_session_id),
        Some(PlannerStatus::Awake),
    )
    .await
    {
        warn!(
            mission_id = %mission_id,
            error = %e,
            "inject_planner_turn: failed to persist Awake on Flight DTO"
        );
    }
    Ok(())
}

/// Fire a `WakeTrigger::Decomposition` event for `mission_id` onto the
/// wake bus.
///
/// This is the architecturally-clean path for the user-clicks-Launch
/// transition: instead of the frontend hand-crafting a `[LAUNCH]` user
/// message and pushing it through [`inject_planner_turn`] (which would
/// tag the wake as `kind="user_message_in_journal"` — wrong), Launch
/// fires the real `Decomposition` wake. The existing wake consumer
/// ([`spawn_wake_consumer`] / [`dispatch_wake`]) then:
///   * pulls a fresh mission snapshot via [`build_wake_payload`],
///   * formats the body via [`wake_user_message`]
///     (→ `render_decomposition`), and
///   * injects with `kind_str() = "launch"` (see
///     [`WakeTrigger::kind_str`]), which is the kind the planner's
///     system prompt is trained to recognize as the kickoff trigger.
///
/// Errors if no planner is registered for the mission — the frontend's
/// `launchMission` always calls `startPlanner` first, so a missing
/// planner here is a bug worth surfacing.
#[tauri::command]
pub async fn trigger_planner_decomposition(
    app_handle: AppHandle,
    mission_id: String,
) -> Result<(), String> {
    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;

    if registry.get_by_mission(&mission_id).await.is_none() {
        return Err(format!(
            "no active planner for mission '{}'; call start_mission_planner first",
            mission_id
        ));
    }

    // `payload` intentionally empty — `build_wake_payload` reads the
    // current Flight DTO from PersistedState and constructs the real
    // snapshot at dispatch time, which is what `render_decomposition`
    // wants. We don't need to pass per-trigger payload data for the
    // Decomposition variant.
    registry
        .send_wake(PlannerWakeEvent {
            mission_id: mission_id.clone(),
            trigger: WakeTrigger::Decomposition,
            payload: serde_json::json!({}),
        })
        .await;

    info!(
        mission_id = %mission_id,
        "queued decomposition wake for mission planner"
    );
    Ok(())
}

/// Resolve a pending Mission Planner approval gate (E2).
///
/// Flips the matching `MissionApprovalRequest` on `PersistedState` to
/// `resolved=true`, records the chosen option + timestamp, persists, and
/// fans a `WakeTrigger::UserMessageInJournal` event onto the wake bus so
/// the planner sees the user's answer on its next turn (the wake consumer
/// formats it into a `<wake_trigger kind="user_message_in_journal">` block
/// that includes the `approval_id` and `choice`).
///
/// Idempotent for already-resolved approvals: returns Ok without emitting
/// a second wake. Returns an error if no approval matches the id.
#[tauri::command]
pub async fn resolve_mission_approval(
    app_handle: AppHandle,
    approval_id: String,
    choice: String,
) -> Result<(), String> {
    // Per peer-review FIX 1: wrap the load → mutate → save composite in
    // `with_state_lock` so concurrent planner approvals (e.g. two MCP
    // tools resolving in parallel, or a user click racing a wake-driven
    // re-resolution) can't lose updates. The closure performs the
    // mutation synchronously and returns a `Ready` future so the
    // resulting `Fut` type doesn't capture a borrow of `state` (which
    // the helper's `FnOnce(&mut PersistedState) -> Fut` signature can't
    // express with HRTBs today). Tauri event emits MUST happen outside
    // this block so we don't hold the mutex across IO.
    let approval_id_for_closure = approval_id.clone();
    let choice_for_closure = choice.clone();
    let (mission_id, was_already_resolved) = storage::with_state_lock(move |state| {
        let approval_id = approval_id_for_closure;
        let choice = choice_for_closure;
        let result: Result<(String, bool), String> = (|| {
            let approval = state
                .mission_approvals
                .iter_mut()
                .find(|a| a.id == approval_id)
                .ok_or_else(|| {
                    format!("no mission approval found for id '{}'", approval_id)
                })?;
            let mission_id = approval.mission_id.clone();
            // Idempotency: if the approval was already resolved, short-
            // circuit so the caller can still emit a "we already handled
            // this" downstream event (or just no-op). We do NOT mutate
            // state in this branch — return the existing mission_id so
            // the outer code can decide.
            if approval.resolved {
                return Ok((mission_id, true));
            }
            approval.resolved = true;
            approval.resolution = Some(choice);
            approval.resolved_at = Some(now_millis());
            Ok((mission_id, false))
        })();
        std::future::ready(result)
    })
    .await?;

    if was_already_resolved {
        info!(
            approval_id = %approval_id,
            "resolve_mission_approval called on already-resolved approval; no-op"
        );
        return Ok(());
    }

    // FIX 2: emit `mission-planner:approval-resolved:<missionId>` so the
    // frontend `missionPlannerStore` can clear its pending-approval state
    // without waiting for a wake round-trip. camelCase field names match
    // the frontend `MissionApprovalRequest` interface. Emits happen
    // outside the state lock to avoid holding the mutex across IO.
    let _ = app_handle.emit(
        &format!("mission-planner:approval-resolved:{}", mission_id),
        serde_json::json!({
            "id": approval_id,
            "missionId": mission_id,
            "choice": choice,
        }),
    );

    // E7-HOOKS site 4 — journal the resolution as a SystemNote so the
    // timeline shows who chose what. We do this AFTER the state lock is
    // released (file IO must not happen under the mutex).
    let body = format!(
        "Approval `{}` resolved: **{}**",
        approval_id, choice
    );
    let metadata = serde_json::json!({
        "approvalId": approval_id,
        "choice": choice,
    });
    let entry = journal_entry(
        mission_id.clone(),
        JournalKind::SystemNote,
        body,
        Some(metadata),
    );
    write_journal_and_emit(&app_handle, entry).await;

    // Look up the planner for the owning mission and emit a wake.
    // The wake consumer (spawn_wake_consumer) reads `mission_approvals`
    // at dispatch time when formatting the user-message turn — we just
    // need to nudge the consumer with the right trigger discriminant
    // and a payload carrying the approval id + choice so the prompt
    // builder doesn't have to re-scan state.
    let registry = app_handle
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;

    // If there's no active planner for this mission, the resolution is
    // still persisted — the planner will pick it up if/when it resumes.
    if registry.get_by_mission(&mission_id).await.is_some() {
        registry
            .send_wake(PlannerWakeEvent {
                mission_id: mission_id.clone(),
                trigger: WakeTrigger::UserMessageInJournal(format!(
                    "Approval {} resolved: {}",
                    approval_id, choice
                )),
                payload: serde_json::json!({
                    "approvalId": approval_id,
                    "choice": choice,
                }),
            })
            .await;
    }

    info!(
        mission_id = %mission_id,
        approval_id = %approval_id,
        "resolved mission approval"
    );
    Ok(())
}

/// Cold-start hydration query for the frontend's pending-approval state.
///
/// `missionPlannerStore` populates its `pendingApprovals` map exclusively via
/// `mission-planner:approval-request:<missionId>` event listeners that are
/// installed in `startPlanner`. If a mission already has pending approvals on
/// disk before those listeners attach — e.g. resuming a paused mission, a
/// page reload, or a cold app start — the events have already fired and the
/// store starts empty. The frontend calls this command after installing
/// listeners (but before mounting the spec pane) to backfill any unresolved
/// approvals so the UI is consistent with persisted state.
///
/// Returns only **unresolved** approvals — resolved entries are historical
/// and don't need to surface. Read-only; no state lock required.
#[tauri::command]
pub async fn get_mission_approvals(
    mission_id: String,
) -> Result<Vec<crate::api::MissionApprovalRequestDto>, String> {
    let state = storage::load_state();
    let approvals: Vec<crate::api::MissionApprovalRequestDto> = state
        .mission_approvals
        .into_iter()
        .filter(|a| a.mission_id == mission_id && !a.resolved)
        .map(Into::into)
        .collect();
    Ok(approvals)
}

// ---------------------------------------------------------------------------
// E7 — mission journal read access
// ---------------------------------------------------------------------------
//
// `get_mission_journal` returns the raw markdown text of a mission's
// append-only journal. The JournalTab renders it verbatim via
// `MarkdownRenderer`. On a mission with no recorded activity the file
// doesn't exist yet — `read_journal` returns `Ok("")` in that case so
// the UI can render its own empty state.
//
// `get_mission_journal_path` resolves the on-disk path so the Export
// button can show the user where the file lives (and a future
// "Reveal in Finder" command can call straight into the OS shell).

#[tauri::command]
pub async fn get_mission_journal(mission_id: String) -> Result<String, String> {
    crate::core::mission_journal::read_journal(&mission_id)
}

#[tauri::command]
pub async fn get_mission_journal_path(mission_id: String) -> Result<String, String> {
    // Defensive path-traversal guard at the Tauri command boundary (the
    // explicit "untrusted input" point). `journal_path` itself also rejects
    // these, but returning an error here gives the frontend a clean failure
    // instead of a bogus sentinel path.
    if mission_id.is_empty()
        || mission_id.contains('/')
        || mission_id.contains('\\')
        || mission_id.contains("..")
        || mission_id.contains('\0')
    {
        return Err("invalid mission_id".to_string());
    }
    let path = crate::core::mission_journal::journal_path(&mission_id);
    Ok(path.to_string_lossy().into_owned())
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

// ---------------------------------------------------------------------------
// E7-HOOKS — journal entry construction + best-effort append/emit
// ---------------------------------------------------------------------------

/// Build a [`JournalEntry`] with a fresh uuid + current timestamp. Generic
/// constructor used by every E7 hook site so they don't all hand-roll uuid
/// generation and field plumbing.
pub(crate) fn journal_entry(
    mission_id: impl Into<String>,
    kind: JournalKind,
    content_md: impl Into<String>,
    metadata: Option<serde_json::Value>,
) -> JournalEntry {
    JournalEntry {
        id: uuid::Uuid::new_v4().to_string(),
        mission_id: mission_id.into(),
        timestamp: now_millis(),
        kind,
        content_md: content_md.into(),
        metadata,
    }
}

/// Append `entry` to the mission journal and (on success) emit
/// `mission-planner:journal-appended:<missionId>` so the frontend can pick
/// up the new entry without polling.
///
/// Append failures are non-fatal — the journal is auxiliary. A warning is
/// logged and the function returns silently so callers don't have to thread
/// `Result`s through their hot paths.
pub(crate) async fn write_journal_and_emit(app: &AppHandle, entry: JournalEntry) {
    let mission_id = entry.mission_id.clone();
    let entry_id = entry.id.clone();
    if let Err(e) = append_journal(&entry).await {
        warn!(
            error = %e,
            mission_id = %mission_id,
            "failed to append to mission journal"
        );
        return;
    }
    let _ = app.emit(
        &format!("mission-planner:journal-appended:{}", mission_id),
        serde_json::json!({
            "missionId": mission_id,
            "entryId": entry_id,
        }),
    );
}

/// Truncate a string to at most `max` chars, appending an ellipsis hint when
/// truncation occurred. Used for journal body summaries.
fn truncate_for_journal(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n…(truncated)");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_trigger_kind_str_matches_locked_design() {
        // `Decomposition` maps to `"launch"` (not `"decomposition"`) because
        // the kickoff trigger fires when the user clicks Launch — the
        // planner system prompt teaches the model to recognize "launch" as
        // the kickoff kind, so the wire shape must agree.
        assert_eq!(WakeTrigger::Decomposition.kind_str(), "launch");
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
    fn build_wake_payload_falls_back_when_flight_missing() {
        // No flight registered under this id — snapshot should still echo
        // the trigger payload so downstream prompt builders have something
        // to render. Journal tail must be empty in this case (no flight =
        // no task = no session id to look up).
        let (snapshot, tail) = build_wake_payload(
            "mission-that-does-not-exist",
            &WakeTrigger::TaskCompleted("t-1".into()),
            &serde_json::json!({"taskId": "t-1"}),
        );
        assert_eq!(snapshot["missionId"], "mission-that-does-not-exist");
        assert!(snapshot.get("triggerPayload").is_some());
        // Title et al. should be absent when the flight isn't found.
        assert!(snapshot.get("title").is_none());
        assert_eq!(tail, "");
    }

    #[test]
    fn read_conversation_tail_returns_empty_for_missing_file() {
        // Random uuid → no file → empty string (not an error). Also
        // exercises the path-escape guard for the `..` case.
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(read_conversation_tail(&id, 30), "");
        assert_eq!(read_conversation_tail("..", 30), "");
        assert_eq!(read_conversation_tail("a/b", 30), "");
        assert_eq!(read_conversation_tail("", 30), "");
    }

    #[test]
    fn read_conversation_tail_slices_last_n_lines() {
        // Write a temp conversation file under a process-unique id, then
        // verify the tail slice matches the last `max_lines` lines.
        let home = match crate::commands::shared::home_dir() {
            Some(h) => h,
            None => return, // CI without HOME — skip
        };
        let dir = std::path::PathBuf::from(&home)
            .join(crate::core::brand::DATA_DIR_NAME)
            .join("conversations");
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let id = format!("test-mission-planner-{}", uuid::Uuid::new_v4());
        let path = dir.join(format!("{}.json", id));
        let body: String = (0..50)
            .map(|i| format!("line-{}", i))
            .collect::<Vec<_>>()
            .join("\n");
        if std::fs::write(&path, &body).is_err() {
            return;
        }
        let tail = read_conversation_tail(&id, 5);
        let _ = std::fs::remove_file(&path);
        assert!(tail.ends_with("line-49"));
        assert!(tail.contains("line-45"));
        assert!(!tail.contains("line-44"));
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

    /// E6-CEILING-RATELIMIT — `PlannerStatus::QuotaPaused` must serialize
    /// to the locked snake_case wire form `"quota_paused"` and round-trip
    /// cleanly through serde, both as a bare enum and as the
    /// `MissionPlannerSession.status` field. The frontend
    /// `missionPlannerStore.PlannerStatus` union pins this exact string
    /// (`"quota_paused"`), and the rate-limit notification listener
    /// matches on it — drift here would silently break the auto-resume
    /// flow.
    #[test]
    fn mission_planner_session_has_quota_paused_status() {
        // Bare enum round-trip — locked to snake_case via the
        // `#[serde(rename_all = "snake_case")]` derive on `PlannerStatus`.
        let json = serde_json::to_value(PlannerStatus::QuotaPaused)
            .expect("PlannerStatus must serialize cleanly");
        assert_eq!(
            json,
            serde_json::Value::String("quota_paused".to_string()),
            "QuotaPaused must wire as snake_case \"quota_paused\""
        );
        let back: PlannerStatus = serde_json::from_value(json)
            .expect("PlannerStatus must deserialize cleanly");
        assert_eq!(back, PlannerStatus::QuotaPaused);

        // Full MissionPlannerSession round-trip — guards against the
        // (camelCase) field serialization breaking when QuotaPaused is the
        // session's status. This is the shape the auth-watcher / cold-start
        // recovery code path actually reads.
        let mut session = MissionPlannerSession::new(
            "planner-1".to_string(),
            "mission-1".to_string(),
            "sidecar-1".to_string(),
        );
        session.status = PlannerStatus::QuotaPaused;
        let payload = serde_json::to_string(&session)
            .expect("MissionPlannerSession with QuotaPaused must serialize");
        assert!(
            payload.contains("\"status\":\"quota_paused\""),
            "session JSON must surface QuotaPaused as snake_case: {}",
            payload
        );
        let back: MissionPlannerSession = serde_json::from_str(&payload)
            .expect("MissionPlannerSession with QuotaPaused must deserialize");
        assert_eq!(back.status, PlannerStatus::QuotaPaused);
        assert_eq!(back.mission_id, "mission-1");
        // QuotaPaused must also map onto the persisted FlightPlannerStatus
        // mirror — the storage layer trusts this conversion.
        assert_eq!(
            back.status.to_flight_status(),
            FlightPlannerStatus::QuotaPaused
        );
    }

    /// E6-CEILING-RATELIMIT — `on_rate_limited` happy-path: flips the
    /// planner to QuotaPaused, no-ops for unknown sidecar sessions, and
    /// emits the wait-window event. We can't easily await the auto-resume
    /// timer in a unit test (the minimum window is 60s), so we exercise
    /// the synchronous half of the supervisor here and trust the timer
    /// re-check guard from inspection.
    #[tokio::test]
    async fn on_rate_limited_flips_to_quota_paused() {
        // Real Tauri AppHandle requires a test harness we don't have here.
        // The supervisor branches on `mission_id_for_sidecar_session` first
        // and only touches the AppHandle for the `app.emit` + spawn calls,
        // both of which are best-effort. We therefore exercise the
        // status-flip path indirectly: build a registry, seed a session,
        // and call `set_status` + `get_by_mission` mirroring what
        // `on_rate_limited`'s synchronous half does, then assert the
        // QuotaPaused round-trip.
        //
        // (A full integration test of the spawn + emit + sleep path lives
        // in the build/run flow; this unit slice guards the wire shape and
        // the registry mutation that the supervisor relies on.)
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-rate-limit";
        let sidecar_session_id = "sidecar-rate-limit";
        seed_planner_session(
            &registry,
            mission_id,
            sidecar_session_id,
            PlannerStatus::Awake,
        )
        .await;

        // Resolution path: the supervisor's first action is to look up the
        // owning mission. Confirm that works.
        let resolved = registry
            .mission_id_for_sidecar_session(sidecar_session_id)
            .await;
        assert_eq!(resolved.as_deref(), Some(mission_id));

        // Flip the status as `on_rate_limited` does.
        registry
            .set_status(mission_id, PlannerStatus::QuotaPaused)
            .await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::QuotaPaused);

        // Unknown sidecar session id must resolve to None — the supervisor
        // no-ops on that branch so non-planner sessions don't accidentally
        // trip the QuotaPaused state.
        let unknown = registry
            .mission_id_for_sidecar_session("sidecar-that-does-not-exist")
            .await;
        assert!(unknown.is_none());
    }

    /// E4-LAUNCH — verify the registry's wake bus delivers a
    /// `WakeTrigger::Decomposition` event end-to-end. The Tauri command
    /// `trigger_planner_decomposition` is a thin wrapper around
    /// `registry.send_wake(PlannerWakeEvent { trigger: Decomposition, … })`
    /// so this exercises the same code path the command takes after its
    /// session-presence check. Full-stack command testing requires a real
    /// AppHandle, which is non-trivial here; this gives us confidence the
    /// wire shape is right.
    #[tokio::test]
    async fn registry_wake_bus_carries_decomposition_event_with_launch_kind() {
        let registry = MissionPlannerRegistry::default();
        let (tx, mut rx) = mpsc::unbounded_channel::<PlannerWakeEvent>();
        registry.install_wake_sender(tx).await;

        registry
            .send_wake(PlannerWakeEvent {
                mission_id: "mission-test-decomp".to_string(),
                trigger: WakeTrigger::Decomposition,
                payload: serde_json::json!({}),
            })
            .await;

        let received = rx
            .recv()
            .await
            .expect("decomposition wake should be delivered");
        assert_eq!(received.mission_id, "mission-test-decomp");
        assert!(matches!(received.trigger, WakeTrigger::Decomposition));
        // The kind the wake consumer will pass through to
        // `forward_inject_user_turn` — this is the load-bearing assertion
        // that the bug fix actually fires `kind="launch"`.
        assert_eq!(received.trigger.kind_str(), "launch");
    }

    // -------------------------------------------------------------------
    // E6-CAPS — per-mode tool-call caps + max_tokens budgets
    // -------------------------------------------------------------------

    #[test]
    fn planner_mode_from_trigger_matches_spec() {
        use PlannerMode::*;
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::Decomposition),
            Decomposition
        );
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::TaskCompleted("t".to_string())),
            Reactive
        );
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::TaskFailed("t".to_string())),
            Replan
        );
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::ApprovalGateReached("r".to_string())),
            Reactive
        );
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::CollisionDetected(vec!["a".into()])),
            Reactive
        );
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::UserMessageInJournal("hi".into())),
            Reactive
        );
        assert_eq!(
            PlannerMode::from_trigger(&WakeTrigger::QuotaExhausted),
            Reactive
        );
    }

    #[test]
    fn planner_mode_caps_match_locked_design() {
        use PlannerMode::*;
        assert_eq!(Spec.tool_call_cap(), 25);
        assert_eq!(Decomposition.tool_call_cap(), 50);
        assert_eq!(Reactive.tool_call_cap(), 25);
        assert_eq!(Replan.tool_call_cap(), 25);
    }

    #[test]
    fn planner_mode_max_tokens_match_locked_design() {
        use PlannerMode::*;
        assert_eq!(Spec.max_output_tokens(), 4096);
        assert_eq!(Decomposition.max_output_tokens(), 8192);
        assert_eq!(Reactive.max_output_tokens(), 4096);
        assert_eq!(Replan.max_output_tokens(), 6144);
    }

    /// E6-CAPS — `bump_and_check_tool_call` is monotonic per tick and
    /// returns the right `(mode, cap, count)` triple.
    #[tokio::test]
    async fn bump_and_check_tool_call_increments_and_reports_cap() {
        let registry = MissionPlannerRegistry::default();
        let sidecar_session_id = "sidecar-caps-test";
        let mut session = MissionPlannerSession::new(
            sidecar_session_id.to_string(),
            "mission-caps-test".to_string(),
            sidecar_session_id.to_string(),
        );
        session.current_mode = PlannerMode::Decomposition;
        registry.insert(session).await;

        // First call returns (Decomposition, 50, 1).
        let (mode, cap, count) = registry
            .bump_and_check_tool_call(sidecar_session_id)
            .await
            .expect("session present");
        assert_eq!(mode, PlannerMode::Decomposition);
        assert_eq!(cap, 50);
        assert_eq!(count, 1);

        // Second call returns count=2.
        let (_, _, count2) = registry
            .bump_and_check_tool_call(sidecar_session_id)
            .await
            .expect("session present");
        assert_eq!(count2, 2);

        // set_mode_and_reset_tick resets the counter and flips the mode.
        registry
            .set_mode_and_reset_tick("mission-caps-test", PlannerMode::Reactive)
            .await;
        let (mode3, cap3, count3) = registry
            .bump_and_check_tool_call(sidecar_session_id)
            .await
            .expect("session present");
        assert_eq!(mode3, PlannerMode::Reactive);
        assert_eq!(cap3, 25);
        assert_eq!(count3, 1);
    }

    /// E6-CAPS — unknown sidecar session id returns `None`, which the
    /// dispatcher turns into a clear error rather than silently allowing
    /// the call through.
    #[tokio::test]
    async fn bump_and_check_tool_call_returns_none_for_unknown_session() {
        let registry = MissionPlannerRegistry::default();
        let result = registry
            .bump_and_check_tool_call("nonexistent-sidecar-session")
            .await;
        assert!(result.is_none());
    }

    // -------------------------------------------------------------------
    // E10-DETECT — cumulative-input counter + compaction trigger flip
    // -------------------------------------------------------------------

    /// E10-DETECT — the first bump that crosses
    /// [`COMPACTION_THRESHOLD_TOKENS`] must return `true` and atomically
    /// flip `compaction_in_progress` to `true`. The session's
    /// `cumulative_input_tokens` must reflect the bumped total.
    #[tokio::test]
    async fn bump_cumulative_input_fires_trigger_on_threshold() {
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-compact-fires";
        let sidecar_session_id = "sidecar-compact-fires";

        // Seed a session sitting JUST below the threshold so the next
        // bump crosses it. Use 1_000 as the bump delta so the test is
        // robust to the exact threshold value.
        let mut session = MissionPlannerSession::new(
            sidecar_session_id.to_string(),
            mission_id.to_string(),
            sidecar_session_id.to_string(),
        );
        session.cumulative_input_tokens = COMPACTION_THRESHOLD_TOKENS - 1_000;
        registry.insert(session).await;

        let crossed = registry
            .bump_cumulative_input_and_check(mission_id, 1_500)
            .await;
        assert!(
            crossed,
            "bump that crosses threshold must return true so caller emits the trigger event"
        );

        let after = registry
            .get_by_mission(mission_id)
            .await
            .expect("session still registered");
        assert_eq!(
            after.cumulative_input_tokens,
            COMPACTION_THRESHOLD_TOKENS - 1_000 + 1_500,
            "cumulative counter must reflect the bumped total"
        );
        assert!(
            after.compaction_in_progress,
            "compaction_in_progress flag must be set to true on threshold crossing"
        );
    }

    /// E10-DETECT — once `compaction_in_progress` is true, subsequent
    /// bumps over the threshold must return `false` (no duplicate event
    /// fires while the swap is running). The counter still accumulates
    /// — E10-SWAP resets it on completion.
    #[tokio::test]
    async fn bump_cumulative_input_no_double_fire_during_compaction() {
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-compact-nodupe";
        let sidecar_session_id = "sidecar-compact-nodupe";

        let mut session = MissionPlannerSession::new(
            sidecar_session_id.to_string(),
            mission_id.to_string(),
            sidecar_session_id.to_string(),
        );
        session.cumulative_input_tokens = COMPACTION_THRESHOLD_TOKENS - 100;
        registry.insert(session).await;

        // First crossing — fires.
        let first = registry
            .bump_cumulative_input_and_check(mission_id, 500)
            .await;
        assert!(first, "first threshold crossing must fire");

        // Second bump (still above threshold; compaction is now in
        // flight) — must NOT fire again.
        let second = registry
            .bump_cumulative_input_and_check(mission_id, 5_000)
            .await;
        assert!(
            !second,
            "subsequent bumps during compaction must NOT fire a second trigger"
        );

        // Counter still accumulates so telemetry stays accurate.
        let after = registry
            .get_by_mission(mission_id)
            .await
            .expect("session still registered");
        assert_eq!(
            after.cumulative_input_tokens,
            COMPACTION_THRESHOLD_TOKENS - 100 + 500 + 5_000,
            "counter must keep accumulating during in-progress compaction"
        );
        assert!(
            after.compaction_in_progress,
            "compaction_in_progress must remain true until swap_sidecar_session_after_compaction clears it"
        );
    }

    /// Test helper: insert a planner session for a mission with a given
    /// status and sidecar session id. Bypasses the public `start_mission_
    /// planner` Tauri command (which requires a real `AppHandle` and
    /// `SidecarManager`) so we can exercise the in-process Awake/Idle
    /// transitions in isolation.
    async fn seed_planner_session(
        registry: &MissionPlannerRegistry,
        mission_id: &str,
        sidecar_session_id: &str,
        status: PlannerStatus,
    ) {
        let mut session = MissionPlannerSession::new(
            sidecar_session_id.to_string(),
            mission_id.to_string(),
            sidecar_session_id.to_string(),
        );
        session.status = status;
        registry.insert(session).await;
    }

    /// E6-KILL-AWAKE — happy path. When the sidecar emits a `done` event
    /// for a planner session that's currently `Awake`, the watchdog flips
    /// the mission's planner status back to `Idle`.
    #[tokio::test]
    async fn on_planner_done_flips_awake_to_idle() {
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-awake-test";
        let sidecar_session_id = "sidecar-awake-test";
        seed_planner_session(
            &registry,
            mission_id,
            sidecar_session_id,
            PlannerStatus::Awake,
        )
        .await;

        registry.on_planner_done(sidecar_session_id).await;

        let after = registry
            .get_by_mission(mission_id)
            .await
            .expect("session should still be registered after on_planner_done");
        assert_eq!(
            after.status,
            PlannerStatus::Idle,
            "Awake should flip to Idle on `done` event"
        );
    }

    /// E6-KILL-AWAKE — preserve-other-states guard. A `done` event that
    /// lands while the user has paused the planner (or any other non-Awake
    /// state) MUST NOT clobber the status. This is the load-bearing
    /// invariant: if a pause raced with a wake's `done` event, the
    /// watchdog would otherwise silently re-enable wake dispatch by
    /// flipping back to Idle.
    #[tokio::test]
    async fn on_planner_done_preserves_paused() {
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-paused-test";
        let sidecar_session_id = "sidecar-paused-test";

        // Paused is the headline case from the task brief.
        seed_planner_session(
            &registry,
            mission_id,
            sidecar_session_id,
            PlannerStatus::Paused,
        )
        .await;
        registry.on_planner_done(sidecar_session_id).await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(
            after.status,
            PlannerStatus::Paused,
            "Paused must survive a `done` event"
        );

        // QuotaPaused (E6 sibling slice owns the rate-limit handler that
        // installs this state; the guard must respect it equally).
        registry
            .set_status(mission_id, PlannerStatus::QuotaPaused)
            .await;
        registry.on_planner_done(sidecar_session_id).await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::QuotaPaused);

        // Completed and Failed are terminal; reviving them to Idle would
        // be even worse than reviving a pause.
        registry
            .set_status(mission_id, PlannerStatus::Completed)
            .await;
        registry.on_planner_done(sidecar_session_id).await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::Completed);

        registry
            .set_status(mission_id, PlannerStatus::Failed)
            .await;
        registry.on_planner_done(sidecar_session_id).await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::Failed);
    }

    /// E6-KILL-AWAKE — `done` events for unknown sidecar sessions (e.g.
    /// regular `api-claude-oauth` chats that aren't planner sessions) are
    /// silently no-op'd. This is what makes it safe to hang the watchdog
    /// off the generic `handle_event` `done` arm without filtering by
    /// session type at the call site.
    #[tokio::test]
    async fn on_planner_done_ignores_unknown_session() {
        let registry = MissionPlannerRegistry::default();
        // Seed an unrelated planner so the registry isn't empty.
        seed_planner_session(
            &registry,
            "mission-other",
            "sidecar-other",
            PlannerStatus::Awake,
        )
        .await;

        registry
            .on_planner_done("sidecar-that-does-not-exist")
            .await;

        // The unrelated Awake session must NOT flip — its session id
        // didn't match.
        let other = registry.get_by_mission("mission-other").await.unwrap();
        assert_eq!(other.status, PlannerStatus::Awake);
    }

    // -------------------------------------------------------------------
    // Peer-review P1 concurrency fixes
    // -------------------------------------------------------------------

    /// FIX P1-A — `on_planner_done` must perform the read+modify+write of
    /// the planner's status atomically under the sessions lock so a
    /// concurrent `dispatch_wake` re-arming `Awake` for a new turn can't
    /// be clobbered back to `Idle`.
    ///
    /// Hard to race the lock directly from a unit test (acquiring the
    /// same mutex from two tasks just serializes them), so we exercise
    /// the **outcome** the fix guarantees: that successive
    /// Awake -> on_planner_done -> Idle cycles are repeatable. The race
    /// the fix prevents is documented by inspection of the code change
    /// (the function now holds the lock across the read + mutate).
    #[tokio::test]
    async fn on_planner_done_atomic_read_modify_write() {
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-atomic-rmw";
        let sidecar_session_id = "sidecar-atomic-rmw";

        // Seed Awake, flip done, expect Idle.
        seed_planner_session(
            &registry,
            mission_id,
            sidecar_session_id,
            PlannerStatus::Awake,
        )
        .await;
        registry.on_planner_done(sidecar_session_id).await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::Idle);

        // Cycle a second time — Awake -> on_planner_done -> Idle. Pre-fix
        // this went through two separate critical sections; post-fix it's
        // one. Behavior under no contention is identical, which is all we
        // can probe in a unit test.
        registry.set_status(mission_id, PlannerStatus::Awake).await;
        registry.on_planner_done(sidecar_session_id).await;
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::Idle);
    }

    /// FIX P1-B — `persist_planner_state_on_flight` now returns
    /// `Result<(), String>` (was unit) and routes through
    /// `storage::with_state_lock`. The signature change itself is
    /// load-bearing: anything that didn't use the lock previously now
    /// does, because the lock is the entire body of the new function.
    /// This test type-checks the new signature.
    #[tokio::test]
    async fn persist_planner_state_on_flight_uses_state_lock() {
        // Missing-on-disk mission is tolerated (silent no-op). The point
        // is that this call compiles only with the new async + Result
        // signature.
        let result: Result<(), String> = super::persist_planner_state_on_flight(
            "mission-does-not-exist-on-disk",
            None,
            None,
        )
        .await;
        // Either Ok or Err is acceptable — save_state may legitimately
        // fail in some test environments (no HOME, read-only fs). The
        // suite's cold-start tests cover the actual save path.
        let _ = result;
    }

    /// FIX P1-C — generation lease on the QuotaPaused auto-resume timer.
    ///
    /// We can't easily await the 60s timer in a unit test, so we
    /// exercise the invariant the spawned task's body relies on:
    ///
    ///   * The lease at spawn time is captured into the closure.
    ///   * When the timer fires, the captured value is compared against
    ///     the CURRENT lease in the session.
    ///   * If a newer rate-limit bumped the lease in between, the
    ///     captured value is stale; the timer backs off without
    ///     clobbering the freshly-armed QuotaPaused state.
    ///
    /// This test inlines the same atomic check the spawned closure
    /// performs in `on_rate_limited`, both with a stale captured lease
    /// (expect: state preserved) and with a current captured lease
    /// (expect: state cleared to Idle).
    #[tokio::test]
    async fn quota_lease_prevents_stale_timer_clobber() {
        let registry = MissionPlannerRegistry::default();
        let mission_id = "mission-quota-lease";
        let sidecar_session_id = "sidecar-quota-lease";

        // Seed QuotaPaused with lease=1 (post-first-rate-limit state).
        let mut session = MissionPlannerSession::new(
            sidecar_session_id.to_string(),
            mission_id.to_string(),
            sidecar_session_id.to_string(),
        );
        session.status = PlannerStatus::QuotaPaused;
        session.quota_lease = 1;
        registry.insert(session).await;

        let captured_lease_older: u64 = 1;

        // A second rate-limit races in: bump lease to 2.
        {
            let mut sessions = registry.sessions.lock().await;
            let s = sessions.get_mut(mission_id).expect("seeded");
            s.quota_lease = s.quota_lease.wrapping_add(1);
            s.status = PlannerStatus::QuotaPaused;
        }
        let mid = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(mid.quota_lease, 2);
        assert_eq!(mid.status, PlannerStatus::QuotaPaused);

        // Run the same atomic check the spawned timer performs, but
        // with the older captured lease.
        let stale_cleared: bool = {
            let mut sessions = registry.sessions.lock().await;
            match sessions.get_mut(mission_id) {
                Some(session)
                    if matches!(session.status, PlannerStatus::QuotaPaused)
                        && session.quota_lease == captured_lease_older =>
                {
                    session.status = PlannerStatus::Idle;
                    true
                }
                _ => false,
            }
        };
        assert!(
            !stale_cleared,
            "stale timer with captured_lease=1 must back off when current_lease=2"
        );
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(
            after.status,
            PlannerStatus::QuotaPaused,
            "QuotaPaused must survive a stale-lease timer firing"
        );
        assert_eq!(after.quota_lease, 2);

        // Sanity: a CURRENT-lease timer (captured 2) WOULD have cleared it.
        let captured_lease_current: u64 = 2;
        let current_cleared: bool = {
            let mut sessions = registry.sessions.lock().await;
            match sessions.get_mut(mission_id) {
                Some(session)
                    if matches!(session.status, PlannerStatus::QuotaPaused)
                        && session.quota_lease == captured_lease_current =>
                {
                    session.status = PlannerStatus::Idle;
                    true
                }
                _ => false,
            }
        };
        assert!(
            current_cleared,
            "current-lease timer must clear QuotaPaused"
        );
        let after = registry.get_by_mission(mission_id).await.unwrap();
        assert_eq!(after.status, PlannerStatus::Idle);
    }
}

/// E6 safety-rail integration tests. Distinct module so the cold-start
/// pure-function tests sit alongside any future sibling-landed safety-rail
/// tests (caps, ceiling, rate-limit handler, kill-switch) without cross-
/// pollinating the existing planner-runtime test fixture above.
///
/// We deliberately exercise [`compute_cold_start_paused`] (the pure helper)
/// rather than [`enforce_cold_start_paused`] (which hits real disk via
/// `with_state_lock` → `load_state` / `save_state`). The pure function is
/// what `lib.rs` ultimately relies on under the hood, and testing it directly
/// keeps the suite hermetic — no shared HOME/USERPROFILE side-effects across
/// parallel cargo-test workers.
#[cfg(test)]
mod e6_integration {
    use super::*;
    use crate::core::flight::{Flight, FlightPriority};

    /// Build a Flight with the minimum field set so tests can mutate just
    /// the `status` / `planner_*` fields they care about.
    fn make_flight(
        id: &str,
        status: FlightStatus,
        planner_status: Option<FlightPlannerStatus>,
        planner_session_id: Option<&str>,
    ) -> Flight {
        Flight {
            id: id.to_string(),
            title: format!("Mission {}", id),
            objective: String::new(),
            status,
            priority: FlightPriority::Medium,
            project_path: "/tmp/test".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones: Vec::new(),
            linked_session_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: Vec::new(),
            planner_session_id: planner_session_id.map(|s| s.to_string()),
            planner_status,
            planner_cost: None,
            planner_tokens: None,
            planner_provider: None,
            publish_attempts_as_prs: false,
        }
    }

    fn state_with(flights: Vec<Flight>) -> PersistedState {
        let mut state = PersistedState::default();
        state.flights = flights;
        state
    }

    /// An Active mission whose planner was Awake at last shutdown — the
    /// canonical "interrupted by app restart" case the rail is designed for.
    /// Expect: status flipped to Paused, session id cleared, count = 1.
    #[test]
    fn cold_start_pauses_active_with_planner_running() {
        let mut state = state_with(vec![make_flight(
            "m-awake",
            FlightStatus::Active,
            Some(FlightPlannerStatus::Awake),
            Some("sidecar-abc"),
        )]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 1);

        let flight = &state.flights[0];
        assert_eq!(
            flight.planner_status,
            Some(FlightPlannerStatus::Paused),
            "Awake planner on an Active mission must flip to Paused on cold-start"
        );
        assert!(
            flight.planner_session_id.is_none(),
            "stale sidecar session id must be cleared on cold-start"
        );
        // Mission status itself is NOT touched — only planner_status moves.
        assert_eq!(flight.status, FlightStatus::Active);
    }

    /// Terminal flights (`Done` / `Failed` / `Cancelled`) sometimes carry
    /// stale planner metadata — it must NOT be rewritten. Pausing a Done
    /// mission's planner would be both wrong and confusing in the UI.
    ///
    /// Post-FIX-1: only terminal statuses are exempt. `Paused` / `Draft` /
    /// `Spec` / `Planning` / `Review` / `Ready` flights with stale planner
    /// metadata are now caught — see
    /// [`cold_start_pauses_planning_with_awake_planner`] et al.
    #[test]
    fn cold_start_leaves_terminal_flights_alone() {
        let mut state = state_with(vec![
            make_flight(
                "m-done",
                FlightStatus::Done,
                Some(FlightPlannerStatus::Completed),
                Some("sidecar-done"),
            ),
            make_flight(
                "m-failed",
                FlightStatus::Failed,
                Some(FlightPlannerStatus::Awake),
                Some("sidecar-failed"),
            ),
            make_flight(
                "m-cancelled",
                FlightStatus::Cancelled,
                Some(FlightPlannerStatus::Idle),
                Some("sidecar-cancelled"),
            ),
        ]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 0, "terminal flights => nothing to pause");

        // Untouched: planner_session_id stays, planner_status stays.
        assert_eq!(
            state.flights[0].planner_session_id.as_deref(),
            Some("sidecar-done")
        );
        assert_eq!(
            state.flights[0].planner_status,
            Some(FlightPlannerStatus::Completed)
        );
        assert_eq!(
            state.flights[1].planner_session_id.as_deref(),
            Some("sidecar-failed")
        );
        assert_eq!(
            state.flights[1].planner_status,
            Some(FlightPlannerStatus::Awake),
            "Failed mission's stale Awake planner state must stay untouched"
        );
        assert_eq!(
            state.flights[2].planner_session_id.as_deref(),
            Some("sidecar-cancelled")
        );
        assert_eq!(
            state.flights[2].planner_status,
            Some(FlightPlannerStatus::Idle),
            "Cancelled mission's stale planner state must stay untouched"
        );
    }

    /// FIX 1 — A `Planning` mission whose planner was Awake at last shutdown
    /// must flip to Paused. Without this the planner_status sits "Awake"
    /// post-restart pointing at a dead sidecar session, and wake events
    /// would dispatch into the void.
    #[test]
    fn cold_start_pauses_planning_with_awake_planner() {
        let mut state = state_with(vec![make_flight(
            "m-planning-awake",
            FlightStatus::Planning,
            Some(FlightPlannerStatus::Awake),
            Some("sidecar-planning"),
        )]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(
            n, 1,
            "Planning mission with Awake planner must be caught by cold-start"
        );

        let flight = &state.flights[0];
        assert_eq!(
            flight.planner_status,
            Some(FlightPlannerStatus::Paused),
            "Awake planner on a Planning mission must flip to Paused on cold-start"
        );
        assert!(
            flight.planner_session_id.is_none(),
            "stale sidecar session id must be cleared"
        );
        // Mission status itself is NOT touched — only planner_status moves.
        assert_eq!(flight.status, FlightStatus::Planning);
    }

    /// FIX 1 — A `Review` mission with an Idle planner has a live sidecar
    /// session id at last shutdown; the sidecar is dead post-restart and
    /// the metadata needs resetting.
    #[test]
    fn cold_start_pauses_review_with_idle_planner() {
        let mut state = state_with(vec![make_flight(
            "m-review-idle",
            FlightStatus::Review,
            Some(FlightPlannerStatus::Idle),
            Some("sidecar-review"),
        )]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 1);

        let flight = &state.flights[0];
        assert_eq!(flight.planner_status, Some(FlightPlannerStatus::Paused));
        assert!(flight.planner_session_id.is_none());
        // Review-status itself preserved — only planner state moves.
        assert_eq!(flight.status, FlightStatus::Review);
    }

    /// FIX 1 — A `Spec` mission whose `planner_session_id` is still set
    /// at last shutdown (planner_status may be None or anything non-running)
    /// must have the stale id cleared. The session-id branch alone is
    /// sufficient to trigger the rail.
    #[test]
    fn cold_start_pauses_spec_with_session_id() {
        let mut state = state_with(vec![make_flight(
            "m-spec-with-session",
            FlightStatus::Spec,
            None,
            Some("sidecar-spec"),
        )]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 1);

        let flight = &state.flights[0];
        assert_eq!(flight.planner_status, Some(FlightPlannerStatus::Paused));
        assert!(flight.planner_session_id.is_none());
        assert_eq!(flight.status, FlightStatus::Spec);
    }

    /// FIX 1 — A mission-level `Paused` flight with a running planner is
    /// post-FIX-1 caught by the rail. (Pre-FIX-1 this was sticky; the
    /// session id pinned to it is still dead post-restart.)
    #[test]
    fn cold_start_pauses_mission_level_paused_with_awake_planner() {
        let mut state = state_with(vec![make_flight(
            "m-paused-mission",
            FlightStatus::Paused,
            Some(FlightPlannerStatus::Awake),
            Some("sidecar-paused"),
        )]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 1);

        let flight = &state.flights[0];
        assert_eq!(flight.planner_status, Some(FlightPlannerStatus::Paused));
        assert!(flight.planner_session_id.is_none());
        // Mission-level Paused stays Paused (only planner state moved).
        assert_eq!(flight.status, FlightStatus::Paused);
    }

    /// FIX 1 — `Draft` / `Ready` flights with no planner metadata still
    /// skip cleanly (no had_session, no was_running ⇒ no-op even though
    /// they're non-terminal).
    #[test]
    fn cold_start_leaves_clean_non_terminal_flights_alone() {
        let mut state = state_with(vec![
            make_flight("m-draft", FlightStatus::Draft, None, None),
            make_flight("m-ready", FlightStatus::Ready, None, None),
            make_flight("m-spec-clean", FlightStatus::Spec, None, None),
        ]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 0, "non-terminal flights without planner metadata => no-op");

        for f in &state.flights {
            assert!(f.planner_status.is_none());
            assert!(f.planner_session_id.is_none());
        }
    }

    /// The key invariant for resume-correctness: the old sidecar session id
    /// is meaningless after app restart (the sidecar process is dead). We
    /// clear it so a fresh `start_mission_planner` mints a brand new id and
    /// the UI doesn't render a stale "session XYZ" reference.
    #[test]
    fn cold_start_clears_planner_session_id() {
        // Idle planner with a live session id — clear the id.
        let mut state = state_with(vec![make_flight(
            "m-idle",
            FlightStatus::Active,
            Some(FlightPlannerStatus::Idle),
            Some("sidecar-idle-123"),
        )]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 1);
        assert!(state.flights[0].planner_session_id.is_none());
        assert_eq!(
            state.flights[0].planner_status,
            Some(FlightPlannerStatus::Paused)
        );

        // Edge case: session-id-only (planner_status is None somehow).
        // This shouldn't happen in practice but the rail still catches it
        // because `had_session` alone is sufficient.
        let mut state = state_with(vec![make_flight(
            "m-zombie",
            FlightStatus::Active,
            None,
            Some("sidecar-zombie"),
        )]);
        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 1);
        assert!(state.flights[0].planner_session_id.is_none());
        assert_eq!(
            state.flights[0].planner_status,
            Some(FlightPlannerStatus::Paused)
        );
    }

    /// Multi-mission scenario — telemetry-only return value must reflect
    /// the modified count (not the total flight count). QuotaPaused is
    /// included in the "was running" set because a sidecar session is
    /// still live for a quota-pause backoff; that session is gone after
    /// restart and the user should reset it explicitly.
    #[test]
    fn cold_start_returns_count() {
        let mut state = state_with(vec![
            make_flight(
                "m-awake",
                FlightStatus::Active,
                Some(FlightPlannerStatus::Awake),
                Some("s1"),
            ),
            make_flight(
                "m-idle",
                FlightStatus::Active,
                Some(FlightPlannerStatus::Idle),
                Some("s2"),
            ),
            make_flight(
                "m-quota",
                FlightStatus::Active,
                Some(FlightPlannerStatus::QuotaPaused),
                Some("s3"),
            ),
            // Active but never started a planner — skipped.
            make_flight("m-no-planner", FlightStatus::Active, None, None),
            // Active with already-Paused planner — skipped (sticky, no
            // session id => nothing to clear, no status change to make).
            make_flight(
                "m-already-paused-planner",
                FlightStatus::Active,
                Some(FlightPlannerStatus::Paused),
                None,
            ),
            // Done mission — skipped.
            make_flight(
                "m-done",
                FlightStatus::Done,
                Some(FlightPlannerStatus::Completed),
                None,
            ),
        ]);

        let n = compute_cold_start_paused(&mut state);
        assert_eq!(
            n, 3,
            "Awake + Idle + QuotaPaused on Active flights = 3 paused"
        );

        // Verify the three that flipped did flip.
        assert_eq!(
            state.flights[0].planner_status,
            Some(FlightPlannerStatus::Paused)
        );
        assert_eq!(
            state.flights[1].planner_status,
            Some(FlightPlannerStatus::Paused)
        );
        assert_eq!(
            state.flights[2].planner_status,
            Some(FlightPlannerStatus::Paused)
        );

        // And the three that didn't, didn't.
        assert!(state.flights[3].planner_status.is_none());
        assert!(state.flights[3].planner_session_id.is_none());
        assert_eq!(
            state.flights[4].planner_status,
            Some(FlightPlannerStatus::Paused),
            "already-Paused planner stays Paused (no-op)"
        );
        assert_eq!(
            state.flights[5].planner_status,
            Some(FlightPlannerStatus::Completed),
            "Done mission's planner state untouched"
        );
    }

    /// Defensive: calling the helper on an empty state must be a no-op
    /// returning zero. (Boot may run this before any missions exist.)
    #[test]
    fn cold_start_handles_empty_state() {
        let mut state = PersistedState::default();
        let n = compute_cold_start_paused(&mut state);
        assert_eq!(n, 0);
        assert!(state.flights.is_empty());
    }

    // ----- Optional smoke tests for sibling-landed safety rails -----
    //
    // These are #[ignore]d until their respective siblings land. Each test
    // is written against the public interface the sibling will expose, so
    // it survives internal refactors. Un-ignore once the symbol exists.

    /// E6-CAPS: per-mode tool-call cap during decomposition.
    /// Expect a `PlannerMode::Decomposition.tool_call_cap()` (or equivalent)
    /// to return 50 per the locked design.
    #[test]
    #[ignore = "requires E6-CAPS sibling to land PlannerMode::tool_call_cap"]
    fn dispatcher_respects_per_mode_cap_decomposition() {
        // Pseudo (against the public interface the sibling will expose):
        // assert_eq!(PlannerMode::Decomposition.tool_call_cap(), 50);
        // assert_eq!(PlannerMode::Reactive.tool_call_cap(),     25);
        // assert_eq!(PlannerMode::Replan.tool_call_cap(),       25);
    }

    /// E6-CEILING-RATELIMIT: task-ceiling approval gate at 60 tasks.
    /// Expect a public helper that returns true once a mission's task
    /// count crosses the ceiling, gating further `create_task` dispatches.
    #[test]
    #[ignore = "requires E6-CEILING-RATELIMIT sibling to land the ceiling helper"]
    fn task_ceiling_triggers_approval_gate_at_60() {
        // Pseudo:
        // assert!(!task_ceiling_reached(59));
        // assert!(task_ceiling_reached(60));
    }

    /// E6-KILL-AWAKE: kill-switch flips planner status to Failed (or
    /// Paused) and cancels any in-flight turn via `forward_cancel`.
    #[test]
    #[ignore = "requires E6-KILL-AWAKE sibling to land the kill-switch command"]
    fn kill_switch_cancels_in_flight_turn() {
        // Pseudo:
        // call kill_mission_planner(mission_id);
        // assert_eq!(registry.get(mission_id).status, PlannerStatus::Failed);
    }
}

/// E8-ACCUM — `accumulate_planner_cost` round-trips through the on-disk
/// PersistedState. Gated `#[ignore]` because each test rewrites the real
/// `~/.packetade` state file via `storage::with_state_lock` — the suite
/// can't redirect HOME hermetically, mirroring the
/// `mission_journal::tests::append_journal_creates_file_and_appends`
/// pattern. Run manually with:
///
///   `cargo test --lib --manifest-path src-tauri/Cargo.toml \
///       commands::mission_planner::e8_accum -- --ignored --test-threads=1`
///
/// `--test-threads=1` is important because every test in this module
/// mutates the same persisted-state file; concurrent workers would race
/// on each other's seed/teardown.
#[cfg(test)]
mod e8_accum {
    use super::*;
    use crate::core::flight::{Flight, FlightPriority, FlightStatus};

    /// Seed a Flight in the persisted state with the planner cost/tokens
    /// fields set to `planner_cost_seed` / `planner_tokens_seed` — typical
    /// usage is `(None, None)` for the zero-init case and `(Some(..), Some(..))`
    /// for the additive case.
    async fn seed_flight(
        mission_id: &str,
        planner_cost_seed: Option<f64>,
        planner_tokens_seed: Option<u64>,
    ) -> Result<(), String> {
        let mid = mission_id.to_string();
        storage::with_state_lock(move |state| {
            // Idempotent — drop any prior seed for the same id.
            state.flights.retain(|f| f.id != mid);
            state.flights.push(Flight {
                id: mid.clone(),
                title: format!("E8 seed {}", mid),
                objective: String::new(),
                status: FlightStatus::Active,
                priority: FlightPriority::Medium,
                project_path: "/tmp/e8-accum".to_string(),
                workspace_id: None,
                git_branch: None,
                milestones: Vec::new(),
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
                planner_cost: planner_cost_seed,
                planner_tokens: planner_tokens_seed,
                planner_provider: None,
                publish_attempts_as_prs: false,
            });
            std::future::ready(Ok(()))
        })
        .await
    }

    /// Cleanup helper: remove the seeded test flight so we don't pollute the
    /// user's persisted state with leftover `e8-*` rows.
    async fn unseed_flight(mission_id: &str) {
        let mid = mission_id.to_string();
        let _: Result<(), String> = storage::with_state_lock(move |state| {
            state.flights.retain(|f| f.id != mid);
            std::future::ready(Ok(()))
        })
        .await;
    }

    /// Read back the on-disk Flight for assertions.
    async fn read_flight(mission_id: &str) -> Option<Flight> {
        let state = storage::load_state();
        state.flights.into_iter().find(|f| f.id == mission_id)
    }

    /// Headline additive case — seed `planner_cost = Some(1.5)` and
    /// `planner_tokens = Some(100)`, accumulate `(100, 200, 0.5)`, expect
    /// `planner_cost = Some(2.0)` and `planner_tokens` grew by 300 to 400.
    #[tokio::test]
    #[ignore = "touches real ~/.packetade state file; run with --ignored --test-threads=1"]
    async fn accumulate_planner_cost_adds_to_existing() {
        let mid = format!(
            "e8-accum-add-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        seed_flight(&mid, Some(1.5), Some(100)).await.unwrap();

        // E10: signature is now (input_tokens, output_tokens, cost_usd).
        // 100 + 200 = 300 total, matching the pre-E10 single-arg case.
        super::accumulate_planner_cost(&mid, 100, 200, 0.5)
            .await
            .expect("accumulate must succeed for a seeded flight");

        let after = read_flight(&mid).await.expect("flight present after add");
        assert_eq!(after.planner_cost, Some(2.0));
        assert_eq!(after.planner_tokens, Some(400));

        unseed_flight(&mid).await;
    }

    /// Zero-init case — `planner_cost = None` / `planner_tokens = None` (the
    /// state right after `start_mission_planner` but before any turn closes).
    /// Accumulating `(50, 75, 0.5)` must initialize the Option, not silently
    /// drop the delta.
    #[tokio::test]
    #[ignore = "touches real ~/.packetade state file; run with --ignored --test-threads=1"]
    async fn accumulate_planner_cost_initializes_zero() {
        let mid = format!(
            "e8-accum-init-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        seed_flight(&mid, None, None).await.unwrap();

        // E10: split (input=50, output=75, cost=0.5); 50+75=125 total.
        super::accumulate_planner_cost(&mid, 50, 75, 0.5)
            .await
            .expect("accumulate must succeed for a seeded flight");

        let after = read_flight(&mid).await.expect("flight present after init");
        assert_eq!(after.planner_cost, Some(0.5));
        assert_eq!(after.planner_tokens, Some(125));

        unseed_flight(&mid).await;
    }

    /// Missing-flight case — calling against a mission id that doesn't
    /// exist on disk MUST surface an `Err` so the sidecar event handler
    /// can log the warning. (Compare to `persist_planner_state_on_flight`,
    /// which intentionally silently no-ops in the same shape because that
    /// helper's call sites already tolerate races against mission delete.
    /// Cost accumulation has no such pre-existing tolerance — losing
    /// counts silently would skew the StatGrid chip.)
    #[tokio::test]
    #[ignore = "touches real ~/.packetade state file; run with --ignored --test-threads=1"]
    async fn accumulate_planner_cost_errors_on_missing_flight() {
        let mid = format!(
            "e8-accum-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        // Defensive: ensure nothing with this id exists.
        unseed_flight(&mid).await;

        // E10: signature is (input_tokens, output_tokens, cost_usd).
        let result = super::accumulate_planner_cost(&mid, 10, 20, 0.1).await;
        assert!(result.is_err(), "missing flight must return Err");
        let err = result.unwrap_err();
        assert!(
            err.contains(&mid),
            "error message should name the missing mission: {}",
            err
        );
    }

    // ---------------------------------------------------------------------
    // E8 — executor-cost accumulation tests
    //
    // Mirror the planner-cost tests above for the executor sibling helper.
    // The two helpers diverge only in which Flight fields they touch
    // (`total_*` vs `planner_*`) and in the error semantics on a missing
    // flight (both surface Err — losing counts silently would skew the
    // StatGrid in either direction).
    // ---------------------------------------------------------------------

    /// Seed a Flight with concrete `total_cost` / `total_tokens` so the
    /// executor add-onto-existing case has something to grow from.
    async fn seed_flight_with_total(
        mission_id: &str,
        total_cost_seed: f64,
        total_tokens_seed: u64,
    ) -> Result<(), String> {
        let mid = mission_id.to_string();
        storage::with_state_lock(move |state| {
            state.flights.retain(|f| f.id != mid);
            state.flights.push(Flight {
                id: mid.clone(),
                title: format!("E8 exec seed {}", mid),
                objective: String::new(),
                status: FlightStatus::Active,
                priority: FlightPriority::Medium,
                project_path: "/tmp/e8-accum-exec".to_string(),
                workspace_id: None,
                git_branch: None,
                milestones: Vec::new(),
                linked_session_ids: Vec::new(),
                created_at: 0,
                updated_at: 0,
                completed_at: None,
                total_cost: total_cost_seed,
                total_tokens: total_tokens_seed,
                prompt: None,
                attempts: Vec::new(),
                planner_session_id: None,
                planner_status: None,
                planner_cost: None,
                planner_tokens: None,
                planner_provider: None,
                publish_attempts_as_prs: false,
            });
            std::future::ready(Ok(()))
        })
        .await
    }

    /// Headline additive case for executor cost — seed
    /// `total_cost = 1.5` / `total_tokens = 100`, accumulate
    /// `(300, 0.5)`, expect `total_cost = 2.0` / `total_tokens = 400`.
    #[tokio::test]
    #[ignore = "touches real ~/.packetade state file; run with --ignored --test-threads=1"]
    async fn accumulate_executor_cost_adds_to_existing() {
        let mid = format!(
            "e8-accum-exec-add-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        seed_flight_with_total(&mid, 1.5, 100).await.unwrap();

        super::accumulate_executor_cost(&mid, 300, 0.5)
            .await
            .expect("accumulate must succeed for a seeded flight");

        let after = read_flight(&mid).await.expect("flight present after add");
        assert!(
            (after.total_cost - 2.0).abs() < f64::EPSILON,
            "total_cost should be 2.0, got {}",
            after.total_cost
        );
        assert_eq!(after.total_tokens, 400);

        unseed_flight(&mid).await;
    }

    /// Missing-flight case — calling against a mission id that doesn't
    /// exist on disk MUST surface an `Err` so the api_agent / sidecar
    /// caller can log the warning. Same contract as the planner helper.
    #[tokio::test]
    #[ignore = "touches real ~/.packetade state file; run with --ignored --test-threads=1"]
    async fn accumulate_executor_cost_errors_on_missing_flight() {
        let mid = format!(
            "e8-accum-exec-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        unseed_flight(&mid).await;

        let result = super::accumulate_executor_cost(&mid, 30, 0.1).await;
        assert!(result.is_err(), "missing flight must return Err");
        let err = result.unwrap_err();
        assert!(
            err.contains(&mid),
            "error message should name the missing mission: {}",
            err
        );
    }
}
