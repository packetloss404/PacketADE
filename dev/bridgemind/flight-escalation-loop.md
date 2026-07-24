# Flight Escalation & Supervision — Scoped Loop

Created: 2026-07-24
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
| **E2** | Stuck-threshold detection | A single attempt `running` past a configurable threshold (default ~15 min) raises exactly one `escalation` event (deduped); does not fire for healthy attempts. | `flightCoordination.ts` (add elapsed check vs `attempt.startedAt`); `asyncAttemptTerminalListeners.ts` subscription/tick | Vitest: threshold + one-shot dedup. | — | queued |
| **E3** | Targeted reassignment *suggestion* | An escalation event carries `metadata.suggestedAgentId` / `suggestedTarget` computed from free targets + agent configs (not a generic string). | `flightCoordination.ts` `maybeEscalate`/`ESCALATION_SUMMARY`; reuse collision/target machinery in `asyncFlightStore` | Vitest: failed attempt → escalation event names a concrete free agent/target. | E1 | queued |
| **E4** | Relaunch / reassign **action** | New `asyncFlightStore.reassignAttempt(flightId, attemptId, target)` mints a fresh attempt on a different agent/target via `launchAsync`, keeps the failed record, and records a `handoff` event ("reassigned to agent X"). Backend command sibling to `launch_flight_async`. | `asyncFlightStore.ts` (new action); Rust `flight_attempts.rs`; `flightStore.appendCoordinationEvent` | Vitest: action reuses launch path, records event, preserves failed record. Rust: command test. | E3 | queued |
| **E5** | Actionable feed rows | `TimelineRow` renders a one-click **"Reassign to {agent}"** (and "Dismiss") on escalation/suggestion events; accepting invokes E4. Display-only for other event types. | `FlightsView.tsx` `TimelineRow`/`TimelineCard` | Vitest/RTL: actionable row triggers `reassignAttempt`; non-actionable events unchanged. | E4 | queued |
| **E6** | Flight-level attention queue | A `FlightDetailPane` card aggregates `reviewing` + escalated attempts into one intervention list (parallel to `flightReview.summarizeFlightReview`). | `flightReview.ts` (aggregation); `FlightsView.tsx` `FlightDetailPane` | Vitest: aggregation counts reviewing + escalated correctly. | E1 | queued |
| **E7** | Issue Kanban **Blocked / Needs-Attention** column + flight→issue propagation | Promote `blocked`/`needs_human` out of "In Progress" into a first-class column; a flight-attempt escalation sets the linked issue (`flightId`) to `needs_human`, so it appears there. | `IssueBoard.tsx` `BOARD_COLUMNS`/`STATUS_TO_COLUMN`; escalation → `issueStore.updateIssue` via the flight↔issue bridge | Vitest: column mapping + escalation propagates to the linked issue's status. | E4 | queued |
| **E8** *(stretch)* | Restore role/handoff rendering | Re-add `TASK_ROLE_CONFIG` badges to `MilestonesCard` and handoff-log entries to `TimelineCard` (lost with `MilestonesPanel`), so the coordination surface is whole. | `FlightsView.tsx` `MilestonesCard`/`TimelineCard`; `flight-colors.ts` | RTL: badges + handoff rows render. | — | queued |
| **E9** | Correct the stale plan doc | Update `swarm-orchestration-plan.md`: mark Phase 4 superseded by this loop; fix the false "shipped" rows (role badges / handoff UI not live; deleted-file refs). | `swarm-orchestration-plan.md` | Docs only. | E8 | queued |

## Loop protocol

Each iteration (mirrors the reliability-fix-loop cadence):
1. **Claim** the lowest-ID `queued` item whose `Depends on` are all `closed`.
2. **Revalidate** the acceptance condition against current code (line refs drift).
3. **Implement** the minimal change; keep attempts user-launched and the Rust
   `coordination_log` schema-free.
4. **Test** — add/strengthen a focused test named in the item's Gate.
5. **Gate** — narrow test, then the repo gates: `cargo check` (Windows manifest
   path, capture the *real* exit code — not through `| tail`), `cargo test
   --no-run`, `pnpm lint`, `pnpm build`, and the targeted `vitest` file(s). (Rust
   test *execution* is host-blocked here by `0xc0000139`; compile+link + the
   vitest equivalents are the bar.)
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
