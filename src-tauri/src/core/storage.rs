use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use serde::{Serialize, de::DeserializeOwned};
use tracing::{info, warn};

use super::agent_config::AgentConfig;
use super::flight::{Flight, ApprovalDecision, Issue};
use super::orchestrator::OrchestratorSettings;
use super::shared::home_dir;
use super::workspace::Workspace;

pub const STATE_FILENAME: &str = "state.v1.json";

static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
pub struct PersistedUiState {
    pub selected_flight_id: Option<String>,
    pub selected_view: Option<String>,
    pub theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct PersistedState {
    pub version: u32,
    pub flights: Vec<Flight>,
    pub agents: Vec<AgentConfig>,
    pub settings: OrchestratorSettings,
    pub ui: PersistedUiState,
    #[serde(default)]
    pub issues: Vec<Issue>,
    #[serde(default)]
    pub approval_log: Vec<ApprovalDecision>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: 1,
            flights: Vec::new(),
            agents: Vec::new(),
            settings: OrchestratorSettings::default(),
            ui: PersistedUiState::default(),
            issues: Vec::new(),
            approval_log: Vec::new(),
            workspaces: Vec::new(),
        }
    }
}

/// Get the PacketCode data directory (~/.packetcode/)
pub fn data_dir() -> PathBuf {
    let home = home_dir().unwrap_or_else(|| ".".to_string());
    PathBuf::from(home).join(".packetcode")
}

/// Ensure the data directory exists.
pub fn ensure_data_dir() -> Result<PathBuf, String> {
    let dir = data_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create data dir {:?}: {}", dir, e))?;
        info!("Created PacketCode data dir: {:?}", dir);
    }
    Ok(dir)
}

/// Load a JSON file from the data directory. Returns default if file doesn't exist.
pub fn load<T: DeserializeOwned + Default>(filename: &str) -> T {
    let path = data_dir().join(filename);
    match fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|e| {
                warn!("Failed to parse {:?}: {}, using default", path, e);
                T::default()
            })
        }
        Err(_) => T::default(),
    }
}

/// Save a value as JSON to the data directory.
pub fn save<T: Serialize>(filename: &str, data: &T) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    let path = dir.join(filename);
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    write_with_backup(&path, &json)?;
    Ok(())
}

pub fn load_state() -> PersistedState {
    let path = data_dir().join(STATE_FILENAME);
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<PersistedState>(&content) {
            Ok(state) => state,
            Err(e) => {
                warn!("Failed to parse {:?}: {}, falling back to legacy files", path, e);
                load_legacy_state()
            }
        },
        Err(_) => load_legacy_state(),
    }
}

fn save_state_inner(state: &PersistedState) -> Result<(), String> {
    let dir = ensure_data_dir()?;
    let path = dir.join(STATE_FILENAME);
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize persisted state: {}", e))?;
    write_with_backup(&path, &json)?;
    Ok(())
}

pub fn save_state(state: &PersistedState) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = state.clone();
    state.version += 1;
    save_state_inner(&state)
}

pub fn save_flights(flights: Vec<Flight>) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.flights = flights;
    state.version += 1;
    save_state_inner(&state)
}

pub fn save_agents(agents: Vec<AgentConfig>) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.agents = agents;
    state.version += 1;
    save_state_inner(&state)
}

pub fn save_settings(settings: OrchestratorSettings) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.settings = settings;
    state.version += 1;
    save_state_inner(&state)
}

pub fn save_ui(ui: PersistedUiState) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.ui = ui;
    state.version += 1;
    save_state_inner(&state)
}

fn load_legacy_state() -> PersistedState {
    PersistedState {
        version: 1,
        flights: load("flights.json"),
        agents: load("agents.json"),
        settings: load("settings.json"),
        ui: PersistedUiState::default(),
        issues: Vec::new(),
        approval_log: Vec::new(),
        workspaces: Vec::new(),
    }
}

pub fn save_issues(issues: Vec<Issue>) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.issues = issues;
    state.version += 1;
    save_state_inner(&state)
}

pub fn save_workspaces(workspaces: Vec<Workspace>) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.workspaces = workspaces;
    state.version += 1;
    save_state_inner(&state)
}

pub fn save_approval(decision: ApprovalDecision) -> Result<(), String> {
    let _lock = STATE_LOCK.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut state = load_state();
    state.approval_log.push(decision);
    state.version += 1;
    save_state_inner(&state)
}

fn write_with_backup(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp_path = path.with_extension(format!("{}.tmp", path.extension().and_then(|ext| ext.to_str()).unwrap_or("json")));
    let backup_path = path.with_extension(format!("{}.bak", path.extension().and_then(|ext| ext.to_str()).unwrap_or("json")));

    {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create {:?}: {}", tmp_path, e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write {:?}: {}", tmp_path, e))?;
        file.flush()
            .map_err(|e| format!("Failed to flush {:?}: {}", tmp_path, e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync {:?}: {}", tmp_path, e))?;
    }

    if path.exists() {
        let previous = fs::read(path)
            .map_err(|e| format!("Failed to read existing {:?}: {}", path, e))?;
        fs::write(&backup_path, previous)
            .map_err(|e| format!("Failed to write backup {:?}: {}", backup_path, e))?;
    }

    if path.exists() {
        fs::remove_file(path)
            .map_err(|e| format!("Failed to replace {:?}: {}", path, e))?;
    }

    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to replace {:?}: {}", path, e))?;

    Ok(())
}
