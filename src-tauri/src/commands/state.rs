use crate::api::{
    AgentConfigDto, FlightDto, OrchestratorSettingsDto, PersistedStateDto, PersistedUiStateDto,
    ServerConfigDto, WorkspaceDto,
};
use crate::core::flight::Issue;
use crate::core::storage::{self};

#[tauri::command]
pub fn load_persisted_state() -> Result<PersistedStateDto, String> {
    Ok(storage::load_state().into())
}

#[tauri::command]
pub fn save_persisted_state(state: PersistedStateDto) -> Result<(), String> {
    let existing = storage::load_state();
    let mut state: crate::core::storage::PersistedState = state.into();
    state.issues = existing.issues;
    state.approval_log = existing.approval_log;
    state.retrospectives = existing.retrospectives;
    storage::save_state(&state)
}

#[tauri::command]
pub fn save_flights_slice(flights: Vec<FlightDto>) -> Result<(), String> {
    storage::save_flights(flights.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub fn save_agents_slice(agents: Vec<AgentConfigDto>) -> Result<(), String> {
    storage::save_agents(agents.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub fn save_settings_slice(settings: OrchestratorSettingsDto) -> Result<(), String> {
    storage::save_settings(settings.into())
}

#[tauri::command]
pub fn save_ui_slice(ui: PersistedUiStateDto) -> Result<(), String> {
    storage::save_ui(ui.into())
}

#[tauri::command]
pub fn save_issues_slice(issues: Vec<Issue>) -> Result<(), String> {
    storage::save_issues(issues)
}

#[tauri::command]
pub fn save_workspaces_slice(workspaces: Vec<WorkspaceDto>) -> Result<(), String> {
    storage::save_workspaces(workspaces.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub fn save_memory_slice(memory_events: Vec<serde_json::Value>) -> Result<(), String> {
    storage::save_memory_events(memory_events)
}

#[tauri::command]
pub fn save_servers_slice(servers: Vec<ServerConfigDto>) -> Result<(), String> {
    storage::save_servers(servers.into_iter().map(Into::into).collect())
}
