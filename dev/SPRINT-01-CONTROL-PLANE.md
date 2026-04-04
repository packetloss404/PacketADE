# Sprint 1: Control Plane Hardening

**Date:** 2026-04-03

## Sprint Goal

Eliminate the split-brain between `orchestrationStore.ts` (frontend) and `orchestrator.rs` (Rust backend) so the Rust orchestrator is the single source of truth for flight lifecycle, task scheduling, dependency resolution, and milestone advancement.

---

## Current State

### Rust backend (`src-tauri/src/core/orchestrator.rs`)

The `Orchestrator` struct holds authoritative scheduling state:

| Method | Responsibility |
|---|---|
| `launch_flight` | Sets flight to Active, activates first milestone, queues ready tasks |
| `pause_flight` | Pauses running/queued tasks, removes from active set |
| `resume_flight` | Resumes from paused-at-milestone or active milestone |
| `cancel_flight` | Cancels all non-terminal tasks |
| `on_task_complete` | Updates task status, calls `queue_ready_tasks`, checks milestone completion, handles milestone gating, advances or completes flight |
| `on_task_approval_needed` | Sets task to ApprovalNeeded |
| `on_task_approval_resolved` | Sets task back to Running |
| `tick` | Returns `Vec<TaskSpawnRequest>` for queued tasks up to `max_parallel_sessions` |
| `record_spawn` | Marks task Running, links session, updates milestone status |
| `recover_from_flights` | Resets interrupted tasks to Paused on app restart |
| `deps_resolved` | Checks if all dependencies of a task are Done |
| `queue_ready_tasks` | Queues Pending tasks whose deps are resolved |

### Rust commands layer (`src-tauri/src/commands/orchestration.rs`)

Exposes Tauri commands that wrap the orchestrator with `storage::load_state` / `storage::save_state`:

- `launch_flight`, `pause_flight`, `resume_flight`, `cancel_flight` -- all return `PersistedState`
- `orchestration_tick` -- returns `Vec<TaskSpawnRequest>`
- `record_task_spawn` -- records a spawn in orchestrator + persists
- `get_orchestration_state` -- returns `OrchestratorSnapshot` (running_task_ids, active_flight_ids, paused_at_milestone)
- `notify_task_complete` -- calls `orch.on_task_complete`, returns `PersistedState`
- `notify_approval_needed` / `notify_approval_resolved` -- call respective orchestrator methods

### Frontend store (`src/stores/orchestrationStore.ts`)

The store **duplicates** significant logic that already exists in Rust:

| Frontend function | Duplicates Rust method | Problem |
|---|---|---|
| `onTaskComplete` (lines 234-331) | `Orchestrator::on_task_complete` | Full re-implementation: updates task status, calls `depsResolved`, checks milestone completion, handles milestone gating, advances to next milestone, completes flight. **Never calls `notify_task_complete` on the backend.** |
| `topologicalSort` (lines 91-111) | Not used at runtime but exported -- stale utility | Dead code risk; callers may use it instead of backend scheduling |
| `depsResolved` (lines 114-120) | `Orchestrator::deps_resolved` | Used by `onTaskComplete` to re-queue tasks locally |
| `getAllFlightTasks` (lines 138-140) | N/A (utility) | Couples frontend to milestone internals |
| `pauseFlight` (lines 163-192) | `Orchestrator::pause_flight` | Calls backend, then **also** kills PTY sessions and removes from `runningTasks` locally -- PTY kill is not coordinated with backend |
| `cancelFlight` (lines 205-232) | `Orchestrator::cancel_flight` | Same pattern: calls backend, then local PTY kill + local state cleanup |
| `tick` (lines 399-451) | `Orchestrator::tick` | Frontend interprets `TaskSpawnRequest`, creates panes via `layoutStore.addPane`, calls `recordTaskSpawn` fire-and-forget, maintains its own `runningTasks` Map |
| `startLoop` / `stopLoop` (lines 453-475) | No backend equivalent | 1-second `setInterval` driving `tick` from the frontend |
| `setupExitListener` (lines 526-561) | No backend equivalent | Listens to `pty:exit` Tauri event, calls `onTaskComplete` (frontend-only), never notifies Rust |

### Split-brain consequences

