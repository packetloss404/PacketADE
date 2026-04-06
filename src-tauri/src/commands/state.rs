use crate::core::storage::{self, PersistedState, PersistedUiState};
use crate::core::flight::{Flight, Issue};
use crate::core::agent_config::AgentConfig;
use crate::core::orchestrator::OrchestratorSettings;
use crate::core::workspace::Workspace;

#[tauri::command]
pub fn load_persisted_state() -> Result<PersistedState, String> {
    Ok(storage::load_state())
}

#[tauri::command]
pub fn save_persisted_state(state: PersistedState) -> Result<(), String> {
    storage::save_state(&state)
}

#[tauri::command]
pub fn save_flights_slice(flights: Vec<Flight>) -> Result<(), String> {
    storage::save_flights(flights)
}

#[tauri::command]
pub fn save_agents_slice(agents: Vec<AgentConfig>) -> Result<(), String> {
    storage::save_agents(agents)
}

#[tauri::command]
pub fn save_settings_slice(settings: OrchestratorSettings) -> Result<(), String> {
    storage::save_settings(settings)
}

#[tauri::command]
pub fn save_ui_slice(ui: PersistedUiState) -> Result<(), String> {
    storage::save_ui(ui)
}

#[tauri::command]
pub fn save_issues_slice(issues: Vec<Issue>) -> Result<(), String> {
    storage::save_issues(issues)
}

#[tauri::command]
pub fn save_workspaces_slice(workspaces: Vec<Workspace>) -> Result<(), String> {
    storage::save_workspaces(workspaces)
}
