//! PacketADE-owned Claude Code status-line collector.
//!
//! Claude Code accepts an additional `--settings` JSON object for a session.
//! PacketADE injects a status-line command through that seam and re-invokes
//! its own executable in this lightweight helper mode. The helper normalizes
//! Claude's stdin payload into the existing `statusline-state` contract that
//! the frontend polls. This keeps Workspace panes self-contained: users do not
//! have to install a sibling script or modify their global Claude settings.

use crate::core::brand::{
    CLAUDE_STATUSLINE_DIR_ENV, CLAUDE_STATUSLINE_HELPER_ENV, CLAUDE_STATUSLINE_SENTINEL,
};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, PartialEq)]
pub struct ClaudeStatusLineSnapshot {
    pub session_id: String,
    pub model: String,
    pub cwd: String,
    pub dir_name: String,
    pub context_percent: u32,
    pub context_current_k: u32,
    pub context_max_k: u32,
    pub git_branch: String,
    pub cost_usd: f64,
    pub cost_display: String,
    pub duration_minutes: u32,
    pub context_icon: String,
    pub timestamp: u64,
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn number_at(value: &Value, path: &[&str]) -> Option<f64> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_f64)
}

fn integer_at(value: &Value, path: &[&str]) -> Option<u64> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_u64)
}

fn input_tokens(payload: &Value) -> u64 {
    integer_at(payload, &["context_window", "total_input_tokens"]).unwrap_or_else(|| {
        [
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ]
        .into_iter()
        .filter_map(|field| integer_at(payload, &["context_window", "current_usage", field]))
        .sum()
    })
}

fn directory_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

pub fn normalize_payload(
    payload: &Value,
    timestamp: u64,
) -> Result<ClaudeStatusLineSnapshot, String> {
    let session_id = string_at(payload, &["session_id"])
        .ok_or_else(|| "Claude status-line payload has no session_id".to_string())?;
    let cwd = string_at(payload, &["workspace", "current_dir"])
        .or_else(|| string_at(payload, &["cwd"]))
        .ok_or_else(|| "Claude status-line payload has no cwd".to_string())?;
    let model = string_at(payload, &["model", "display_name"])
        .or_else(|| string_at(payload, &["model", "id"]))
        .unwrap_or("Claude Code");
    let context_size =
        integer_at(payload, &["context_window", "context_window_size"]).unwrap_or(200_000);
    let context_percent = number_at(payload, &["context_window", "used_percentage"])
        .unwrap_or_else(|| {
            if context_size == 0 {
                0.0
            } else {
                input_tokens(payload) as f64 * 100.0 / context_size as f64
            }
        })
        .round()
        .clamp(0.0, 100.0) as u32;
    let cost_usd = number_at(payload, &["cost", "total_cost_usd"])
        .unwrap_or(0.0)
        .max(0.0);
    let duration_minutes = integer_at(payload, &["cost", "total_duration_ms"])
        .unwrap_or(0)
        .saturating_div(60_000)
        .min(u32::MAX as u64) as u32;
    let context_icon = match context_percent {
        80..=u32::MAX => "red",
        60..=79 => "amber",
        _ => "green",
    };

    Ok(ClaudeStatusLineSnapshot {
        session_id: session_id.to_string(),
        model: model.to_string(),
        cwd: cwd.to_string(),
        dir_name: directory_name(cwd),
        context_percent,
        context_current_k: input_tokens(payload)
            .saturating_div(1_000)
            .min(u32::MAX as u64) as u32,
        context_max_k: context_size.saturating_div(1_000).min(u32::MAX as u64) as u32,
        // A git process on every refresh would make the hook unnecessarily slow.
        // The native bar treats "-" as intentionally absent.
        git_branch: "-".to_string(),
        cost_usd,
        cost_display: format!("${cost_usd:.2}"),
        duration_minutes,
        context_icon: context_icon.to_string(),
        timestamp,
    })
}

fn safe_session_filename(session_id: &str) -> String {
    let sanitized: String = session_id
        .chars()
        .take(128)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "{}.json",
        if sanitized.is_empty() {
            "unknown"
        } else {
            &sanitized
        }
    )
}

