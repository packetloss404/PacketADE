//! Tauri command wrapper for agent detection.
//! Delegates to core::agent.

use crate::core::agent;

#[tauri::command]
pub fn detect_agent(command: String) -> Result<bool, String> {
    Ok(agent::detect_agent(&command))
}
