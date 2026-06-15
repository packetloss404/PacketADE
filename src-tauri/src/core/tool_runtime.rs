//! Tool execution runtime for API-based agents.
//!
//! Provides a registry of tools that LLM agents can call, along with
//! JSON Schema definitions that get sent to the provider API.

use crate::core::execution::ExecutionTarget;
use crate::core::llm_types::{ToolCall, ToolDefinition, ToolResult};
use crate::core::tool_runtime_ssh;
use std::path::{Path, PathBuf};
use tracing::info;

/// Maximum file size for tool reads (2 MB).
const MAX_FILE_SIZE: u64 = 2_000_000;

/// Maximum command output size (256 KB).
const MAX_OUTPUT_SIZE: usize = 262_144;

/// Default bash command timeout in seconds.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Resolve a user-provided path and validate that it stays inside the workspace.
///
/// Existing path components are canonicalized so symlink targets are checked,
/// while missing leaf components are resolved after the nearest existing
/// ancestor has been canonicalized.
pub(crate) fn resolve_workspace_path(
    path: &str,
    project_path: &str,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let canonical_workspace = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Cannot resolve workspace: {}", e))?;

    let requested = Path::new(path);
    let full = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        Path::new(project_path).join(requested)
    };

    if must_exist || std::fs::symlink_metadata(&full).is_ok() {
        let canonical_path = std::fs::canonicalize(&full)
            .map_err(|e| format!("Cannot resolve path '{}': {}", full.display(), e))?;
        if !canonical_path.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
        return Ok(canonical_path);
    }

    let mut existing = full.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| format!("Cannot resolve path '{}'", full.display()))?;
    }

    let canonical_existing = std::fs::canonicalize(existing)
        .map_err(|e| format!("Cannot resolve path '{}': {}", existing.display(), e))?;
    if !canonical_existing.starts_with(&canonical_workspace) {
        return Err(format!("Path '{}' is outside the project workspace", path));
    }

    let suffix = full
        .strip_prefix(existing)
        .unwrap_or_else(|_| Path::new(""));
    let mut resolved = canonical_existing;
    for component in suffix.components() {
        match component {
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(format!("Cannot resolve path '{}'", full.display()));
            }
        }
    }

    if !resolved.starts_with(&canonical_workspace) {
        return Err(format!("Path '{}' is outside the project workspace", path));
    }

    Ok(resolved)
}

/// Validate that an existing path is within the project workspace.
fn validate_path(path: &str, project_path: &str) -> Result<String, String> {
    resolve_workspace_path(path, project_path, true).map(|p| p.to_string_lossy().to_string())
}

pub(crate) fn truncate_to_char_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    s.truncate(boundary);
}

/// Get all tool definitions for the API request.
///
/// Async because MCP discovery spawns child processes and performs JSON-RPC
/// over stdio. Callers must `.await` it.
pub async fn tool_definitions() -> Vec<ToolDefinition> {
    tool_definitions_with_mcp_allowlist(None).await
}

