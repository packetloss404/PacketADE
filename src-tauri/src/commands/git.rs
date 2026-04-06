use crate::core::git;

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