1. **`onTaskComplete` never calls `notify_task_complete`** -- the Rust orchestrator's `running_tasks` HashMap grows forever; its milestone/flight state diverges from what the frontend computed.
2. **`pauseFlight`/`cancelFlight` kill PTY sessions locally** -- the Rust `pause_flight`/`cancel_flight` don't know about PTY cleanup; if the frontend fails mid-cleanup, sessions leak.
3. **`runningTasks` is tracked in both places** -- `Orchestrator.running_tasks` (Rust) and `orchestrationStore.runningTasks` (frontend Map). They can diverge.
4. **`syncFromBackend` only reads `activeFlightIds` and `pausedAtMilestone`** -- it does NOT sync `runningTasks`, so the two sides can permanently disagree about what's running.
5. **Scheduling loop runs in frontend** -- if the webview reloads, scheduling stops. If two windows exist, they'd double-schedule.

### Persistence fragmentation

13 stores write to independent `localStorage` keys (`packetcode:flights`, `packetcode:agents`, `packetcode:issues`, `packetcode:cost-entries`, `packetcode:insights-sessions`, `packetcode:ideation-session`, `packetcode:memory`, `packetcode:modules`, `packetcode:notifications`, `packetcode:profiles`, `packetcode:active-profile`, `packetcode:prompt-templates`, `packetcode:github`). Meanwhile, the Rust backend persists flights/agents/settings to `~/.packetcode/state.v1.json`. Flight data exists in both places and can diverge.

---

## What Needs to Change

### Remove from frontend (`orchestrationStore.ts`)

1. **Delete `onTaskComplete` method** (lines 234-331) -- all task completion logic must go through `notify_task_complete` Tauri command
2. **Delete `topologicalSort` export** (lines 91-111) -- unused at runtime, misleading
3. **Delete `depsResolved` function** (lines 114-120) -- only used by the deleted `onTaskComplete`
4. **Delete `getAllFlightTasks` export** (lines 138-140) -- move callers to read from flight directly
5. **Remove PTY kill logic from `pauseFlight`/`cancelFlight`** -- move to Rust backend
6. **Remove local `runningTasks` Map** -- replace with read-only state synced from backend snapshot
7. **Remove `clearTaskSessionLink` function** (lines 122-135) -- backend handles session unlinking

### Add/modify in backend

1. **New Tauri command: `kill_flight_sessions`** in `commands/orchestration.rs` -- given a flight ID, kill all PTY sessions linked to that flight's running tasks (uses `PtyManager`)
2. **Expand `OrchestratorSnapshot`** to include full `running_tasks` data (not just IDs) so frontend can render without maintaining its own map
3. **New Tauri command: `on_pty_exit`** -- called by the Rust PTY event bridge (not the frontend) when a session exits; calls `orch.on_task_complete` internally
4. **Move scheduling loop to Rust** -- `orchestration_tick` should be called by a Rust-side timer, not a frontend `setInterval`; frontend receives spawn requests via Tauri events
5. **Wire PTY exit events to orchestrator in Rust** -- when `PtyEvent::Exit` fires, look up session in `Orchestrator.running_tasks`, call `on_task_complete`, persist, emit updated state to frontend

### Modify in frontend

1. **`setupExitListener`** -- replace `onTaskComplete(taskId, success)` with a call to `notifyTaskComplete(taskId, success)` backend command, then `syncFromBackend`
2. **`syncFromBackend`** -- expand to read full `runningTasks` from the new enriched `OrchestratorSnapshot`
3. **`tick`** -- keep only the pane-creation side (calling `layoutStore.addPane`); remove local `runningTasks` bookkeeping

---

## Tasks

### Task 1: Fix the critical `onTaskComplete` split-brain

**Files:** `src/stores/orchestrationStore.ts`, `src/lib/tauri.ts`

**Do:**
- In `setupExitListener` (line 531-561), replace the call to `store.onTaskComplete(taskId, success)` with `await notifyTaskComplete(taskId, success)` followed by `store.syncFromBackend()` and `useFlightStore.getState().hydrateFromBackend()`.
- Remove `clearTaskSessionLink` calls from the exit listener (backend `on_task_complete` + `record_spawn` already manage session linkage in persisted state).
- Keep `onTaskComplete` method temporarily as a no-op fallback during transition; mark it `@deprecated`.

