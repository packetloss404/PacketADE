# Flight Planner Reliability / Continuity Pack

Status: **implemented; automated gates passing, manual acceptance pending**
Owner lane: Flight Planner reliability, continuity, and release sign-off
Last updated: 2026-05-28

This pack is the focused sprint for making Flight Planner dependable after
the v1 feature work. It does not redesign the locked v1 plan; it hardens the
places where long-running autonomous work can lose continuity: cold starts,
approval hydration, quota pauses, wake replay, journal scale, compaction, and
async execution collisions.

Primary references:

- [`flight-planner-plan.md`](./flight-planner-plan.md)
- [`flight-planner-v1-acceptance-runbook.md`](./flight-planner-v1-acceptance-runbook.md)
- [`local-quality-gates.md`](../local-quality-gates.md)
- [`../../backlog.md`](../../backlog.md)

## Scope

### In scope

- Cold-start continuity: no persisted flight should appear active against a
  dead planner sidecar session after app restart.
- Approval continuity: unresolved Flight Planner approvals must hydrate on
  view mount/resume, remain sorted oldest-first, de-dupe by id, and survive
  live-event/hydration races.
- Rate-limit continuity: quota pauses must visibly pause the planner, notify
  the user, resume safely, and replay or explicitly requeue the dropped wake.
- Journal continuity: journal path safety, append-only readability, bounded
  reads for long flights, and clear scaling follow-ups.
- Compaction continuity: compaction should trigger once per threshold crossing,
  show UI state while summarizing, clear on completion, and refresh flight
  state after swap.
- Async-path collision gates: planner-emitted tasks must not silently launch
  conflicting work against the same files or target workspace.
- Runbook confidence: one operator can validate the above without knowing the
  implementation history.

### Out of scope

- Helper planner v1.1.
- Rewriting the journal UI.
- Replacing the async attempts execution path.
- Changing Flight Planner core architecture beyond reliability fixes.

## Reliability Contract

Flight Planner is acceptable for beta only when these invariants hold.

1. **Cold start is conservative.**
   On app boot, flights with stale planner session ids or non-terminal live
   planner status are paused and have dead session ids cleared. Terminal
   flights are left alone.

2. **Approvals cannot disappear.**
   Pending approvals are sourced from persisted state and live events. A view
   remount, app restart, or race between listener install and hydration must
   not hide an unresolved approval.

3. **Quota pauses are explicit and recoverable.**
   A rate-limit or overload pause moves runtime status to `quota_paused`, emits
   user-visible notification, waits for the retry window/backoff, and does not
   drop the wake that was being processed.

4. **Journals remain useful at flight scale.**
   Missing journals read as empty, flight ids cannot escape the journal
   directory, exported markdown remains human-readable, and long flights have
   a bounded-read or incremental-read path before public beta scale testing.

5. **Compaction is a continuity event, not a failure.**
   Crossing the token threshold triggers one summarization pass, marks the UI
   as compacting, writes a recoverable context summary, swaps into a fresh
   planner session, clears the flag, and refreshes flight state.

6. **Async work never collides silently.**
   If planner-emitted tasks would mutate overlapping paths, the system gates,
   records the collision, and asks for user approval or serializes the work
   before launching the conflicting attempts.

## Sprint Plan

### Sprint A - Inventory and Baseline

- [x] Run the targeted automated inventory in "Automated Gates".
- [x] Record current pass/fail state beside each checklist item below.
- [ ] Confirm `backlog.md` items that are now fixed are either removed or
      updated with the closing commit.
- [x] Confirm all Flight Planner docs point to this continuity pack.

Exit checkpoint:

- Current behavior is known.
- No ambiguous "probably covered" items remain in the checklist.

### Sprint B - Cold Start and Approval Continuity

- [x] Verify `compute_cold_start_paused` covers active, planning, review, spec,
      flight-level paused, terminal, clean non-terminal, empty-state, and
      session-id clearing cases.
- [x] Verify frontend approval hydration runs after listeners install.
- [x] Verify live approval events are merged with persisted approvals by id.
- [x] Verify resolving one approval clears only that id and is safe if another
      window already resolved it.

Exit checkpoint:

- Restart/remount cannot hide unresolved approvals.
- Cold-start never shows a dead planner as `awake`.

### Sprint C - Rate-Limit Wake Replay

- [x] Confirm 429 / `rate_limit_error` / `RateLimitError` / 529 overloaded are
      classified into the quota-pause path.
- [x] Capture the wake that was in flight when the sidecar reported
      rate-limited.
- [x] On auto-resume, replay the captured wake once or enqueue an explicit
      replacement wake with the same trigger payload.
- [x] Emit `flight-planner:status-changed:<flightId>` for both quota-pause
      and auto-resume transitions.
- [ ] Journal the pause and replay decision so an operator can reconstruct
      what happened.

Exit checkpoint:

- "Rate-limited mid-decomposition" eventually continues without requiring a
  new task event.

### Sprint D - Journal and Compaction Scale

- [x] Keep existing journal path-safety tests green.
- [x] Add or validate an incremental/bounded read path before large beta
      flights. Full-file reads are acceptable for short local tests only.