pub fn write_snapshot_to_dir(payload: &Value, state_dir: &Path) -> Result<PathBuf, String> {
    let snapshot = normalize_payload(payload, now_epoch_seconds())?;
    fs::create_dir_all(state_dir)
        .map_err(|error| format!("Could not create {}: {error}", state_dir.display()))?;

    let target = state_dir.join(safe_session_filename(&snapshot.session_id));
    let temporary = state_dir.join(format!(
        ".{}.{}.tmp",
        safe_session_filename(&snapshot.session_id),
        std::process::id()
    ));
    let bytes = serde_json::to_vec(&snapshot)
        .map_err(|error| format!("Could not serialize Claude status line: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;

    if fs::rename(&temporary, &target).is_err() {
        // Windows does not replace an existing destination atomically. Keep the
        // `.tmp` suffix until the complete replacement is ready, then perform
        // the narrow remove-and-rename fallback.
        let _ = fs::remove_file(&target);
        fs::rename(&temporary, &target)
            .map_err(|error| format!("Could not replace {}: {error}", target.display()))?;
    }
    Ok(target)
}

pub fn default_state_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("statusline-state"))
}

pub fn settings_json() -> String {
    let command = if cfg!(windows) {
        format!(
            "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command '& $env:{} {}'",
            CLAUDE_STATUSLINE_HELPER_ENV, CLAUDE_STATUSLINE_SENTINEL
        )
    } else {
        format!(
            "\"${}\" {}",
            CLAUDE_STATUSLINE_HELPER_ENV, CLAUDE_STATUSLINE_SENTINEL
        )
    };
    serde_json::json!({
        "statusLine": {
            "type": "command",
            "command": command,
            "refreshInterval": 5
        }
    })
    .to_string()
}

/// Handle the self-reinvoked collector mode before the Tauri runtime starts.
pub fn helper_main() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref()
        != Some(std::ffi::OsStr::new(CLAUDE_STATUSLINE_SENTINEL))
    {
        return None;
    }

    let state_dir = std::env::var_os(CLAUDE_STATUSLINE_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(default_state_dir);
    let Some(state_dir) = state_dir else {
        return Some(1);
    };

    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return Some(1);
    }
    let payload: Value = match serde_json::from_str(&input) {
        Ok(payload) => payload,
        Err(_) => return Some(1),
    };
    Some(if write_snapshot_to_dir(&payload, &state_dir).is_ok() {
        0
    } else {
        1
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> Value {
        serde_json::json!({
            "cwd": "C:\\repo\\fallback",
            "session_id": "session/abc",
            "model": { "id": "claude-opus-4-7", "display_name": "Opus" },
            "workspace": { "current_dir": "D:\\projects\\PacketADE" },
            "cost": { "total_cost_usd": 0.01234, "total_duration_ms": 125000 },
            "context_window": {
                "total_input_tokens": 15500,
                "context_window_size": 200000,
                "used_percentage": 7.75
            }
        })
    }

    #[test]
    fn normalizes_the_current_claude_statusline_contract() {
        let snapshot = normalize_payload(&sample_payload(), 42).unwrap();

        assert_eq!(snapshot.session_id, "session/abc");
        assert_eq!(snapshot.model, "Opus");
        assert_eq!(snapshot.cwd, "D:\\projects\\PacketADE");
        assert_eq!(snapshot.dir_name, "PacketADE");
        assert_eq!(snapshot.context_percent, 8);
        assert_eq!(snapshot.context_current_k, 15);
        assert_eq!(snapshot.context_max_k, 200);
        assert_eq!(snapshot.cost_display, "$0.01");
        assert_eq!(snapshot.duration_minutes, 2);
        assert_eq!(snapshot.timestamp, 42);
    }

    #[test]
    fn writes_the_existing_frontend_state_contract_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_snapshot_to_dir(&sample_payload(), dir.path()).unwrap();

        assert_eq!(path.file_name().unwrap(), "session_abc.json");
        let written: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(written["cwd"], "D:\\projects\\PacketADE");
        assert_eq!(written["model"], "Opus");
        assert!(fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn injected_settings_are_scoped_and_refresh_the_native_bar() {
        let settings: Value = serde_json::from_str(&settings_json()).unwrap();
        let command = settings["statusLine"]["command"].as_str().unwrap();

        assert_eq!(settings["statusLine"]["type"], "command");
        assert_eq!(settings["statusLine"]["refreshInterval"], 5);
        assert!(command.contains(CLAUDE_STATUSLINE_HELPER_ENV));
        assert!(command.contains(CLAUDE_STATUSLINE_SENTINEL));
    }
}