pub async fn tool_definitions_with_mcp_allowlist(
    enabled_mcp_server_ids: Option<&[String]>,
) -> Vec<ToolDefinition> {
    let base = vec![
        ToolDefinition {
            name: "read_file".to_string(),
            description: "Read the contents of a file. Returns the file text. Use this to understand existing code before making changes.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root, or absolute path within the project."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "write_file".to_string(),
            description: "Write content to a file. Creates the file if it doesn't exist, or overwrites it. Creates parent directories as needed.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root, or absolute path within the project."
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write to the file."
                    }
                },
                "required": ["path", "content"]
            }),
        },
        ToolDefinition {
            name: "list_directory".to_string(),
            description: "List files and directories in a given path. Returns names with [DIR] prefix for directories.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path relative to the project root. Use '.' for the project root."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "bash".to_string(),
            description: "Execute a shell command in the project directory. Returns stdout and stderr. Use for running tests, builds, git commands, etc.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute."
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default 30, max 120)."
                    }
                },
                "required": ["command"]
            }),
        },
        ToolDefinition {
            name: "grep".to_string(),
            description: "Search for a pattern in files. Returns matching lines with file paths and line numbers.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory or file to search in, relative to project root. Default: '.'."
                    },
                    "include": {
                        "type": "string",
                        "description": "Glob pattern to filter files (e.g., '*.rs', '*.ts')."
                    }
                },
                "required": ["pattern"]
            }),
        },
        crate::core::tool_web::web_fetch_definition(),
        crate::core::tool_subagent::spawn_subagent_definition(),
        crate::core::tool_pull_request::create_pull_request_definition(),
    ];
    // Append MCP tool defs discovered from user-configured servers.
    let mut all = base;
    all.extend(crate::core::tool_tasks::task_tool_definitions());
    all.extend(crate::core::mcp_bridge::load_mcp_tool_definitions(enabled_mcp_server_ids).await);
    // Append custom-agent tool defs (~/.claude/agents/<name>.md).
    all.extend(crate::core::tool_custom_agent::load_custom_agent_definitions());
    // Append GitHub tools (gh_list_issues, gh_get_issue, gh_list_prs).
    all.extend(crate::core::tool_github::github_tool_definitions());
    all
}

/// Execute a tool call against either the local project or a remote SSH host.
pub async fn execute_tool(call: &ToolCall, target: &ExecutionTarget) -> ToolResult {
    execute_tool_with_mcp_allowlist(call, target, None).await
}

pub async fn execute_tool_with_mcp_allowlist(
    call: &ToolCall,
    target: &ExecutionTarget,
    enabled_mcp_server_ids: Option<&[String]>,
) -> ToolResult {
    let result = match call.name.as_str() {
        "read_file" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_read_file(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_read_file(&call.arguments, config).await
            }
        },
        "write_file" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_write_file(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_write_file(&call.arguments, config).await
            }
        },
        "list_directory" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_list_directory(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_list_directory(&call.arguments, config).await
            }
        },
        "bash" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_bash(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_bash(&call.arguments, config).await
            }
        },
        "grep" => match target {
            ExecutionTarget::Local { project_path } => {
                execute_grep(&call.arguments, project_path).await
            }
            ExecutionTarget::Ssh { config } => {
                tool_runtime_ssh::execute_grep(&call.arguments, config).await
            }
        },
        "web_fetch" => {
            // Host-agnostic: always runs from the PacketADE process.
            let _ = target;
            crate::core::tool_web::execute_web_fetch(&call.arguments).await
        }
        "spawn_subagent" => {
            // Boxed because spawn_subagent recursively calls execute_tool, and
            // async fn cannot be directly recursive without indirection.
            Box::pin(crate::core::tool_subagent::execute_spawn_subagent(
                &call.arguments,
                target,
            ))
            .await
        }
        "create_pull_request" => {
            crate::core::tool_pull_request::execute_create_pull_request(&call.arguments, target)
                .await
        }
        "task_create" => {
            // Host-agnostic: tasks live in the PacketADE process.
            let _ = target;
            crate::core::tool_tasks::execute_task_create(&call.arguments)
        }
        "task_update" => {
            let _ = target;
            crate::core::tool_tasks::execute_task_update(&call.arguments)
        }
        "task_list" => {
            let _ = target;
            crate::core::tool_tasks::execute_task_list(&call.arguments)
        }
        name if name.starts_with("mcp__") => {
            crate::core::mcp_bridge::execute_mcp_tool(name, &call.arguments, enabled_mcp_server_ids)
                .await
        }
        name if name.starts_with("gh_") => {
            // Host-agnostic: GitHub API calls go from the PacketADE process.
            let _ = target;
            crate::core::tool_github::execute_github_tool(name, &call.arguments).await
        }
        name if name.starts_with("agent_") => {
            // Boxed: custom agents recursively call execute_tool for nested tool dispatch.
            Box::pin(crate::core::tool_custom_agent::execute_custom_agent(
                name,
                &call.arguments,
                target,
            ))
            .await
        }
        _ => Err(format!("Unknown tool: {}", call.name)),
    };

    match result {
        Ok(content) => ToolResult {
            tool_call_id: call.id.clone(),
            content,
            is_error: false,
        },
        Err(err) => ToolResult {
            tool_call_id: call.id.clone(),
            content: format!("Error: {}", err),
            is_error: true,
        },
    }
}

