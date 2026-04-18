//! Claude-Code-style task management tools for API agents.
//!
//! Exposes `task_create`, `task_update`, and `task_list` so the agent can track
//! its own multi-step work and surface a checklist back to the user.
//!
//! # State scope (v1 caveat)
//!
//! Tasks live in a single process-wide `Mutex<Vec<Task>>` shared across every
//! API conversation. This is acceptable for v1 because tasks are usually
//! scoped to one active conversation at a time. A follow-up should key tasks
//! by `session_id` once `tool_runtime::execute_tool` threads that context
//! through.

use crate::core::llm_types::ToolDefinition;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tracing::info;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl TaskStatus {
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            other => Err(format!(
                "Unknown status '{}': expected pending|in_progress|completed",
                other
            )),
        }
    }

    fn checklist_marker(&self) -> &'static str {
        match self {
            Self::Pending => "- [ ]",
            Self::InProgress => "- [~]",
            Self::Completed => "- [x]",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
}

/// Process-wide task list. See module docs for the v1 scope caveat.
static TASKS: OnceLock<Mutex<Vec<Task>>> = OnceLock::new();

fn tasks() -> &'static Mutex<Vec<Task>> {
    TASKS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Tool definitions advertised to the LLM provider.
pub fn task_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "task_create".to_string(),
            description: "Create a new task in your todo list. Use this when planning multi-step work so the user can see your progress. Returns the new task id.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short, action-oriented title (e.g., 'Add task tools to runtime')."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed"],
                        "description": "Initial status. Defaults to 'pending'."
                    }
                },
                "required": ["title"]
            }),
        },
        ToolDefinition {
            name: "task_update".to_string(),
            description: "Update an existing task's status and/or title. Call this as soon as you start a task (status: in_progress) and again when you finish it (status: completed).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The id returned from task_create."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed"],
                        "description": "New status."
                    },
                    "title": {
                        "type": "string",
                        "description": "New title (optional)."
                    }
                },
                "required": ["task_id"]
            }),
        },
        ToolDefinition {
            name: "task_list".to_string(),
            description: "List all current tasks as a markdown checklist. Use this to re-orient yourself or to surface progress to the user.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        },
    ]
}

pub fn execute_task_create(args: &serde_json::Value) -> Result<String, String> {
    let title = args
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'title' parameter")?
        .trim()
        .to_string();

    if title.is_empty() {
        return Err("'title' must not be empty".to_string());
    }

    let status = match args.get("status").and_then(|s| s.as_str()) {
        Some(s) => TaskStatus::from_str(s)?,
        None => TaskStatus::Pending,
    };

    let id = Uuid::new_v4().to_string();
    let task = Task {
        id: id.clone(),
        title: title.clone(),
        status,
    };

    info!(task_id = %id, title = %title, "Tool: task_create");

    let mut tasks = tasks()
        .lock()
        .map_err(|e| format!("Task store poisoned: {}", e))?;
    tasks.push(task);
    Ok(id)
}

pub fn execute_task_update(args: &serde_json::Value) -> Result<String, String> {
    let task_id = args
        .get("task_id")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task_id' parameter")?;

    let new_status = match args.get("status").and_then(|s| s.as_str()) {
        Some(s) => Some(TaskStatus::from_str(s)?),
        None => None,
    };
    let new_title = args
        .get("title")
        .and_then(|t| t.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if new_status.is_none() && new_title.is_none() {
        return Err("Provide at least one of 'status' or 'title' to update".to_string());
    }

    let mut tasks = tasks()
        .lock()
        .map_err(|e| format!("Task store poisoned: {}", e))?;

    let task = tasks
        .iter_mut()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("No task with id '{}'", task_id))?;

    if let Some(status) = new_status {
        task.status = status;
    }
    if let Some(title) = new_title {
        task.title = title;
    }

    info!(task_id = %task_id, "Tool: task_update");
    Ok("updated".to_string())
}

pub fn execute_task_list(_args: &serde_json::Value) -> Result<String, String> {
    let tasks = tasks()
        .lock()
        .map_err(|e| format!("Task store poisoned: {}", e))?;

    if tasks.is_empty() {
        return Ok("(no tasks yet)".to_string());
    }

    let lines: Vec<String> = tasks
        .iter()
        .map(|t| format!("{} {}", t.status.checklist_marker(), t.title))
        .collect();

    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test-only serialization. The global TASKS state means parallel test
    /// execution leaks between cases; each test acquires this lock so the
    /// suite is deterministic without needing an external `serial_test` dep.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn reset() {
        tasks().lock().unwrap().clear();
    }

    #[test]
    fn create_update_list_roundtrip() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let id = execute_task_create(&serde_json::json!({ "title": "alpha" })).unwrap();
        let _ = execute_task_create(&serde_json::json!({
            "title": "beta",
            "status": "in_progress"
        }))
        .unwrap();

        execute_task_update(&serde_json::json!({
            "task_id": id,
            "status": "completed"
        }))
        .unwrap();

        let md = execute_task_list(&serde_json::json!({})).unwrap();
        assert!(md.contains("- [x] alpha"));
        assert!(md.contains("- [~] beta"));
    }

    #[test]
    fn rejects_unknown_status() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let err = execute_task_create(&serde_json::json!({
            "title": "x",
            "status": "bogus"
        }))
        .unwrap_err();
        assert!(err.contains("Unknown status"));
    }

    /// v1 caveat captured: all tasks live in one process-wide list, so two
    /// "sessions" creating their own tasks see each other's work. When
    /// session-keyed storage lands, this test flips to asserting isolation.
    #[test]
    fn global_state_leaks_across_sessions_v1_caveat() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        // "Session A" creates a task.
        let _ = execute_task_create(&serde_json::json!({
            "title": "session-a-task"
        }))
        .unwrap();

        // "Session B" lists and sees session A's work. In a per-session
        // world this should be empty; today it's not. Document the leak.
        let md = execute_task_list(&serde_json::json!({})).unwrap();
        assert!(
            md.contains("session-a-task"),
            "v1 task list is globally shared; update this test when storage becomes session-keyed"
        );
    }
}
