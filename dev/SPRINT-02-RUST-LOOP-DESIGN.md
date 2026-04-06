# Sprint 2 -- Move Orchestration Scheduling Loop to Rust Backend

**Sprint 1 Task 5 -- Design Document**
**Status:** Draft
**Date:** 2026-04-06

---

## 1. Current Architecture

The orchestration scheduling loop currently lives in the frontend, driven by a `setInterval` in `orchestrationStore.ts`:

```
Frontend (setInterval 1s)
  |
  v
orchestrationStore.tick()
  |
  v
orchestrationTick()  <-- Tauri invoke
  |
  v
Rust: Orchestrator::tick(&flights, &agents) -> Vec<TaskSpawnRequest>
  |
  v
Frontend receives TaskSpawnRequest[]
  |
  v
layoutStore.addPane()  -- creates terminal pane with PTY
  |
  v
recordTaskSpawn()  <-- Tauri invoke to update Rust state
```

### Key files

| Layer | File | Role |
|-------|------|------|
| Frontend store | `src/stores/orchestrationStore.ts` | `startLoop`/`stopLoop` via `setInterval`; `tick()` calls backend and spawns panes |
| Tauri commands | `src-tauri/src/commands/orchestration.rs` | `orchestration_tick`, `record_task_spawn`, `launch_flight`, etc. |
| Core engine | `src-tauri/src/core/orchestrator.rs` | `Orchestrator::tick()` returns `Vec<TaskSpawnRequest>`; pure scheduling logic |
| Persistence | `src-tauri/src/core/storage.rs` | `load_state()`/`save_state()` reads/writes `state.v1.json` |

### Problems with the current approach

1. **Webview reload kills scheduling.** If the user reloads the webview (F5, HMR, crash recovery), the `setInterval` is cleared and scheduling silently stops. Active flights stall with no indication.

2. **Multi-window double-scheduling.** If two Tauri windows exist (future multi-window support), both would run independent `setInterval` loops, calling `orchestration_tick` in parallel and double-spawning tasks.

3. **Frontend drives a backend-owned concern.** The orchestrator state (`running_tasks`, `active_flight_ids`, `paused_at_milestone`) lives in Rust. Having the frontend poll it every second to decide what to spawn is an inversion of control -- the backend already knows what needs to happen.

4. **Race window between tick and spawn.** The frontend receives `TaskSpawnRequest[]`, then asynchronously creates panes and calls `recordTaskSpawn`. If a second tick fires before the first spawn is recorded, the same task could be spawned twice (currently mitigated by a `runningTasks.has()` check in the frontend, but the Rust side has no guard).

---

## 2. Target Architecture

The Rust backend owns the scheduling loop. The frontend reacts to events.

```
Rust (tokio::spawn + tokio::time::interval 1s)
  |
  v
Orchestrator::tick(&flights, &agents) -> Vec<TaskSpawnRequest>
  |
  v
Emit Tauri event "orchestration:spawn" with payload
  |
  v
Frontend listens for "orchestration:spawn"
  |
  v
layoutStore.addPane()  -- creates terminal pane
  |
  v
recordTaskSpawn()  <-- Tauri invoke to confirm spawn
```

### Control flow

1. Frontend calls `enable_orchestration` Tauri command (e.g., when launching a flight).
2. Rust spawns a `tokio::spawn` task that runs a `tokio::time::interval(Duration::from_secs(1))` loop.
3. On each tick, the task locks the `SharedOrchestrator` mutex, calls `storage::load_state()`, runs `Orchestrator::tick()`, and saves state.
4. If `tick()` returns any `TaskSpawnRequest`s, the task emits an `orchestration:spawn` Tauri event with the requests as payload. It also marks those tasks as `spawn_pending` internally so they are not re-emitted on the next tick.
5. The frontend receives the event, creates terminal panes via `layoutStore.addPane()`, then calls `recordTaskSpawn` for each task with the assigned session ID. This transitions the task from `spawn_pending` to `Running`.
6. When `active_flight_ids` is empty and `running_tasks` is empty, the loop auto-stops and emits `orchestration:state-changed` with the final state.
7. Frontend calls `disable_orchestration` to explicitly stop the loop (e.g., when the user pauses all flights).

