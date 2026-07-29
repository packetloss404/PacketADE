# Flight Escalation & Supervision — Scoped Loop

Created: 2026-07-24
Completed: 2026-07-24
Product decision confirmed: 2026-07-27 — **Option B / assisted escalation**.
PacketADE detects and recommends automatically; a user action is required to
retry, reassign, or relaunch. Fully automatic recovery belongs behind an
explicit PacketAgent worker policy, not in the PacketADE Flight runtime.

Parity target: BridgeSwarm's "reduce supervision load" — see
[`bridgeswarm-teardown.md`](./bridgeswarm-teardown.md) (§ "Escalation / auto-reassignment"
is the one BridgeSwarm dimension PacketADE scored *Partial* on). Supersedes the
Phase 4 section of [`swarm-orchestration-plan.md`](./swarm-orchestration-plan.md),
which is **stale** (it references deleted files — `MilestonesPanel.tsx`,
`ReviewQueueView.tsx`, `orchestrationSchedulerStore.ts` — and claims role
badges / handoff-log UI are shipped when they died with `MilestonesPanel`).

## Objective

When a multi-agent flight has work that **fails, stalls, or blocks**, the user
should not have to babysit terminals to notice or fix it. Escalation must:
1. **structure** the failure (why it stopped), not just show free-text;
2. **surface** it in one scannable place (Flight Deck attention + the issue
   Kanban board), not hidden inside "In Progress"/"Running";
3. **suggest a concrete next action** (relaunch on a different agent/target); and
4. let the user **act in one click** — attempts stay user-launched, but the
   remediation is a proposed action, not ad-hoc session juggling.

This is *suggestion-first* orchestration. **Non-goal:** reviving the autonomous
task scheduler removed on 2026-07-24 (`commands/orchestration.rs` +
`core::orchestrator` engine). Nothing here schedules or launches work without a
user action.

## Grounding — what already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Escalation *suggestions* pipeline | `src/lib/flightCoordination.ts` (N2, "suggestions never auto-actions") | Live: detects a fully-stuck flight, dedups by attempt signature, appends one `escalation` `CoordinationEvent`. Wired from `asyncFlightStore.setAttemptStatus`/`cancelAttempt` + the terminal listener. |
| Coordination feed (renders escalations) | `FlightsView.tsx` `TimelineCard`/`TimelineRow`; `EVENT_DOT` maps `escalation`→red, `collision_warning`→amber, `handoff`→blue | Live but **display-only** (no action buttons). |
| Event schema | TS `CoordinationEventType` incl. `escalation`/`task_failed`/`handoff`/`review_requested` (`flight.ts:133-153`, has `metadata`); Rust `Flight.coordination_log: Vec<serde_json::Value>` (`flight.rs:426`, schema-free) | New event subtypes need **no Rust change**. |
| Statuses | `AttemptStatus` (`queued/provisioning/running/reviewing/completed/failed/cancelled`); `TaskStatus` incl. `blocked`; `IssueStatus` incl. `blocked`/`needs_human` | Live. |
| Collision / target machinery | `asyncFlightStore.findAsyncLaunchPathCollisions`; Rust `flight_attempts.rs` `validate_target_claims_against_active_attempts` | Live — knows agent configs + free targets (reusable for reassignment suggestions). |
| Error classification | `src-tauri/src/core/error_classifier.rs` | Exists; not yet wired to attempt failures. |
| Attention grouping | `FlightsView.tsx` `classifyGroup` (failed/paused/has-approval) | Live flight-list grouping. |

**Known holes the map surfaced (constraints for the items below):**
- `Attempt` (TS `flight.ts:174-197`; Rust `flight.rs:311+`) has only free `errorMessage` — **no** structured failure field, `role`, `blockedReason`, or `handoffLog` (those live on `Task`, which the attempt runtime never populates).
- Rust `Task` has **no** `blocked_reason`/`role`/`handoff_log` fields — TS-only today; anything needing Rust persistence must add them.
- `isFlightStuck` only fires when **all** attempts are terminal-without-success — a single stalled/long-running attempt never escalates; there is **no time threshold**.
- **No relaunch/reassign path exists anywhere** — the only remediation today is a free-text follow-up (while `running`/`reviewing`) or launching a brand-new attempt.
- Role badges (`TASK_ROLE_CONFIG`, `flight-colors.ts:48`) and handoff rendering are defined but **rendered nowhere** (lost with `MilestonesPanel`).