**Acceptance criteria:**
- When a PTY session exits, `notify_task_complete` Rust command is invoked.
- Rust `Orchestrator.running_tasks` is decremented on task completion.
- Frontend state matches backend state after completion (verified by `syncFromBackend` returning consistent `running_task_ids`).
- Milestone advancement and flight completion are driven by Rust only.

---

### Task 2: Enrich `OrchestratorSnapshot` and `syncFromBackend`

**Files:** `src-tauri/src/commands/orchestration.rs`, `src/stores/orchestrationStore.ts`, `src/lib/tauri.ts`

**Do:**
- Expand `OrchestratorSnapshot` to include:
  ```rust
  pub running_tasks: Vec<RunningTaskSnapshot>,  // full RunningTask data, not just IDs
  ```
  where `RunningTaskSnapshot` is a serializable struct with `task_id`, `milestone_id`, `flight_id`, `session_id`, `agent_config_id`, `started_at`.
- Update `get_orchestration_state` command to populate the new field.
- Update `syncFromBackend` in `orchestrationStore.ts` to populate the local `runningTasks` Map from the snapshot (read-only mirror, not locally mutated).
- Add corresponding TypeScript types in `src/types/flight.ts` or `src/stores/orchestrationStore.ts`.

**Acceptance criteria:**
- `syncFromBackend` produces a `runningTasks` Map that exactly matches `Orchestrator.running_tasks` in Rust.
- No other code path writes to `runningTasks` except `syncFromBackend`.

---

### Task 3: Move PTY kill into Rust for `pauseFlight` / `cancelFlight`

**Files:** `src-tauri/src/commands/orchestration.rs`, `src-tauri/src/core/orchestrator.rs`, `src-tauri/src/core/pty.rs`, `src-tauri/src/lib.rs`, `src/stores/orchestrationStore.ts`

**Do:**
- Add a `kill_sessions_for_flight` method to `PtyManager` that takes a list of session IDs and kills them.
- In `commands/orchestration.rs`, make `pause_flight` and `cancel_flight` commands accept `tauri::State<'_, SharedPtyManager>` (or equivalent) and call `kill_sessions_for_flight` with the session IDs from `orch.running_tasks` before calling `orch.pause_flight` / `orch.cancel_flight`.
- Remove the `Promise.all(tasksToStop.map(...killPty...))` blocks from `orchestrationStore.ts` `pauseFlight` (lines 178-183) and `cancelFlight` (lines 219-223).
- Remove the local `runningTasks.delete` blocks that follow (lines 185-192, 225-231) -- frontend should just call `syncFromBackend` after the command returns.

**Acceptance criteria:**
- `pauseFlight` and `cancelFlight` in the frontend are thin wrappers: call backend command, hydrate, sync. No local PTY or runningTask mutation.
- PTY sessions are killed atomically with flight state transition in Rust.
- No session leak if frontend crashes during pause/cancel.

---

### Task 4: Delete duplicated scheduling logic from frontend

**Files:** `src/stores/orchestrationStore.ts`

**Do:**
- Delete `topologicalSort` function (lines 91-111). Audit for imports: `src/lib/tauri.ts` references it -- remove or redirect.
- Delete `depsResolved` function (lines 114-120).
- Delete `getAllFlightTasks` function (lines 138-140). Find callers and replace with inline `flight.milestones.flatMap(m => m.tasks)`.
- Delete the full body of `onTaskComplete` method (lines 234-331). Replace with:
  ```typescript
  onTaskComplete: (_taskId: string, _success: boolean) => {
    // Handled by backend via notify_task_complete. This is a no-op.
  },
  ```
- Remove `onTaskApprovalNeeded` and `onTaskApprovalResolved` local flight-store mutations (lines 333-377) -- the backend `notify_approval_needed`/`notify_approval_resolved` commands already do this. Keep only the `notifyApproval*` invoke calls + `syncFromBackend`.

**Acceptance criteria:**
- `orchestrationStore.ts` contains zero dependency-resolution or milestone-advancement logic.
- `pnpm build` and `pnpm lint` pass with no errors.
- All callers of removed exports are updated.

---

### Task 5: Prepare for Rust-side scheduling loop (design only)

**Files:** Design doc only (no code changes this sprint)