async fn execute_read_file(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;

    let full_path = validate_path(path, project_path)?;
    info!(path = %full_path, "Tool: read_file");

    let metadata =
        std::fs::metadata(&full_path).map_err(|e| format!("Cannot access '{}': {}", path, e))?;

    if !metadata.is_file() {
        return Err(format!("'{}' is not a file", path));
    }

    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_FILE_SIZE
        ));
    }

    std::fs::read_to_string(&full_path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

async fn execute_write_file(
    args: &serde_json::Value,
    project_path: &str,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;
    let content = args
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'content' parameter")?;

    let full_path = resolve_workspace_path(path, project_path, false)?;
    let canonical_workspace = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Cannot resolve workspace: {}", e))?;

    if let Some(parent) = full_path.parent() {
        if !parent.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|e| format!("Cannot resolve parent: {}", e))?;
        if !canonical_parent.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
    }

    if std::fs::symlink_metadata(&full_path).is_ok() {
        let canonical_target = std::fs::canonicalize(&full_path)
            .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
        if !canonical_target.starts_with(&canonical_workspace) {
            return Err(format!("Path '{}' is outside the project workspace", path));
        }
    }

    info!(path = %full_path.display(), "Tool: write_file");
    std::fs::write(&full_path, content)
        .map_err(|e| format!("Failed to write '{}': {}", path, e))?;

    Ok(format!(
        "Successfully wrote {} bytes to {}",
        content.len(),
        path
    ))
}

async fn execute_list_directory(
    args: &serde_json::Value,
    project_path: &str,
) -> Result<String, String> {
    let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");

    let full_path = validate_path(path, project_path)?;
    info!(path = %full_path, "Tool: list_directory");

    let entries =
        std::fs::read_dir(&full_path).map_err(|e| format!("Failed to list '{}': {}", path, e))?;

    let skip_dirs = crate::core::shared::SKIP_DIRS;
    let mut lines: Vec<String> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);

        if is_dir && skip_dirs.contains(&name.as_str()) {
            continue;
        }

        if is_dir {
            lines.push(format!("[DIR] {}", name));
        } else {
            lines.push(name);
        }
    }

    lines.sort();
    Ok(lines.join("\n"))
}

async fn execute_bash(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let command = args
        .get("command")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'command' parameter")?;

    let timeout_secs = args
        .get("timeout")
        .and_then(|t| t.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(120);

    info!(command = %command, timeout = %timeout_secs, "Tool: bash");

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Reap the child if we bail out on the timeout below instead of leaving it
    // running; dropping the `Child` then terminates the OS process.
    cmd.kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Command timed out after {} seconds", timeout_secs))?
    .map_err(|e| format!("Command failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n--- stderr ---\n");
        }
        result.push_str(&stderr);
    }

    // Truncate if too large
    if result.len() > MAX_OUTPUT_SIZE {
        truncate_to_char_boundary(&mut result, MAX_OUTPUT_SIZE);
        result.push_str("\n... [output truncated]");
    }

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code != 0 {
        result.push_str(&format!("\n[exit code: {}]", exit_code));
        return Err(result);
    }

    Ok(result)
}

