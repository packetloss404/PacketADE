use crate::api::{
    AgentConfigDto, FlightDto, OrchestratorSettingsDto, PersistedStateDto, PersistedUiStateDto,
    ServerConfigDto, WorkspaceDto,
};
use crate::commands::orchestration::SharedOrchestrator;
use crate::core::flight::Issue;
use crate::core::orchestrator::OrchestratorSettings;
use crate::core::shared::lock_mutex;
use crate::core::storage::{self};

pub fn apply_orchestrator_settings(
    orchestrator: &SharedOrchestrator,
    settings: OrchestratorSettings,
) -> Result<(), String> {
    let mut orch = lock_mutex(orchestrator)?;
    orch.settings = settings;
    Ok(())
}

#[tauri::command]
pub fn load_persisted_state() -> Result<PersistedStateDto, String> {
    Ok(storage::load_state().into())
}

/// Bulk-save the persisted state.
///
/// **Issue-slice contract:** the `issues` and `retrospectives` fields of the
/// incoming DTO are *intentionally ignored*. Those two slices are owned
/// exclusively by [`save_issues_slice`] and [`save_retrospectives`]; this bulk
/// save always keeps whatever is already on disk for them. That prevents a
/// concurrent slice write — landing between the frontend's
/// `load_persisted_state` and this call — from being silently clobbered by a
/// stale bulk snapshot. Callers must persist issue / retrospective changes
/// through those dedicated slice commands, never by stuffing them into the DTO
/// passed here.
#[tauri::command]
pub fn save_persisted_state(state: PersistedStateDto) -> Result<(), String> {
    let incoming: crate::core::storage::PersistedState = state.into();
    storage::update_state(|state| {
        // Take the on-disk issues/retrospectives aside, overwrite everything
        // else with `incoming`, then put the slice-owned data back — so the
        // incoming DTO's issues/retrospectives are dropped, not persisted.
        // See the issue-slice contract on this function.
        let preserved_issues = std::mem::take(&mut state.issues);
        let preserved_retros = std::mem::take(&mut state.retrospectives);
        *state = incoming;
        state.issues = preserved_issues;
        state.retrospectives = preserved_retros;
    })
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
pub fn save_settings_slice(
    orchestrator: tauri::State<'_, SharedOrchestrator>,
    settings: OrchestratorSettingsDto,
) -> Result<(), String> {
    let settings: OrchestratorSettings = settings.into();
    storage::save_settings(settings.clone())?;
    apply_orchestrator_settings(&orchestrator, settings)
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
pub fn save_memory_slice(
    memory_events: Vec<serde_json::Value>,
    memory_patterns: Vec<serde_json::Value>,
) -> Result<(), String> {
    storage::save_memory(memory_events, memory_patterns)
}

#[tauri::command]
pub fn save_servers_slice(servers: Vec<ServerConfigDto>) -> Result<(), String> {
    storage::save_servers(servers.into_iter().map(Into::into).collect())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::commands::orchestration::SharedOrchestrator;
    use crate::core::orchestrator::{Orchestrator, OrchestratorSettings};

    use super::apply_orchestrator_settings;

    #[test]
    fn apply_orchestrator_settings_updates_live_orchestrator() {
        let orchestrator: SharedOrchestrator =
            Arc::new(Mutex::new(Orchestrator::new(OrchestratorSettings {
                max_parallel_sessions: 3,
                milestone_gating: true,
                project_path: "D:/old".to_string(),
                auto_commit_trailer_enabled: true,
                auto_commit_trailer_format:
                    crate::core::orchestrator::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT.to_string(),
            })));
        let next = OrchestratorSettings {
            max_parallel_sessions: 8,
            milestone_gating: false,
            project_path: "D:/new".to_string(),
            auto_commit_trailer_enabled: false,
            auto_commit_trailer_format: "Custom: F-{flightId}/{attemptId}".to_string(),
        };

        apply_orchestrator_settings(&orchestrator, next.clone()).unwrap();

        let orch = orchestrator.lock().unwrap();
        assert_eq!(
            orch.settings.max_parallel_sessions,
            next.max_parallel_sessions
        );
        assert_eq!(orch.settings.milestone_gating, next.milestone_gating);
        assert_eq!(orch.settings.project_path, next.project_path);
    }
}