- [x] Confirm journal exports include approval resolution and compaction
      summary breadcrumbs.
- [x] Confirm compaction trigger cannot double-fire while
      `compaction_in_progress` is true.
- [x] Confirm completion clears frontend `isCompacting` and rehydrates flight
      state.

Exit checkpoint:

- A multi-hour flight can be inspected without reading an unbounded journal
  on every append.

### Sprint E - Async Collision Gates

- [x] Inventory where planner-created tasks are launched into async attempts.
- [x] Define the target-key/path-key used for collision detection.
- [x] Gate overlapping tasks before launch, not after failures.
- [x] Surface the collision as a Flight Planner approval or explicit serial
      queue decision.
- [x] Add a regression that two tasks targeting the same write path cannot
      both launch without the gate.

Exit checkpoint:

- Flight Planner cannot unknowingly launch two mutating tasks against the
  same target surface.

### Sprint F - Operator Acceptance

- [ ] Run the v1 acceptance runbook happy path.
- [ ] Run stop/restart hygiene.
- [ ] Run approval gate hydration after app reload.
- [ ] Simulate or force a rate-limit path and verify visible pause/resume.
- [ ] Open the journal export directly from disk.
- [ ] Capture final command output and any skipped gates in the handoff.

Exit checkpoint:

- One operator can reproduce the reliability story from docs alone.

## Automated Gates

Run these while iterating:

```bash
pnpm exec vitest run src/stores/__tests__/flightPlannerStore.compaction.test.ts src/components/flights/__tests__/JournalTab.test.tsx --testTimeout=15000
pnpm run sidecar:integration-smoke
cargo test --manifest-path src-tauri/Cargo.toml cold_start -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml flight_journal -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml compaction -- --nocapture
```

> **Environment note.** On WSL2 with Windows-installed `node_modules`, the
> Linux-native Vitest run (rollup) and the live sidecar / Claude-CLI / codex
> smokes cannot execute (the native binaries are absent for the Linux target).
> The Windows host is the gate-execution environment for those gates; run them
> there, not from WSL2.

Run these before release handoff:

```bash
pnpm run preflight
pnpm run sidecar:check
pnpm run check:tauri-schema
pnpm run rust:check
pnpm run rust:test
pnpm run release:readiness:report
```

Use `pnpm run check` when time permits and record any skipped gate.

## Test Inventory

| Concern                      | Existing coverage                                                  | Required gap check                                               |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Cold-start stale sessions    | Rust `cold_start_*` tests in `flight_planner.rs`                  | Ensure all live non-terminal statuses pause and clear session id |
| Wake kind drift              | Rust `wake_trigger_kind_str_matches_locked_design`                 | Keep `launch` mapping pinned                                     |
| Wake payload fallback        | Rust `build_wake_payload_falls_back_when_flight_missing`           | Confirm missing flights do not panic the wake consumer           |
| Rate-limit status wire shape | Rust `flight_planner_session_has_quota_paused_status`             | Add/review auto-resume wake replay coverage                      |
| Approval hydration           | Frontend `flightPlannerStore` tests                               | Confirm persisted/live merge and de-dupe by approval id          |
| Approval resolution          | Rust command docs + frontend state clearing                        | Add regression if resolution races appear                        |
| Journal path safety          | Rust `flight_journal` tests                                       | Keep traversal, backslash, empty, NUL cases green                |
| Journal UI loading           | `JournalTab.test.tsx`                                              | Bounded tail read/render covered                                 |
| Compaction UI state          | `flightPlannerStore.compaction.test.ts`                           | Keep trigger/completed flags and hydrate side-effect green       |
| MCP planner tool contract    | `pnpm run sidecar:integration-smoke`                               | Keep tool list and protocol floor pinned                         |
| Async collision gate         | `asyncFlightStore.test.ts`, `flight_attempts`, `create_task` tests | Claimed-path planner gate plus backend/manual launch guard       |

## Manual Acceptance Addendum

Add these checks to the normal v1 acceptance runbook:

- [ ] Start a flight, force a pending approval, reload the app, and confirm
      the approval banner returns before any new planner event arrives.
- [ ] Stop the app while the planner status is `awake`, restart, and confirm
      the flight is paused rather than shown as running.
- [ ] Trigger a quota pause or run against a mocked sidecar rate-limit event;
      confirm status, notification, resume, and replay behavior.
- [ ] Let the flight create enough journal entries to make repeated refreshes
      noticeable; confirm bounded/incremental behavior or record the beta
      blocker.
- [ ] Attempt two planner-created mutating tasks with overlapping paths; confirm
      the collision gate appears before both launch.

## Definition of Done

- [x] All automated gates above pass or are explicitly documented as skipped.
- [ ] The v1 acceptance runbook passes.
- [ ] The manual addendum passes.
- [ ] Open `backlog.md` Flight Planner reliability items are closed, moved to
      v1.1, or documented as accepted beta limitations.
- [x] New or changed behavior is reflected in the docs before commit.
- [ ] Build artifacts are produced from the same commit that passed the gates.