async fn execute_grep(args: &serde_json::Value, project_path: &str) -> Result<String, String> {
    let pattern = args
        .get("pattern")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'pattern' parameter")?;

    let search_path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");

    let include = args.get("include").and_then(|i| i.as_str());

    let full_path = validate_path(search_path, project_path)?;
    info!(pattern = %pattern, path = %full_path, "Tool: grep");

    let re =
        regex::Regex::new(pattern).map_err(|e| format!("Invalid regex '{}': {}", pattern, e))?;

    let skip_dirs = crate::core::shared::SKIP_DIRS;
    let mut results: Vec<String> = Vec::new();
    let max_results = 100;

    fn walk_dir(
        dir: &Path,
        re: &regex::Regex,
        include: Option<&str>,
        skip_dirs: &[&str],
        results: &mut Vec<String>,
        max_results: usize,
        base_path: &Path,
    ) {
        if results.len() >= max_results {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if results.len() >= max_results {
                return;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let is_dir = path.is_dir();

            if is_dir {
                if skip_dirs.contains(&name.as_str()) {
                    continue;
                }
                walk_dir(
                    &path,
                    re,
                    include,
                    skip_dirs,
                    results,
                    max_results,
                    base_path,
                );
            } else {
                // Check include glob
                if let Some(glob_pattern) = include {
                    if let Ok(glob) = glob::Pattern::new(glob_pattern) {
                        if !glob.matches(&name) {
                            continue;
                        }
                    }
                }

                // Read and search file
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let rel_path = path
                        .strip_prefix(base_path)
                        .unwrap_or(&path)
                        .to_string_lossy();

                    for (line_num, line) in content.lines().enumerate() {
                        if results.len() >= max_results {
                            break;
                        }
                        if re.is_match(line) {
                            results.push(format!("{}:{}: {}", rel_path, line_num + 1, line.trim()));
                        }
                    }
                }
            }
        }
    }

    let base = Path::new(&full_path);
    walk_dir(
        base,
        &re,
        include,
        &skip_dirs,
        &mut results,
        max_results,
        base,
    );

    if results.is_empty() {
        Ok(format!("No matches found for pattern '{}'", pattern))
    } else {
        let mut output = results.join("\n");
        if results.len() >= max_results {
            output.push_str(&format!("\n... [limited to {} results]", max_results));
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::llm_types::ToolCall;
    use serde_json::json;
    use uuid::Uuid;

    fn temp_workspace(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join("packetade-tests").join(format!(
            "{}-{}",
            name,
            Uuid::new_v4()
        ));
        let workspace = base.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        (base, workspace)
    }

    #[cfg(unix)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(original, link)
    }

    #[tokio::test]
    async fn write_file_rejects_escape_before_creating_parent_dirs() {
        let (base, workspace) = temp_workspace("write-escape");
        let outside = base.join("outside");
        let args = json!({
            "path": "../outside/nested/file.txt",
            "content": "nope"
        });

        let err = execute_write_file(&args, &workspace.to_string_lossy())
            .await
            .unwrap_err();

        assert!(err.contains("outside the project workspace"));
        assert!(!outside.exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn write_file_rejects_symlink_parent_target_outside_workspace() {
        let (base, workspace) = temp_workspace("write-symlink");
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = workspace.join("link");
        if symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(base);
            return;
        }
        let args = json!({
            "path": "link/evil.txt",
            "content": "nope"
        });

        let err = execute_write_file(&args, &workspace.to_string_lossy())
            .await
            .unwrap_err();

        assert!(err.contains("outside the project workspace"));
        assert!(!outside.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn local_bash_nonzero_exit_is_error() {
        let (base, workspace) = temp_workspace("bash-error");
        let command = if cfg!(windows) { "exit /B 7" } else { "exit 7" };
        let call = ToolCall {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            arguments: json!({ "command": command }),
        };
        let target = ExecutionTarget::Local {
            project_path: workspace.to_string_lossy().to_string(),
        };

        let result = execute_tool(&call, &target).await;

        assert!(result.is_error);
        assert!(result.content.contains("[exit code: 7]"));
        let _ = std::fs::remove_dir_all(base);
    }
}
