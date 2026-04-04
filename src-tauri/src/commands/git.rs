use crate::core::git;

#[tauri::command]
pub fn get_git_branch(project_path: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    git::get_branch(&project_path)
}

#[tauri::command]
pub fn get_git_status(project_path: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    git::get_status(&project_path)
}

#[tauri::command]
pub fn git_commit(
    project_path: String,
    message: String,
    stage_all: bool,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    git::commit(&project_path, &message, stage_all)
}

#[tauri::command]
pub fn git_push(project_path: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    git::push(&project_path)
}

#[tauri::command]
pub fn git_pull(project_path: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    git::pull(&project_path)
}

#[tauri::command]
pub fn git_create_branch(
    project_path: String,
    branch_name: String,
    checkout: bool,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    git::create_branch(&project_path, &branch_name, checkout)
}

#[tauri::command]
pub fn git_safety_check(project_path: String) -> Result<git::GitSafetyReport, String> {
    super::validate_project_path(&project_path)?;
    Ok(git::safety_check(&project_path))
}