## Kanban-board integration decision

Escalation produces **board-visible state**, not just a feed log:
- **Primary surface — Flight Deck:** the `Attention` sidebar group + actionable
  `TimelineCard` rows (where escalations already render).
- **Secondary surface — issue Kanban board:** `blocked`/`needs_human` issue
  statuses currently **roll up into "In Progress"** (`IssueBoard.tsx`
  `BOARD_COLUMNS`) and are invisible. Promote them to a first-class **"Blocked /
  Needs Attention"** column, and propagate a flight-attempt escalation to its
  linked issue (`issue.flightId` bridge) so the board reflects agent trouble.
  This is the BridgeBoard-parity play ("kanban that shows agent work status").
- Sequencing: Flight Deck first (where work runs); the issue-board surfacing
  (E7) depends on E1–E4 existing and is a later iteration.

## Loop ledger

Status values: `queued` → `in-progress` → `gated` → `closed`. Work items in ID
order; a later item may assume earlier ones are `closed`. Each item is sized to
one loop iteration.

| ID | Item | Acceptance condition | Key hooks | Gate | Depends on | Status |
|---|---|---|---|---|---|---|
| **E1** | Structured failure reason on attempts | A failed attempt carries a typed `failureCategory` derived at the `failed` transition; shown on `AttemptTile`. Persists across the Rust `Attempt` round-trip. | Reused `error_classifier::AiErrorCategory` (richer than the plan's draft enum); `record_attempt_error` classifies in Rust at every failed-transition site; `failure_category` on `core::Attempt` + `AttemptDto` + TS `Attempt` (`AttemptFailureCategory` union); `AttemptTile` chip. | Rust: `record_attempt_error` classify + skip-when-not-failed tests. cargo/​lint/​build green. | — | ✅ closed 2026-07-24 |
| **E2** | Stuck-threshold detection | A single attempt `running` past `DEFAULT_STALL_THRESHOLD_MS` (15 min) raises exactly one deduped `escalation`; ignores non-running/healthy attempts. | `flightCoordination.ts`: pure `isAttemptStalled`/`shouldEscalateStalled` + `maybeEscalateStalled` + `startStallSweep` (60s interval), wired mount-once in `App.tsx`. | Vitest: 5 cases (threshold boundary, non-running, no-startedAt, dedup). lint/build green. | — | ✅ closed 2026-07-24 |
| **E3** | Targeted reassignment *suggestion* | The stuck-flight escalation carries `metadata.suggestedAgentId` (first `API_PROVIDERS` agent the flight hasn't tried) and names it in the summary. | `flightCoordination.ts`: pure `suggestReassignmentAgent(tried, catalog)` + `agentLabel`; `maybeEscalate` enriched. | Vitest: 4 cases (first-untried, skip-tried, all-tried→undefined, none-tried). lint/build green. | E1 | ✅ closed 2026-07-24 |
| **E4** | Relaunch / reassign **action** | `asyncFlightStore.reassignAttempt(flightId, attemptId, newAgentConfigId)` rebuilds a launch target from the failed attempt (new agent + its default model; SSH reconstructed from the saved `ServerConfig`), records a `handoff` event, and appends a fresh attempt via `launchAsync` — no new Rust command needed. Pure `buildReassignSpec` extracted. | `asyncFlightStore.ts`. | Vitest: `buildReassignSpec` local/ssh/missing-server (3 cases). lint/build green. | E3 | ✅ closed 2026-07-24 |
| **E5** | Actionable feed rows | `TimelineRow` renders one-click **"Reassign to {agent}"** + "Dismiss" on escalation events carrying a suggestion; accepting invokes `reassignAttempt`. Other event types stay display-only. | `FlightsView.tsx` `TimelineRow`/`TimelineCard`; pure `reassignTargetFromEscalation` in `flightCoordination.ts`. | Vitest: 4 cases for the resolver (non-escalation, no-suggestion, no-template, resolves last-failed). lint/build green. | E4 | ✅ closed 2026-07-24 |
| **E6** | Flight-level attention queue | `AttentionCard` in `FlightDetailPane` surfaces one "Needs attention" strip — attempts `reviewing` (accept/reject) or `failed` (reassign/review, with the E1 category). | `flightReview.ts` pure `summarizeFlightAttention`; `FlightsView.tsx` `AttentionCard`. | Vitest: counts reviewing+failed, ignores running/completed/cancelled; empty case. lint/build green. | E1 | ✅ closed 2026-07-24 |
| **E7** | Issue Kanban **Needs Attention** column + flight→issue propagation | `blocked`/`needs_human` now own a first-class "Needs Attention" column (were hidden in In Progress); a flight escalation flags its active linked issues `needs_human` (via `flagLinkedIssuesNeedHuman` in `maybeEscalate`/`maybeEscalateStalled`), landing them there. | `IssueBoard.tsx` `BOARD_COLUMNS`; pure `issuesToFlagNeedsHuman` + wiring in `flightCoordination.ts`. | Vitest: `issuesToFlagNeedsHuman` (active-only, linked-only) 2 cases. lint/build green. | E4 | ✅ closed 2026-07-24 |
| **E8** *(stretch)* | Restore role/handoff rendering | `TASK_ROLE_CONFIG` role badges render per task in `MilestonesCard`; `handoff` events already render in `TimelineCard` (E4/E5 emit them). | `FlightsView.tsx` `MilestonesCard`; `flight-colors.ts`. | lint/build green (UI-only). | — | ✅ closed 2026-07-24 |
| **E9** | Correct the stale plan doc | `swarm-orchestration-plan.md` Phase 4 marked superseded (earlier) and the role-badge / handoff status rows flipped to ✅ now that E8 restored them. | `swarm-orchestration-plan.md` | Docs only. | E8 | ✅ closed 2026-07-24 |

## Loop protocol

Each iteration (mirrors the reliability-fix-loop cadence):
1. **Claim** the lowest-ID `queued` item whose `Depends on` are all `closed`.
2. **Revalidate** the acceptance condition against current code (line refs drift).
3. **Implement** the minimal change; keep attempts user-launched and the Rust
   `coordination_log` schema-free.
4. **Test** — add/strengthen a focused test named in the item's Gate.
5. **Gate** — narrow test, then the repo gates: `cargo check` (Windows manifest
   path, capture the *real* exit code — not through `| tail`), `cargo test`,
   `pnpm lint`, `pnpm build`, and the targeted `vitest` file(s). The historical
   Windows `0xc0000139` test-loader block was fixed on 2026-07-29.
6. **Record** — flip status to `closed`, add a `CHANGELOG.md` line, commit on a
   branch (`feat/flight-escalation-*`), one item (or a small cohesive group) per
   commit.

## Sequencing

```
E1 ─┬─> E3 ─> E4 ─┬─> E5
    │             ├─> E7
    └─> E6        │
E2 ───────────────┘   (E2 feeds E3/E5 escalation events; independent to build)
E8 ─> E9              (cosmetic completeness; last)
```
E1 and E2 are independent starting points. E4 (the action) is the spine —
E5/E7 are its surfaces. E8/E9 close out coordination-feed completeness and the
doc cleanup. A minimal shippable slice is **E1 → E3 → E4 → E5** (structured
failure → targeted suggestion → reassign action → one-click feed), which already
delivers the core "reduce supervision load" parity; E6/E7 broaden the surfaces.

## Open decisions (resolve at E-item time, not up front)

- **Stuck threshold value + configurability** (E2): fixed default vs a setting in
  `OrchestratorSettings`. Lean fixed default first.
- **Reassignment target policy** (E3/E4): suggest the next free agent of the same
  role, or let the user pick from free targets. Lean "suggest one, user can
  override."
- **Issue status on escalation** (E7): `blocked` vs `needs_human`. `needs_human`
  reads as "supervisor action required," which matches the intent.
