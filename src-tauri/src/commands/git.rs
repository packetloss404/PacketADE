use crate::core::git;
use crate::core::worktree;

#[tauri::command]
pub async fn get_git_branch(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_branch(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_git_status(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_status(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
    stage_all: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        super::validate_input_size(&message, super::MAX_INPUT_SIZE, "Commit message")?;
        git::commit(&project_path, &message, stage_all)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_push(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::push(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_pull(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::pull(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_create_branch(
    project_path: String,
    branch_name: String,
    checkout: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::create_branch(&project_path, &branch_name, checkout)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_safety_check(project_path: String) -> Result<git::GitSafetyReport, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        Ok(git::safety_check(&project_path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// T3.F: provision a git worktree for an Agents-pane conversation. The
/// worktree lives at `<project_path>/.pkt-worktrees/<conv_id>` on a new
/// branch `pkt/<conv_id>` based off `base_branch`. Returns the absolute
/// worktree path so the frontend can pass it to `start_api_agent_session`
/// as the conversation's `project_path` — every subsequent tool call then
/// runs inside the worktree.
///
/// Idempotent: if the worktree already exists, returns its path.
#[tauri::command]
pub async fn create_conversation_worktree(
    project_path: String,
    conv_id: String,
    base_branch: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    worktree::create_local_worktree(&project_path, &conv_id, &base_branch).await
}

/// T3.F: tear down a worktree previously created by
/// `create_conversation_worktree`. Idempotent — missing worktrees succeed.
#[tauri::command]
pub async fn remove_conversation_worktree(
    project_path: String,
    conv_id: String,
) -> Result<(), String> {
    super::validate_project_path(&project_path)?;
    worktree::remove_local_worktree(&project_path, &conv_id).await
}
