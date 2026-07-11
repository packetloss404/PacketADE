//! Flight Planner E8 — planner cost / token accumulation onto the Flight DTO.
//!
//! Extracted from `flight_planner.rs` as a "first cut" of the larger
//! refactor (the parent module was ~4.2K LoC). This sub-module owns:
//!
//!   * [`accumulate_planner_cost`] — roll up a planner-owned turn's
//!     `input + output` tokens and USD cost onto a Flight's
//!     `planner_tokens` / `planner_cost` fields.
//!
//! The executor money path (`accumulate_executor_cost`,
//! `ExecutorSessionOwner`, `flight_for_executor_session`) was carved out
//! into `flight_cost.rs` (C1-S2) so the live cost surface no longer depends
//! on this (dying) planner module. `accumulate_planner_cost` itself dies in
//! CLEAN-2 — the planner runtime is provably unreachable — so nothing new
//! should be added here.
//!
//! `accumulate_planner_cost` serializes through `storage::with_state_lock`
//! so parallel `turn_summary` events from a bursty sidecar can't race
//! each other or `persist_planner_state_on_flight`.

use tracing::warn;

use crate::commands::flight_planner::now_millis;
use crate::core::storage;

// ---------------------------------------------------------------------------
// E8 — planner cost / token accumulation
// ---------------------------------------------------------------------------

/// Accumulate one planner-owned turn's token and cost numbers onto the
/// Flight DTO's `planner_tokens` / `planner_cost` fields.
///
/// Called from `agent_sidecar::handle_event`'s `turn_summary` arm via the
/// `FlightPlannerRegistry` reverse-lookup: if the sidecar session that
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
///     flight, and we'd rather drop the accumulation than panic the
///     sidecar event loop.
///
/// Serialized through `storage::with_state_lock` so concurrent calls from
/// a bursty mid-turn `turn_summary` stream don't lose updates against
/// other persisted-state writers (e.g. `persist_planner_state_on_flight`).
pub async fn accumulate_planner_cost(
    flight_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: f64,
) -> Result<(), String> {
    let flight_id_owned = flight_id.to_string();
    let total_tokens = input_tokens.saturating_add(output_tokens);
    let result = storage::with_state_lock(move |state| {
        let flight_id = flight_id_owned.clone();
        let inner: Result<(), String> = (|| {
            let Some(flight) = state.flights.iter_mut().find(|f| f.id == flight_id) else {
                return Err(format!("flight not found: {}", flight_id));
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
        warn!(error = %e, flight_id, "failed to accumulate planner cost on flight");
    }
    result
}

/// E8-ACCUM — `accumulate_planner_cost` round-trips through the on-disk
/// PersistedState. Gated `#[ignore]` because each test rewrites the real
/// `~/.packetade` state file via `storage::with_state_lock` — the suite
/// can't redirect HOME hermetically, mirroring the
/// `flight_journal::tests::append_journal_creates_file_and_appends`
/// pattern. Run manually with:
///
///   `cargo test --lib --manifest-path src-tauri/Cargo.toml \
///       commands::flight_planner_costs::e8_accum -- --ignored --test-threads=1`
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
        flight_id: &str,
        planner_cost_seed: Option<f64>,
        planner_tokens_seed: Option<u64>,
    ) -> Result<(), String> {
        let mid = flight_id.to_string();
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
    async fn unseed_flight(flight_id: &str) {
        let mid = flight_id.to_string();
        let _: Result<(), String> = storage::with_state_lock(move |state| {
            state.flights.retain(|f| f.id != mid);
            std::future::ready(Ok(()))
        })
        .await;
    }

    /// Read back the on-disk Flight for assertions.
    async fn read_flight(flight_id: &str) -> Option<Flight> {
        let state = storage::load_state();
        state.flights.into_iter().find(|f| f.id == flight_id)
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
    /// state right after `start_flight_planner` but before any turn closes).
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

    /// Missing-flight case — calling against a flight id that doesn't
    /// exist on disk MUST surface an `Err` so the sidecar event handler
    /// can log the warning. (Compare to `persist_planner_state_on_flight`,
    /// which intentionally silently no-ops in the same shape because that
    /// helper's call sites already tolerate races against flight delete.
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
            "error message should name the missing flight: {}",
            err
        );
    }
}
