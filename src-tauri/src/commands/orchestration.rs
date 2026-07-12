use std::sync::{Arc, Mutex};

use tracing::warn;

use crate::api::{OrchestratorSnapshotDto, PersistedStateDto, TaskSpawnRequestDto};
use crate::commands::pty::SharedPtyManager;
use crate::core::orchestrator::{Orchestrator, TaskSpawnRequest};
use crate::core::shared::lock_mutex;
use crate::core::storage::{self, PersistedState};

/// Shared orchestrator state managed by Tauri
pub type SharedOrchestrator = Arc<Mutex<Orchestrator>>;

/// Create the shared orchestrator, recovering state from persisted flights.
///
/// Runs the load → recover → save under `storage::update_state` so the
/// recovery write can't be clobbered by an early slice-writer racing with
/// app startup. The function signature is non-`Result` (it's wired into
/// the Tauri builder chain in `lib.rs`), so a save failure is logged as
/// a warning rather than propagated — strictly better than the previous
/// `let _ = save_state(&state)` swallow.
pub fn create_shared_orchestrator() -> SharedOrchestrator {
    let mut orchestrator_slot: Option<Orchestrator> = None;
    let recover_result = storage::update_state(|state| {
        let mut orchestrator = Orchestrator::new(state.settings.clone());
        orchestrator.recover_from_flights(&mut state.flights);
        orchestrator_slot = Some(orchestrator);
    });
    if let Err(e) = recover_result {
        warn!(
            "Failed to persist recovered orchestrator state on startup: {}",
            e
        );
    }
    let orchestrator = orchestrator_slot.unwrap_or_else(|| {
        // `update_state` failed before the closure ran (lock poisoned).
        // Fall back to a fresh orchestrator from a best-effort load so
        // the app can still come up.
        Orchestrator::new(storage::load_state().settings)
    });
    Arc::new(Mutex::new(orchestrator))
}

/// Serializable snapshot of a single running task for the frontend
#[derive(serde::Serialize, Clone)]
pub struct RunningTaskSnapshot {
    pub task_id: String,
    pub milestone_id: String,
    pub flight_id: String,
    pub session_id: String,
    pub agent_config_id: String,
    pub started_at: u64,
}

/// Serializable snapshot of orchestrator runtime state for the frontend
#[derive(serde::Serialize, Clone)]
pub struct OrchestratorSnapshot {
    pub running_task_ids: Vec<String>,
    pub running_tasks: Vec<RunningTaskSnapshot>,
    pub active_flight_ids: Vec<String>,
    pub paused_at_milestone: Vec<(String, String)>,
}

fn with_orchestrator_and_flights<F, R>(
    orchestrator: &SharedOrchestrator,
    action: F,
) -> Result<R, String>
where
    F: FnOnce(&mut Orchestrator, &mut PersistedState) -> Result<R, String>,
{
    let mut orch = lock_mutex(orchestrator)?;
    // Hold the orchestrator lock across `update_state`, which itself takes
    // `STATE_LOCK` for the entire load → mutate → save. This closes the
    // load-modify-write race against concurrent slice writers
    // (`save_issues_slice`, `save_flights_slice`, etc.) that could land
    // between a bare `load_state()` and `save_state(&state)`.
    storage::update_state(|state| action(&mut orch, state))?
}

#[tauri::command]
pub fn launch_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    flight_id: String,
) -> Result<PersistedStateDto, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let flight = state
            .flights
            .iter_mut()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
        orch.launch_flight(flight);
        Ok(state.clone().into())
    })
}

#[tauri::command]
pub fn pause_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    pty_manager: tauri::State<'_, SharedPtyManager>,
    flight_id: String,
) -> Result<PersistedStateDto, String> {
    // Step 1: Collect session IDs and pause flight (under orchestrator lock
    // AND STATE_LOCK via update_state — closes the load-modify-write race
    // against concurrent slice writers).
    let (result, session_ids) = {
        let mut orch = lock_mutex(&orchestrator)?;
        storage::update_state(|state| {
            let session_ids: Vec<String> = orch
                .running_tasks
                .values()
                .filter(|rt| rt.flight_id == flight_id)
                .map(|rt| rt.session_id.clone())
                .filter(|id| !id.is_empty())
                .collect();

            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            orch.pause_flight(flight);
            Ok::<(PersistedStateDto, Vec<String>), String>((
                PersistedStateDto::from(state.clone()),
                session_ids,
            ))
        })?
    }?; // orchestrator lock released here

    // Step 2: Kill PTY sessions (under pty lock, orchestrator already released)
    if !session_ids.is_empty() {
        if let Ok(mut mgr) = pty_manager.lock() {
            mgr.kill_sessions(&session_ids);
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn resume_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    flight_id: String,
) -> Result<PersistedStateDto, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let flight = state
            .flights
            .iter_mut()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
        orch.resume_flight(flight);
        Ok(state.clone().into())
    })
}

