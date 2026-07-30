//! Rust-owned, read-only Monitor window registry.

use crate::core::brand::MONITOR_WINDOW_QUERY_KEY;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MONITOR_LABEL: &str = "monitor-main";
const MONITOR_ALLOWED_APP_COMMANDS: &[&str] = &[
    "get_monitor_window_route",
    "close_monitor_window",
    "focus_monitor_route_in_main",
    "load_persisted_state",
    "load_conversations",
];

/// Application commands are otherwise available to every WebView registered
/// with the app invoke handler. Keep Monitor's read-only posture authoritative
/// at that boundary instead of relying on hidden buttons in its frontend.
pub(crate) fn command_allowed_for_window(window_label: &str, command: &str) -> bool {
    if window_label == "main" {
        return true;
    }
    window_label.starts_with("monitor-") && MONITOR_ALLOWED_APP_COMMANDS.contains(&command)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MonitorRoute {
    AgentConversation { conversation_id: String },
    Flight { flight_id: String },
}

impl MonitorRoute {
    fn validate(&self) -> Result<(), String> {
        let id = match self {
            Self::AgentConversation { conversation_id } => conversation_id,
            Self::Flight { flight_id } => flight_id,
        };
        if id.trim().is_empty()
            || id.len() > 256
            || !id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_:.".contains(character))
        {
            return Err("Monitor route contains an invalid entity ID.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorLease {
    pub monitor_id: String,
    pub label: String,
    pub route: MonitorRoute,
    pub mode: &'static str,
    pub nonce: String,
    pub created_at: u64,
}

#[derive(Default)]
pub struct MonitorWindowRegistry {
    leases: Mutex<HashMap<String, MonitorLease>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn require_main(caller: &WebviewWindow) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("Only the main window can route Monitor windows.".to_string());
    }
    Ok(())
}

fn require_monitor(caller: &WebviewWindow, label: &str) -> Result<(), String> {
    if caller.label() != label || !label.starts_with("monitor-") {
        return Err("Monitor lease does not match the calling window.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn open_monitor_window(
    app: tauri::AppHandle,
    caller: WebviewWindow,
    registry: tauri::State<'_, MonitorWindowRegistry>,
    route: MonitorRoute,
) -> Result<MonitorLease, String> {
    require_main(&caller)?;
    route.validate()?;
    let lease = MonitorLease {
        monitor_id: uuid::Uuid::new_v4().to_string(),
        label: MONITOR_LABEL.to_string(),
        route,
        mode: "readonly",
        nonce: uuid::Uuid::new_v4().to_string(),
        created_at: now_ms(),
    };
    registry
        .leases
        .lock()
        .map_err(|_| "Monitor registry lock is unavailable.".to_string())?
        .insert(MONITOR_LABEL.to_string(), lease.clone());

    if let Some(window) = app.get_webview_window(MONITOR_LABEL) {
        window
            .emit("monitor-window:route-changed", &lease)
            .map_err(|error| format!("Could not update Monitor route: {error}"))?;
        let _ = window.unminimize();
        let _ = window.show();
        window
            .set_focus()
            .map_err(|error| format!("Could not focus Monitor window: {error}"))?;
        return Ok(lease);
    }

    WebviewWindowBuilder::new(
        &app,
        MONITOR_LABEL,
        WebviewUrl::App(
            format!("index.html?{MONITOR_WINDOW_QUERY_KEY}=monitor&label={MONITOR_LABEL}").into(),
        ),
    )
    .title("Monitor")
    .inner_size(900.0, 700.0)
    .min_inner_size(520.0, 400.0)
    .resizable(true)
    .build()
    .map_err(|error| format!("Could not open Monitor window: {error}"))?;
    Ok(lease)
}

#[tauri::command]
pub fn get_monitor_window_route(
    caller: WebviewWindow,
    registry: tauri::State<'_, MonitorWindowRegistry>,
    label: String,
) -> Result<MonitorLease, String> {
    require_monitor(&caller, &label)?;
    registry
        .leases
        .lock()
        .map_err(|_| "Monitor registry lock is unavailable.".to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| "This Monitor lease is stale.".to_string())
}

#[tauri::command]
pub fn close_monitor_window(
    app: tauri::AppHandle,
    caller: WebviewWindow,
    registry: tauri::State<'_, MonitorWindowRegistry>,
    label: String,
) -> Result<(), String> {
    if caller.label() != "main" {
        require_monitor(&caller, &label)?;
    }
    registry
        .leases
        .lock()
        .map_err(|_| "Monitor registry lock is unavailable.".to_string())?
        .remove(&label);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|error| format!("Could not close Monitor window: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn focus_monitor_route_in_main(
    app: tauri::AppHandle,
    caller: WebviewWindow,
    registry: tauri::State<'_, MonitorWindowRegistry>,
    label: String,
) -> Result<(), String> {
    require_monitor(&caller, &label)?;
    let lease = registry
        .leases
        .lock()
        .map_err(|_| "Monitor registry lock is unavailable.".to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| "This Monitor lease is stale.".to_string())?;
    app.emit_to("main", "monitor-window:focus-main", &lease.route)
        .map_err(|error| format!("Could not route back to the main window: {error}"))?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable.".to_string())?;
    let _ = main.unminimize();
    let _ = main.show();
    main.set_focus()
        .map_err(|error| format!("Could not focus the main window: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_window_app_command_allowlist_is_read_only() {
        for command in MONITOR_ALLOWED_APP_COMMANDS {
            assert!(command_allowed_for_window("monitor-main", command));
        }

        for command in [
            "save_persisted_state",
            "save_conversation",
            "write_file_contents",
            "create_pty_session",
            "start_api_agent_session",
            "send_api_agent_message",
            "respond_permission",
            "respond_edit",
            "open_monitor_window",
        ] {
            assert!(
                !command_allowed_for_window("monitor-main", command),
                "{command} must not be callable by Monitor"
            );
        }

        assert!(command_allowed_for_window("main", "send_api_agent_message"));
        assert!(!command_allowed_for_window(
            "agent-popout",
            "send_api_agent_message"
        ));
        assert!(!command_allowed_for_window(
            "unreviewed-window",
            "load_persisted_state"
        ));
    }

    #[test]
    fn monitor_routes_reject_empty_or_unsafe_ids() {
        assert!(MonitorRoute::Flight {
            flight_id: "flight-123".to_string()
        }
        .validate()
        .is_ok());
        assert!(MonitorRoute::AgentConversation {
            conversation_id: "../secret".to_string()
        }
        .validate()
        .is_err());
        assert!(MonitorRoute::Flight {
            flight_id: String::new()
        }
        .validate()
        .is_err());
    }
}
