use crate::commands::shared::home_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationConfig {
    pub model_size: String,
    pub device_index: Option<u32>,
    pub custom_dictionary: Vec<String>,
    pub auto_paste: bool,
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            model_size: "small".to_string(),
            device_index: None,
            custom_dictionary: Vec::new(),
            auto_paste: false,
        }
    }
}

/// Return the path to ~/.packetcode/dictation.json.
fn config_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Could not resolve home directory")?;
    let dir = PathBuf::from(&home).join(".packetcode");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .packetcode dir: {e}"))?;
    }
    Ok(dir.join("dictation.json"))
}

#[tauri::command]
pub fn get_dictation_settings() -> Result<String, String> {
    let path = config_path()?;

    let config = if path.exists() {
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
        serde_json::from_str::<DictationConfig>(&contents).unwrap_or_default()
    } else {
        DictationConfig::default()
    };

    serde_json::to_string(&config).map_err(|e| format!("JSON serialization error: {e}"))
}

#[tauri::command]
pub fn set_dictation_settings(settings: String) -> Result<(), String> {
    let path = config_path()?;

    // Validate that the input is valid DictationConfig JSON
    let _: DictationConfig =
        serde_json::from_str(&settings).map_err(|e| format!("Invalid settings JSON: {e}"))?;

    fs::write(&path, &settings).map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}
