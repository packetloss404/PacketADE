use std::process::Command;

/// Check if a CLI agent command is installed and available on PATH.
/// On Windows, also checks for .cmd wrapper (e.g., claude.cmd, codex.cmd).
pub fn detect_agent(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        // Try the base command
        if let Ok(output) = Command::new("where").arg(command).output() {
            if output.status.success() {
                return true;
            }
        }
        // Try .cmd extension
        let cmd_name = format!("{}.cmd", command);
        if let Ok(output) = Command::new("where").arg(&cmd_name).output() {
            return output.status.success();
        }
        false
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("which")
            .arg(command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}
