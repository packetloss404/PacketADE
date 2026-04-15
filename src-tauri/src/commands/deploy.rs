use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tracing::info;

use super::shared::hide_window;

#[derive(Clone, Serialize, Deserialize)]
pub struct DeployConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct DeployConfigFile {
    pub configs: Vec<DeployConfig>,
    pub source: String, // "packetcode.deploy.json", "package.json", "auto-detected"
}

#[tauri::command]
pub async fn read_deploy_config(project_path: String) -> Result<DeployConfigFile, String> {
    let base = Path::new(&project_path);

    // 1. Check packetcode.deploy.json
    let deploy_file = base.join("packetcode.deploy.json");
    if deploy_file.exists() {
        let content = fs::read_to_string(&deploy_file).map_err(|e| e.to_string())?;
        let configs: Vec<DeployConfig> =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        return Ok(DeployConfigFile {
            configs,
            source: "packetcode.deploy.json".to_string(),
        });
    }

    // 2. Check package.json scripts
    let package_json = base.join("package.json");
    if package_json.exists() {
        let content = fs::read_to_string(&package_json).map_err(|e| e.to_string())?;
        let parsed: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        let mut configs = Vec::new();

        if let Some(scripts) = parsed.get("scripts").and_then(|v| v.as_object()) {
            for key in ["build", "deploy", "start"] {
                if let Some(cmd) = scripts.get(key).and_then(|v| v.as_str()) {
                    configs.push(DeployConfig {
                        name: format!("npm run {}", key),
                        command: format!("npm run {}", key),
                        env: Default::default(),
                    });
                    let _ = cmd; // used via format above
                }
            }
        }

        if !configs.is_empty() {
            return Ok(DeployConfigFile {
                configs,
                source: "package.json".to_string(),
            });
        }
    }

    // 3. Auto-detect platform configs
    let mut configs = Vec::new();

    if base.join("vercel.json").exists() {
        configs.push(DeployConfig {
            name: "Vercel Deploy".to_string(),
            command: "npx vercel --prod".to_string(),
            env: Default::default(),
        });
    }

    if base.join("netlify.toml").exists() {
        configs.push(DeployConfig {
            name: "Netlify Deploy".to_string(),
            command: "npx netlify deploy --prod".to_string(),
            env: Default::default(),
        });
    }

    if base.join("Dockerfile").exists() {
        configs.push(DeployConfig {
            name: "Docker Build".to_string(),
            command: "docker build -t app .".to_string(),
            env: Default::default(),
        });
    }

    if !configs.is_empty() {
        return Ok(DeployConfigFile {
            configs,
            source: "auto-detected".to_string(),
        });
    }

    Ok(DeployConfigFile {
        configs: Vec::new(),
        source: "none".to_string(),
    })
}

#[tauri::command]
pub async fn create_deploy_config(
    project_path: String,
    configs: Vec<DeployConfig>,
) -> Result<(), String> {
    let file_path = Path::new(&project_path).join("packetcode.deploy.json");
    let pretty = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
    fs::write(&file_path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployValidation {
    pub valid: bool,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub git_branch: String,
    pub has_uncommitted: bool,
}

#[tauri::command]
pub async fn validate_deploy(project_path: String, command: String) -> Result<String, String> {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut git_branch = String::from("unknown");
    let mut has_uncommitted = false;

    // Validate project path
    let base = Path::new(&project_path);
    if !base.is_dir() {
        errors.push(format!("Project path '{}' is not a directory", project_path));
    }

    // Parse command to get the binary name (first word)
    let binary = command
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    if binary.is_empty() {
        errors.push("Deploy command is empty".to_string());
    } else {
        // Check if binary exists
        let check_cmd = if cfg!(windows) { "where" } else { "which" };
        let mut cmd = std::process::Command::new(check_cmd);
        cmd.arg(&binary);
        hide_window(&mut cmd);
        match cmd.output() {
            Ok(output) if output.status.success() => {}
            _ => {
                // Not necessarily an error — could be an npm script or shell builtin
                warnings.push(format!(
                    "Binary '{}' not found in PATH (may still work if it's a shell builtin or npm script)",
                    binary
                ));
            }
        }
    }

    // Check git status
    if base.join(".git").exists() || base.join("../.git").exists() {
        // Get current branch
        let mut branch_cmd = std::process::Command::new("git");
        branch_cmd
            .args(["branch", "--show-current"])
            .current_dir(&project_path);
        hide_window(&mut branch_cmd);
        if let Ok(output) = branch_cmd.output() {
            if output.status.success() {
                git_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
        }

        // Check for uncommitted changes
        let mut status_cmd = std::process::Command::new("git");
        status_cmd
            .args(["status", "--short"])
            .current_dir(&project_path);
        hide_window(&mut status_cmd);
        if let Ok(output) = status_cmd.output() {
            if output.status.success() {
                let status_output = String::from_utf8_lossy(&output.stdout);
                has_uncommitted = !status_output.trim().is_empty();
                if has_uncommitted {
                    warnings.push("There are uncommitted changes in the working directory".to_string());
                }
            }
        }
    } else {
        warnings.push("Not a git repository — cannot check branch or uncommitted changes".to_string());
    }

    let valid = errors.is_empty();

    let validation = DeployValidation {
        valid,
        warnings,
        errors,
        git_branch,
        has_uncommitted,
    };

    serde_json::to_string(&validation).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_deploy(
    app: tauri::AppHandle,
    project_path: String,
    command: String,
    run_id: String,
) -> Result<String, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::thread;
    use tauri::Emitter;
    use uuid::Uuid;

    info!(command = %command, run_id = %run_id, "Starting deploy run");

    super::validate_project_path(&project_path)?;

    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build command through shell so pipes, && etc. work
    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/c");
        c.arg(&command);
        c
    } else {
        let mut c = CommandBuilder::new("bash");
        c.arg("-c");
        c.arg(&command);
        c
    };
    cmd.cwd(&project_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn deploy command: {}", e))?;

    let _pid = child.process_id();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Spawn reader thread — same pattern as create_pty_session but standalone
    // (deploy commands don't go through the PTY manager allowlist)
    let sid = session_id.clone();
    let rid = run_id.clone();
    let app_handle = app.clone();
    let master = pair.master;

    thread::spawn(move || {
        // Keep writer and child alive for the duration of the process
        let _writer = writer;
        let mut _child = child;
        let _master = master;

        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data =
                        crate::core::pty::decode_terminal_chunk(&buf[..n], &mut pending);
                    // Emit on both the standard pty:output channel (for DeployTerminal xterm)
                    // and a deploy-specific channel (for output capture in store)
                    let _ = app_handle.emit(&format!("pty:output:{}", sid), &data);
                    let _ = app_handle.emit(&format!("deploy:output:{}", rid), &data);
                }
                Err(e) => {
                    let err_str = e.to_string();
                    if err_str.contains("broken pipe")
                        || err_str.contains("The pipe has been ended")
                        || e.kind() == std::io::ErrorKind::BrokenPipe
                    {
                        break;
                    }
                    thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        // Try to get exit status
        let exit_code = _child
            .wait()
            .map(|status| status.exit_code())
            .unwrap_or(1);

        info!(session_id = %sid, run_id = %rid, exit_code = exit_code, "Deploy PTY session exited");
        let _ = app_handle.emit(&format!("pty:exit:{}", sid), &sid);
        let _ = app_handle.emit(&format!("deploy:exit:{}", rid), exit_code);
    });

    Ok(session_id)
}