**Do:**
- Document the target architecture for moving the `setInterval` / `tick` loop from frontend to Rust:
  - Rust spawns an async task on app startup that calls `orchestrator.tick()` every 1 second.
  - When `tick` returns `TaskSpawnRequest`s, Rust emits a `orchestration:spawn` Tauri event.
  - Frontend listens for `orchestration:spawn`, calls `layoutStore.addPane` to create the terminal pane, then calls `record_task_spawn` with the resulting session ID.
  - Frontend `startLoop`/`stopLoop` are replaced by `enable_orchestration`/`disable_orchestration` backend commands.
- Document edge cases: what if frontend is slow to create a pane? What if two spawn events arrive before the first pane is created?

**Acceptance criteria:**
- Written design doc at `dev/SPRINT-02-RUST-LOOP-DESIGN.md` (created in Sprint 2 planning).
- No code changes in this task.

---

### Task 6: Add integration test for task-complete round-trip

**Files:** `src-tauri/src/core/orchestrator.rs` (extend `#[cfg(test)]` module)

**Do:**
- Add test: `launch_flight` -> `tick` -> `record_spawn` -> `on_task_complete(success)` -> verify milestone advances, next tasks queued.
- Add test: multi-task milestone with dependencies; complete tasks in order; verify `queue_ready_tasks` promotes the right tasks.
- Add test: milestone gating -- complete milestone, verify flight goes to `Review`, `resume_flight` activates next milestone.
- Add test: `on_task_complete(failure)` -- verify milestone goes to `Failed`, flight goes to `Failed`.

**Acceptance criteria:**
- `cargo test` passes with 4+ new tests covering the full lifecycle.
- Tests do not depend on filesystem or PTY.

---

## Task Dependencies

```
Task 1 (fix onTaskComplete split-brain)
  └── Task 2 (enrich snapshot) -- Task 1 needs syncFromBackend to work properly
        └── Task 4 (delete duplicated logic) -- safe to delete only after Tasks 1+2 ensure backend path works

Task 3 (PTY kill in Rust) -- independent of Tasks 1/2, can run in parallel

Task 5 (design doc) -- independent, can run anytime

Task 6 (integration tests) -- independent, can run anytime but validates Tasks 1-4
```

Recommended execution order: **6 first** (validates Rust logic before frontend changes), then **1 + 2 + 3 in parallel**, then **4**, then **5**.

---

## Definition of Done

1. The frontend `orchestrationStore.ts` contains **zero** dependency-resolution, milestone-advancement, or task-status-mutation logic. All scheduling decisions flow through Rust `Orchestrator` methods.
2. `setupExitListener` calls `notify_task_complete` (Rust command), not `onTaskComplete` (local method).
3. `pauseFlight` and `cancelFlight` kill PTY sessions in Rust, not in the frontend.
4. `syncFromBackend` produces a complete mirror of `Orchestrator` runtime state including full `runningTasks`.
5. `pnpm build`, `pnpm lint`, and `cargo test` all pass.
6. No regression in manual testing: launch a flight, watch tasks schedule, complete, milestone advance, flight complete.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `notify_task_complete` call from exit listener races with frontend teardown | Medium | Task completion lost, flight stuck | Add retry logic in exit listener; backend `recover_from_flights` already resets stuck tasks on restart |
| Moving PTY kill to Rust requires `SharedPtyManager` to be accessible from `commands/orchestration.rs`; current Tauri state wiring may not expose it | Medium | Blocks Task 3 | Verify `lib.rs` state management; may need to wrap PtyManager in a new shared type or pass AppHandle |
| Removing `onTaskComplete` before backend path is fully tested causes silent failures | High | Flights never advance | Task 6 (integration tests) must pass before Task 4; keep `onTaskComplete` as deprecated fallback until verified |
| Frontend stores (`flightStore`, `agentStore`) still use `localStorage` as fallback; removing all local persistence could break offline/dev mode | Low | Loss of state in dev mode without Tauri backend | Keep `localStorage` fallback for non-orchestration stores; only remove orchestration-specific local state |
| `storage::load_state` / `storage::save_state` are called on every command via `with_orchestrator_and_flights`; high-frequency `tick` calls cause excessive disk I/O | Medium | Performance degradation | Sprint 2: cache `PersistedState` in memory, flush on a debounced interval or on state-changing commands only |