### Frontend store changes

- `startLoop()` / `stopLoop()` replaced by `enableOrchestration()` / `disableOrchestration()` (Tauri invokes).
- `tick()` removed entirely from the frontend.
- `orchestrationTick` Tauri command removed.
- New event listener for `orchestration:spawn` handles pane creation.
- New event listener for `orchestration:state-changed` keeps `orchestrationStore` state in sync without polling.

---

## 3. New Tauri Commands

### `enable_orchestration`

Starts the backend scheduling loop if not already running.

```rust
#[tauri::command]
pub async fn enable_orchestration(
    app: tauri::AppHandle,
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    loop_handle: tauri::State<'_, SharedLoopHandle>,
) -> Result<(), String>
```

- Checks `SharedLoopHandle` -- if a task is already running, returns `Ok(())` (idempotent).
- Clones `AppHandle`, `SharedOrchestrator`, and a `tokio::sync::watch::Sender<bool>` (stop signal).
- Spawns the tokio task, stores its `JoinHandle` in `SharedLoopHandle`.

### `disable_orchestration`

Stops the backend scheduling loop.

```rust
#[tauri::command]
pub async fn disable_orchestration(
    loop_handle: tauri::State<'_, SharedLoopHandle>,
) -> Result<(), String>
```

- Sends `true` on the watch channel (stop signal).
- Awaits the `JoinHandle` to ensure clean shutdown.
- Clears `SharedLoopHandle`.

### `is_orchestration_enabled`

Query whether the loop is currently running.

```rust
#[tauri::command]
pub fn is_orchestration_enabled(
    loop_handle: tauri::State<'_, SharedLoopHandle>,
) -> Result<bool, String>
```

- Returns `true` if the `JoinHandle` is present and not finished.

### Managed state additions

```rust
pub type SharedLoopHandle = Arc<Mutex<Option<LoopState>>>;

struct LoopState {
    stop_tx: tokio::sync::watch::Sender<bool>,
    join_handle: tokio::task::JoinHandle<()>,
}
```

Register in `lib.rs` alongside `SharedOrchestrator`:

```rust
.manage(create_shared_loop_handle())
```

---

## 4. New Tauri Events

### `orchestration:spawn`

Emitted when the tick produces tasks that need PTY sessions.

**Payload:** `Vec<TaskSpawnRequest>` (already `serde::Serialize`).

```json
[
  {
    "flight_id": "f-abc",
    "milestone_id": "ms-1",
    "task_id": "task-42",
    "agent_config_id": "claude-code",
    "command": "claude",
    "args": ["-p", "..."],
    "prompt": "Flight: ...\nTask: ...",
    "project_path": "D:/projects/Foo"
  }
]
```

Frontend listener pseudocode:

```typescript
listen<TaskSpawnRequest[]>("orchestration:spawn", (event) => {
  for (const req of event.payload) {
    if (spawnedTaskIds.has(req.taskId)) continue; // deduplicate
    spawnedTaskIds.add(req.taskId);
    const paneId = layoutStore.addPane({ ... });
    recordTaskSpawn({ sessionId: "", ...req });
  }
});
```

### `orchestration:state-changed`

Emitted whenever orchestrator state changes materially (task spawned, task completed, flight paused/resumed, loop started/stopped).

**Payload:** `OrchestratorSnapshot` (already defined in `commands/orchestration.rs`).

```json
{
  "running_task_ids": ["task-42"],
  "active_flight_ids": ["f-abc"],
  "paused_at_milestone": [["f-def", "ms-3"]]
}
```

The frontend uses this to keep `orchestrationStore` state in sync:

```typescript
listen<OrchestratorSnapshot>("orchestration:state-changed", (event) => {
  useOrchestrationStore.setState({
    activeFlightIds: new Set(event.payload.active_flight_ids),
    pausedAtMilestone: new Map(event.payload.paused_at_milestone),
  });
});
```

---

## 5. Edge Cases

### Frontend is slow to create a pane

The Rust tick emits `orchestration:spawn` with `task-42`. Before the frontend calls `recordTaskSpawn`, the next tick fires.

