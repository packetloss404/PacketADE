use crate::commands::shared::home_dir;
use crate::core::brand::DATA_DIR_NAME;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationConfig {
    pub model_size: String,
    /// Stable CPAL device identity. Preferred over the legacy enumeration
    /// index so settings survive restarts and device-list reordering.
    pub device_id: Option<String>,
    /// Legacy migration fallback only.
    pub device_index: Option<u32>,
    pub custom_dictionary: Vec<String>,
    pub auto_paste: bool,
    /// Whisper language code, or "auto" to let Whisper detect the language.
    pub language: String,
    /// Opt-in native paste into the foreground application when no PacketBench
    /// text field is active. Clipboard-only fallback remains the safe default.
    pub system_wide_paste: bool,
    /// OS-global accelerator string for push-to-talk (hold). See
    /// `useDictationGlobalShortcuts.ts` for accelerator syntax. `None` =
    /// fall back to the hardcoded default in the hook.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_to_talk_shortcut: Option<String>,
    /// OS-global accelerator for toggle-recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle_shortcut: Option<String>,
    /// Global shortcuts are an explicit trust choice. In-app controls and the
    /// Escape cancellation shortcut remain available when this is disabled.
    pub global_shortcuts_enabled: bool,
    /// Hard capture ceiling. This bounds retained PCM even if a release event
    /// is missed or the frontend is temporarily unavailable.
    pub max_duration_seconds: u32,
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            model_size: "small".to_string(),
            device_id: None,
            device_index: None,
            custom_dictionary: Vec::new(),
            auto_paste: false,
            language: "auto".to_string(),
            system_wide_paste: false,
            push_to_talk_shortcut: None,
            toggle_shortcut: None,
            global_shortcuts_enabled: false,
            max_duration_seconds: 300,
        }
    }
}

fn normalize_config(mut config: DictationConfig) -> DictationConfig {
    config.max_duration_seconds = config.max_duration_seconds.clamp(10, 1_800);
    if config.language.trim().is_empty() {
        config.language = "auto".to_string();
    }
    config
}

/// Return the path to ~/.packetbench/dictation.json.
fn config_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Could not resolve home directory")?;
    let dir = PathBuf::from(&home).join(DATA_DIR_NAME);
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {DATA_DIR_NAME} dir: {e}"))?;
    }
    Ok(dir.join("dictation.json"))
}

#[tauri::command]
pub fn get_dictation_settings() -> Result<String, String> {
    let config = read_dictation_config()?;
    serde_json::to_string(&config).map_err(|e| format!("JSON serialization error: {e}"))
}

pub(crate) fn read_dictation_config() -> Result<DictationConfig, String> {
    let path = config_path()?;
    let mut config = normalize_config(if path.exists() {
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
        match serde_json::from_str::<DictationConfig>(&contents) {
            Ok(cfg) => cfg,
            Err(err) => {
                tracing::warn!(
                    "Corrupt dictation config at {:?} ({err}); falling back to defaults",
                    path
                );
                DictationConfig::default()
            }
        }
    } else {
        DictationConfig::default()
    });

    // Repair stale model selections when a different verified model is already
    // available. This covers upgrades from the pre-checksum model installer.
    if let Ok((resolved_size, _)) = super::models::resolve_verified_model(&config.model_size) {
        if resolved_size != config.model_size {
            tracing::warn!(
                configured = %config.model_size,
                resolved = %resolved_size,
                "Selected dictation model is unavailable; using a verified local model"
            );
            config.model_size = resolved_size;
            if let Ok(json) = serde_json::to_string_pretty(&config) {
                if let Err(err) = fs::write(&path, json) {
                    tracing::warn!("Failed to persist repaired dictation model selection: {err}");
                }
            }
        }
    }

    Ok(config)
}

#[tauri::command]
pub fn set_dictation_settings(settings: String) -> Result<(), String> {
    let path = config_path()?;

    // Validate that the input is valid DictationConfig JSON
    let config: DictationConfig =
        serde_json::from_str(&settings).map_err(|e| format!("Invalid settings JSON: {e}"))?;
    let config = normalize_config(config);
    let settings = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("JSON serialization error: {e}"))?;

    fs::write(&path, &settings).map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_receive_safe_language_and_delivery_defaults() {
        let config: DictationConfig = serde_json::from_str(
            r#"{
                "modelSize": "base",
                "deviceIndex": null,
                "customDictionary": ["PacketBench"],
                "autoPaste": true
            }"#,
        )
        .expect("legacy settings should remain readable");

        assert_eq!(config.language, "auto");
        assert!(!config.system_wide_paste);
        assert!(!config.global_shortcuts_enabled);
        assert_eq!(config.max_duration_seconds, 300);
        assert_eq!(config.device_id, None);
        assert_eq!(config.custom_dictionary, vec!["PacketBench"]);
    }

    #[test]
    fn unsafe_capture_limits_are_clamped() {
        let mut config = DictationConfig::default();
        config.max_duration_seconds = 0;
        assert_eq!(normalize_config(config).max_duration_seconds, 10);

        let mut config = DictationConfig::default();
        config.max_duration_seconds = 99_999;
        assert_eq!(normalize_config(config).max_duration_seconds, 1_800);
    }
}