#[tauri::command]
pub fn cancel_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    pty_manager: tauri::State<'_, SharedPtyManager>,
    flight_id: String,
) -> Result<PersistedStateDto, String> {
    // Step 1: Collect session IDs and cancel flight (under orchestrator lock
    // AND STATE_LOCK via update_state — closes the load-modify-write race
    // against concurrent slice writers).
    let (result, session_ids) = {
        let mut orch = lock_mutex(&orchestrator)?;
        storage::update_state(|state| {
            let session_ids: Vec<String> = orch
                .running_tasks
                .values()
                .filter(|rt| rt.flight_id == flight_id)
                .map(|rt| rt.session_id.clone())
                .filter(|id| !id.is_empty())
                .collect();

            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
            orch.cancel_flight(flight);
            Ok::<(PersistedStateDto, Vec<String>), String>((
                PersistedStateDto::from(state.clone()),
                session_ids,
            ))
        })?
    }?; // orchestrator lock released here

    // Step 2: Kill PTY sessions (under pty lock, orchestrator already released)
    if !session_ids.is_empty() {
        if let Ok(mut mgr) = pty_manager.lock() {
            mgr.kill_sessions(&session_ids);
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn orchestration_tick(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
) -> Result<Vec<TaskSpawnRequestDto>, String> {
    let mut orch = lock_mutex(&orchestrator)?;
    let state = storage::load_state();
    Ok(orch
        .tick(&state.flights, &state.agents)
        .into_iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
pub fn get_orchestration_state(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
) -> Result<OrchestratorSnapshotDto, String> {
    let orch = lock_mutex(&orchestrator)?;
    Ok(OrchestratorSnapshot {
        running_task_ids: orch.running_tasks.keys().cloned().collect(),
        running_tasks: orch
            .running_tasks
            .values()
            .map(|rt| RunningTaskSnapshot {
                task_id: rt.task_id.clone(),
                milestone_id: rt.milestone_id.clone(),
                flight_id: rt.flight_id.clone(),
                session_id: rt.session_id.clone(),
                agent_config_id: rt.agent_config_id.clone(),
                started_at: rt.started_at,
            })
            .collect(),
        active_flight_ids: orch.active_flight_ids.iter().cloned().collect(),
        paused_at_milestone: orch
            .paused_at_milestone
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }
    .into())
}

#[tauri::command]
pub fn record_task_spawn(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    session_id: String,
    flight_id: String,
    milestone_id: String,
    task_id: String,
    agent_config_id: String,
    command: String,
    args: Vec<String>,
    prompt: String,
    project_path: String,
) -> Result<(), String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let req = TaskSpawnRequest {
            flight_id,
            milestone_id,
            task_id,
            agent_config_id,
            command,
            args,
            prompt,
            project_path,
        };
        orch.record_spawn(&session_id, &req, &mut state.flights);
        Ok(())
    })
}

#[tauri::command]
pub fn notify_task_complete(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    task_id: String,
    success: bool,
) -> Result<PersistedStateDto, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        orch.on_task_complete(&task_id, success, &mut state.flights);
        Ok(state.clone().into())
    })
}

#[tauri::command]
pub fn notify_approval_needed(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    task_id: String,
) -> Result<PersistedStateDto, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        orch.on_task_approval_needed(&task_id, &mut state.flights);
        Ok(state.clone().into())
    })
}

#[tauri::command]
pub fn notify_approval_resolved(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    task_id: String,
) -> Result<PersistedStateDto, String> {
    // Approval-resolved is the user accepting/denying — the planner
    // doesn't need to wake on this; it'll wake on the subsequent
    // task_completed/task_failed.
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        orch.on_task_approval_resolved(&task_id, &mut state.flights);
        Ok(state.clone().into())
    })
}
