# Swarm Orchestration Plan

> **⚠️ Superseded / status corrected 2026-07-24.** The escalation work (Phase 4)
> is now scoped in the current [`flight-escalation-loop.md`](./flight-escalation-loop.md).
> This doc is kept as the original design record, but its status table was
> written against UI/backend that has since been **deleted** — corrected below.
> Reality: the live Flight Deck UI is `src/components/views/FlightsView.tsx`
> (worktree-attempt model). `MilestonesPanel.tsx`, `FlightDetail.tsx`,
> `ReviewQueueView.tsx`, `create_task.rs`, the `orchestration*Store.ts` stores,
> and `commands/orchestration.rs` are all gone; `core::orchestrator` was pruned
> to `OrchestratorSettings` + `recover_flights_on_startup` (no scheduler).

Last updated: 2026-06-15 (status corrected 2026-07-24)

## Implementation Status (corrected 2026-07-24)

| Item | Status | Notes |
|------|--------|-------|
| Phase 1: TaskRole type | ✅ Type only | `TaskRole` in `src/types/flight.ts`; `TASK_ROLE_CONFIG` in `src/lib/flight-colors.ts`. |
| Phase 1: Role badges in UI | ✅ Restored (E8) | `TASK_ROLE_CONFIG` badges render per task in `FlightsView.tsx` `MilestonesCard` (re-added by the escalation loop's E8). |
| Phase 2: ownedPaths on tasks | ✅ Done | `owned_paths` on the Rust Task (`core/flight.rs`) + `ownedPaths` on the TS Task. |
| Phase 2: File collision detection | ✅ Done (relocated) | Live pre-launch gate in `asyncFlightStore.findAsyncLaunchPathCollisions` + Rust `flight_attempts.rs` (`validate_target_claims_against_active_attempts`). The old scheduler / `create_task.rs` wiring is gone. |
| Phase 3: Coordination feed | ✅ Done (relocated) | Live in `FlightsView.tsx` `TimelineCard` (reads `flight.coordinationLog`). The old `MilestonesPanel`/`FlightDetail` surface is gone. |
| Phase 3: Task handoff log | ✅ Rendered | `handoff` coordination events render in `FlightsView.tsx` `TimelineCard`/`TimelineRow` (the escalation loop's E4/E5 emit them on reassignment). |
| Phase 4: Escalation | 🔁 Superseded | Now scoped in [`flight-escalation-loop.md`](./flight-escalation-loop.md) (E1–E7). A suggestions-only pipeline (`src/lib/flightCoordination.ts`) already exists. |

## Goal

Turn PacketADE's existing flight orchestration into a clear multi-agent swarm system with explicit roles, collision prevention, and visible coordination.

This plan is intentionally built on the current PacketADE model rather than introducing a separate parallel system.

## Why This Fits PacketADE

PacketADE already has the key primitives:

- flights
- milestones
- tasks
- dependency edges
- review packets
- approval flow
- orchestration loop
- session launch and tracking

Relevant code today (corrected 2026-07-24):

- `src/types/flight.ts` — Flight/Milestone/Task/Attempt types, `TaskRole`, `CoordinationEvent`
- `src/stores/asyncFlightStore.ts` and `src/stores/flightStore.ts` — live worktree-attempt lifecycle + status rollup
- `src/lib/flightCoordination.ts` — escalation-suggestion pipeline (N2, suggestions-only)
- `src-tauri/src/commands/flight_attempts.rs` — attempt runtime + collision validation

The missing piece is not orchestration from scratch. The missing piece is a stronger product model on top of the existing attempt runtime.

## Product Outcome

The desired user experience is:

1. define a flight goal
2. break work into swarm-safe tasks
3. assign explicit roles to those tasks
4. prevent task overlap before sessions launch
5. watch progress and handoffs in one coordination surface
6. escalate blocked work to review or human attention automatically

## Current Gaps

Current orchestration gaps relative to that outcome:

- no explicit task role model like coordinator, builder, reviewer, scout
- no file ownership or reserved-path model
- no pre-launch collision detection
- no first-class coordination feed for inter-agent handoffs
- blocked work is visible, but escalation can become much more structured

## Phase 1: Explicit Roles

## Objective

Make the swarm legible.

## Proposed additions

- add a `role` field to tasks
- add a role capability field to agent configs if needed
- initial role set: `coordinator`, `builder`, `reviewer`, `scout`

## Product behavior

- tasks are created with a visible role
- flight and workspace UI show role badges next to running work
- review queue can group by role
- role-aware prompts can be injected at launch time

## Notes

This phase is mostly model and UI clarity. It should not require a new scheduler.

## Phase 2: File Ownership and Collision Prevention

## Objective

Prevent multi-agent merge collisions by design.

## Proposed additions

- add `ownedPaths: string[]` to tasks
- optionally add `blockedPaths: string[]` or `reservedPaths: string[]`
- add a pre-launch conflict check in the scheduler
- add conflict warnings in the flight/workspace UI before task execution

## Product behavior

- when two runnable tasks target overlapping file sets, PacketADE warns or defers one task
- ownership is visible in task detail and running-task UI
- the orchestrator prefers tasks that do not conflict with active ownership

## Data source options

Ownership can initially be set by:

- manual task editing
- AI-generated planning output
- imported spec-to-flight planning

Ownership can later be refined by:

- observed file writes from completed sessions
- review packet diffs

## Phase 3: Coordination Feed

## Objective

Make swarm behavior understandable without digging through individual sessions.

## Proposed additions

- a structured coordination timeline at the flight level
- task handoff entries as first-class events
- role-aware messages such as `scout completed discovery`, `builder awaiting review`, `reviewer requested changes`, and `coordinator rescheduled blocked task`

## Product behavior

- flight view shows a coordination feed
- workspace view can expose a compact live swarm strip
- review queue links back to the coordination timeline

## Notes

PacketADE already has `TaskHandoff` and `ReviewPacket` structures. This phase should reuse those rather than inventing a new message system first.

## Phase 4: Escalation and Supervision

## Objective

Reduce manual supervision load.

## Proposed additions

- structured blocked reasons on tasks
- automatic reassignment suggestions
- automatic review routing for reviewer-role work
- automatic review queue insertion for unresolved blockers
- coordinator recommendations when tasks are stuck beyond a threshold

## Product behavior

- blocked tasks do not silently stall the flight
- users get one clear place to handle intervention
- supervisor actions become explicit workflow steps instead of ad hoc session management

## Suggested Data Model Changes

Candidate changes to `src/types/flight.ts`:

- `TaskRole = "coordinator" | "builder" | "reviewer" | "scout"`
- `role: TaskRole`
- `ownedPaths?: string[]`
- `blockedReason?: string`
- `handoffLog?: TaskHandoff[]`

These should be added incrementally. The smallest useful change is `role` plus `ownedPaths`.

## UI Entry Points

Natural integration points (corrected 2026-07-24 — the live Flight Deck UI is a
single view; `FlightDetail.tsx`, `MilestonesPanel.tsx`, and `ReviewQueueView.tsx`
no longer exist):

- `src/components/views/FlightsView.tsx` — the live Flight Deck (its inner
  `MilestonesCard` / `TimelineCard` / `FlightDetailPane` / `AttemptTile` are the
  real integration surfaces)
- `WorkspaceView.tsx`

## Success Criteria

- users can tell which role is doing what at a glance
- overlapping work is caught before two agents edit the same area
- task handoffs are visible without opening every session
- blocked work is surfaced with a clear next action
- multi-agent flights require less manual supervision than today

## Delivery Order

1. roles
2. ownership fields and scheduler conflict checks
3. coordination feed
4. escalation rules

## Non-Goals

- building a separate standalone swarm product
- introducing complex distributed coordination beyond a single local PacketADE instance
- replacing the existing flight model with a new domain model
