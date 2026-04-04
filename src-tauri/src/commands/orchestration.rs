use std::sync::{Arc, Mutex};

use crate::core::flight::FlightStatus;
use crate::core::orchestrator::{Orchestrator, OrchestratorSettings, RunningTask, TaskSpawnRequest};
use crate::core::storage::{self, PersistedState};
use crate::core::shared::lock_mutex;

/// Shared orchestrator state managed by Tauri
pub type SharedOrchestrator = Arc<Mutex<Orchestrator>>;

/// Create the shared orchestrator, recovering state from persisted flights
pub fn create_shared_orchestrator() -> SharedOrchestrator {
    let mut state = storage::load_state();
    let mut orchestrator = Orchestrator::new(state.settings.clone());
    orchestrator.recover_from_flights(&mut state.flights);
    // Save recovered state (tasks moved to paused, sessions cleared)
    let _ = storage::save_state(&state);
    Arc::new(Mutex::new(orchestrator))
}

#[derive(serde::Deserialize)]
pub struct TickRuntimeSnapshot {
    pub running_task_ids: Vec<String>,
}

/// Serializable snapshot of orchestrator runtime state for the frontend
#[derive(serde::Serialize, Clone)]
pub struct OrchestratorSnapshot {
    pub running_task_ids: Vec<String>,
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
    let mut state = storage::load_state();
    let result = action(&mut orch, &mut state)?;
    storage::save_state(&state)?;
    Ok(result)
}

#[tauri::command]
pub fn launch_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    flight_id: String,
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let flight = state
            .flights
            .iter_mut()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
        orch.launch_flight(flight);
        Ok(state.clone())
    })
}

#[tauri::command]
pub fn pause_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    flight_id: String,
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let flight = state
            .flights
            .iter_mut()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
        orch.pause_flight(flight);
        Ok(state.clone())
    })
}

#[tauri::command]
pub fn resume_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    flight_id: String,
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let flight = state
            .flights
            .iter_mut()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
        orch.resume_flight(flight);
        Ok(state.clone())
    })
}

#[tauri::command]
pub fn cancel_flight(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    flight_id: String,
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        let flight = state
            .flights
            .iter_mut()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("Flight '{}' not found", flight_id))?;
        orch.cancel_flight(flight);
        Ok(state.clone())
    })
}

#[tauri::command]
pub fn orchestration_tick(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
) -> Result<Vec<TaskSpawnRequest>, String> {
    let mut orch = lock_mutex(&orchestrator)?;
    let state = storage::load_state();
    Ok(orch.tick(&state.flights, &state.agents))
}

#[tauri::command]
pub fn get_orchestration_state(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
) -> Result<OrchestratorSnapshot, String> {
    let orch = lock_mutex(&orchestrator)?;
    Ok(OrchestratorSnapshot {
        running_task_ids: orch.running_tasks.keys().cloned().collect(),
        active_flight_ids: orch.active_flight_ids.iter().cloned().collect(),
        paused_at_milestone: orch.paused_at_milestone.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
    })
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
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        orch.on_task_complete(&task_id, success, &mut state.flights);
        Ok(state.clone())
    })
}

#[tauri::command]
pub fn notify_approval_needed(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    task_id: String,
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        orch.on_task_approval_needed(&task_id, &mut state.flights);
        Ok(state.clone())
    })
}

#[tauri::command]
pub fn notify_approval_resolved(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    task_id: String,
) -> Result<PersistedState, String> {
    with_orchestrator_and_flights(&orchestrator, |orch, state| {
        orch.on_task_approval_resolved(&task_id, &mut state.flights);
        Ok(state.clone())
    })
}