**Mitigation:** When a `TaskSpawnRequest` is emitted, the Rust loop immediately marks the task as `spawn_pending` in the orchestrator. `Orchestrator::tick()` skips tasks that are `spawn_pending` (treated like `Running` for slot accounting). `recordTaskSpawn` transitions the task to `Running` with the session ID.

New task status needed: `TaskStatus::SpawnPending`. This is internal to the orchestrator and not surfaced in the UI -- the frontend treats it as "about to start."

### Two spawn events arrive before the first pane is created

Each `TaskSpawnRequest` contains a unique `taskId`. The frontend maintains a `Set<string>` of task IDs it has already begun spawning. If a `taskId` is already in the set, the request is silently dropped. This is a safety net -- the `spawn_pending` status in Rust should prevent duplicates at the source.

### Frontend disconnects (webview reload / crash)

The Rust loop continues ticking. Spawn events are emitted but no listener receives them. Tasks marked `spawn_pending` will time out (no `recordTaskSpawn` confirmation arrives).

**Mitigation:**
- Add a `spawn_pending_since: u64` timestamp. If a task has been `spawn_pending` for more than 30 seconds without a `recordTaskSpawn` call, the orchestrator resets it to `Queued` and re-emits it on the next tick.
- On frontend reconnect (app mount / webview ready), the frontend calls `getOrchestrationState` to reconcile local state. It also re-registers event listeners and calls `enable_orchestration` (idempotent) to ensure the loop is running.

### Multiple windows

Only one tokio task runs regardless of how many windows exist. `enable_orchestration` is idempotent -- the second call is a no-op. `AppHandle::emit` broadcasts to all windows, so every window receives `orchestration:spawn`. Since only one window should create panes, a frontend-level leader election or a simple "only the first window to call `recordTaskSpawn` wins" approach is needed. For now (single-window), this is deferred.

### Graceful shutdown

The tokio loop checks the `watch::Receiver<bool>` on each iteration:

```rust
loop {
    tokio::select! {
        _ = interval.tick() => { /* run orchestrator tick */ }
        _ = stop_rx.changed() => { break; }
    }
}
```

On app exit, `disable_orchestration` is called (or the tokio runtime drops, cancelling the task). The orchestrator's `recover_from_flights` method (already implemented) handles restart recovery by resetting `Running`/`Queued` tasks to `Paused`.

### Storage contention

`storage::load_state()` and `storage::save_state()` use a `static STATE_LOCK: Mutex<()>` for file-level serialization. The tokio loop runs on an async runtime but the storage mutex is `std::sync::Mutex`. Since the lock is held only for the duration of a file read/write (fast), this is acceptable. The `with_orchestrator_and_flights` helper already uses this pattern.

---

## 6. Migration Plan

### Phase A: Add backend loop infrastructure

1. Add `TaskStatus::SpawnPending` variant to `flight.rs`.
2. Add `SharedLoopHandle` managed state to `lib.rs`.
3. Implement `enable_orchestration`, `disable_orchestration`, `is_orchestration_enabled` commands.
4. The tokio task calls `Orchestrator::tick()`, emits `orchestration:spawn` events, and marks tasks as `spawn_pending`.
5. The tokio task emits `orchestration:state-changed` after each tick that produces changes.
6. Add TS bindings in `src/lib/tauri.ts` for the new commands.

### Phase B: Frontend listens for spawn events

1. Add an `orchestration:spawn` event listener in `orchestrationStore.ts` (or a dedicated setup function alongside `setupExitListener`).
2. The listener calls `layoutStore.addPane()` and `recordTaskSpawn()` -- same logic currently in `tick()`.
3. Add an `orchestration:state-changed` event listener to replace `syncFromBackend` polling.

### Phase C: Switch frontend to backend-driven loop

1. `launchFlight` calls `enable_orchestration` instead of `startLoop`.
2. `resumeFlight` calls `enable_orchestration` instead of `startLoop`.
3. `pauseFlight` / `cancelFlight` call `disable_orchestration` if no active flights remain.
4. Remove `startLoop`, `stopLoop`, `tick`, and the `loopInterval` variable from `orchestrationStore.ts`.
5. Remove the `loopRunning` state field (replace with `isOrchestrationEnabled` derived from backend query).

### Phase D: Clean up deprecated code

1. Remove the `orchestration_tick` Tauri command from `commands/orchestration.rs`.
2. Remove the `orchestrationTick` TS binding from `src/lib/tauri.ts`.
3. Remove `topologicalSort` and `depsResolved` from `orchestrationStore.ts` (scheduling logic is fully backend-owned).
4. Update any tests or references.

---

## 7. Implementation Notes

### Tokio task structure

```rust
async fn orchestration_loop(
    app: AppHandle,
    orchestrator: SharedOrchestrator,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let requests = {
                    let mut orch = orchestrator.lock().unwrap();
                    let state = storage::load_state();
                    let reqs = orch.tick(&state.flights, &state.agents);
                    // Mark tasks as spawn_pending and save
                    if !reqs.is_empty() {
                        // ... mark spawn_pending, save state
                    }
                    reqs
                };
                if !requests.is_empty() {
                    let _ = app.emit("orchestration:spawn", &requests);
                }
                // Auto-stop check
                let orch = orchestrator.lock().unwrap();
                if orch.active_flight_ids.is_empty()
                    && orch.running_tasks.is_empty()
                {
                    break;
                }
            }
            _ = stop_rx.changed() => {
                break;
            }
        }
    }
}
```

### AppHandle access

The `enable_orchestration` command receives `app: tauri::AppHandle` as a parameter. This is cloned into the spawned task. Tauri v2 supports this pattern natively.

### Orchestrator mutex safety

`SharedOrchestrator` is `Arc<Mutex<Orchestrator>>` (std mutex, not tokio). The lock is held only for the duration of `tick()` which is CPU-bound and fast (iterates flights/milestones/tasks). This does not block the async runtime meaningfully. If profiling shows contention, consider switching to `tokio::sync::Mutex` and `.await`-ing the lock.

### Storage caching

`storage::load_state()` reads and deserializes `state.v1.json` from disk on every tick (once per second). For the typical state file size (< 100KB), this is negligible. However, if flights grow large (many milestones/tasks), consider:

1. An in-memory cache with dirty-flag writes (read from memory, write-through on mutation).
2. A `notify`-based file watcher to invalidate the cache if an external process modifies the file.

This optimization is deferred to a future sprint unless profiling shows it is needed.

### Event naming conventions

Following the existing pattern (`insights:chunk`, `flight-chat:chunk`, `pty:exit`), new events use the `orchestration:` prefix to avoid collisions.

---

## 8. Files Modified (Expected)

| File | Change |
|------|--------|
| `src-tauri/src/core/flight.rs` | Add `TaskStatus::SpawnPending` |
| `src-tauri/src/core/orchestrator.rs` | Skip `SpawnPending` tasks in `tick()`; add timeout requeue logic |
| `src-tauri/src/commands/orchestration.rs` | Add `enable_orchestration`, `disable_orchestration`, `is_orchestration_enabled`; add `SharedLoopHandle` |
| `src-tauri/src/commands/mod.rs` | Export new commands |
| `src-tauri/src/lib.rs` | Register new commands and `SharedLoopHandle` managed state |
| `src/lib/tauri.ts` | Add TS bindings for new commands; remove `orchestrationTick` |
| `src/stores/orchestrationStore.ts` | Replace `startLoop`/`stopLoop`/`tick` with event listeners and new command calls |

---

## 9. Open Questions

1. **Spawn timeout duration.** 30 seconds is proposed for `spawn_pending` timeout. Should this be configurable?
2. **Multi-window pane creation.** If multi-window is added later, which window creates the terminal pane? Leader election vs. dedicated "orchestration window"?
3. **State-changed event frequency.** Emitting on every tick that has changes could be noisy. Should we debounce or only emit on material state transitions?
4. **TUI binary impact.** The `packetcode-tui` binary shares `packetcode_lib::core`. Adding `SpawnPending` to `TaskStatus` affects TUI serialization. Ensure backward compatibility with existing persisted state files.
