pub mod api;
pub mod core;
mod claude;
mod commands;

use commands::api_agent::ApiAgentState;
use commands::github::create_github_auth_state;
use commands::pty::create_shared_pty_manager;
use commands::orchestration::create_shared_orchestrator;
use commands::dictation::audio::create_dictation_state;

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let log_dir = dirs_log_dir();
    let file_appender = tracing_appender::rolling::daily(log_dir, "packetcode.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Leak the guard so the writer stays alive for the process lifetime
    std::mem::forget(_guard);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .init();
}

fn dirs_log_dir() -> std::path::PathBuf {
    use crate::core::brand::LOG_DIR_NAME;
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                format!("{}/.local/share", home)
            });
        std::path::PathBuf::from(base).join(LOG_DIR_NAME).join("logs")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        std::path::PathBuf::from(home)
            .join("Library/Application Support")
            .join(LOG_DIR_NAME)
            .join("logs")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("APPDATA"))
            .unwrap_or_else(|_| "C:\\ProgramData".to_string());
        std::path::PathBuf::from(appdata).join(LOG_DIR_NAME).join("logs")
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    // Rename ~/.packetcode → ~/.packetade once per upgrade. Must run before
    // any command that reads/writes the data dir.
    core::migration::migrate_data_dir();
    commands::crashes::install_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(create_github_auth_state())
        .manage(create_shared_pty_manager())
        .manage(create_shared_orchestrator())
        .manage(create_dictation_state())
        .manage(std::sync::Arc::new(ApiAgentState::new()))
        .invoke_handler(tauri::generate_handler![
            // PTY-based sessions (primary)
            commands::pty::create_pty_session,
            commands::pty::write_pty,
            commands::pty::resize_pty,
            commands::pty::kill_pty,
            commands::pty::kill_pty_and_wait,
            commands::pty::list_pty_sessions,
            commands::pty::read_pty_transcript,
            commands::pty::ssh_exec,
            commands::pty::ssh_test_connection,
            commands::ssh_keys::set_ssh_password,
            commands::ssh_keys::delete_ssh_password,
            commands::ssh_keys::get_ssh_password_exists,
            // Git
            commands::git::get_git_branch,
            commands::git::get_git_status,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_create_branch,
            commands::git::git_safety_check,
            // Code quality
            commands::code_quality::analyze_code_quality,
            // Crash reports
            commands::crashes::list_crashes,
            commands::crashes::read_crash,
            commands::crashes::delete_crash,
            // Filesystem
            commands::fs::list_directory,
            commands::fs::list_subdirectories,
            commands::fs::get_cwd,
            commands::fs::read_file_contents,
            commands::fs::write_file_contents,
            commands::fs::list_project_files,
            commands::fs::read_file_for_diff,
            // Flight lifecycle orchestration
            commands::flight_attempts::launch_flight_async,
            commands::flight_attempts::cancel_flight_attempt,
            commands::flight_attempts::cleanup_attempt_worktree_ssh,
            commands::flight_attempts::mark_attempt_status,
            commands::orchestration::launch_flight,
            commands::orchestration::pause_flight,
            commands::orchestration::resume_flight,
            commands::orchestration::cancel_flight,
            commands::orchestration::orchestration_tick,
            commands::orchestration::get_orchestration_state,
            commands::orchestration::record_task_spawn,
            commands::orchestration::notify_task_complete,
            commands::orchestration::notify_approval_needed,
            commands::orchestration::notify_approval_resolved,
            // Unified persisted state
            commands::state::load_persisted_state,
            commands::state::save_persisted_state,
            commands::state::save_flights_slice,
            commands::state::save_agents_slice,
            commands::state::save_settings_slice,
            commands::state::save_ui_slice,
            commands::state::save_issues_slice,
            commands::state::save_workspaces_slice,
            commands::state::save_memory_slice,
            commands::state::save_servers_slice,
            // Agent detection
            commands::agent::detect_agent,
            // Status line
            commands::statusline::claude::read_statusline_states,
            commands::statusline::codex::read_codex_statusline_states,
            commands::statusline::gemini::read_gemini_statusline_states,
            commands::statusline::opencode::read_opencode_statusline_states,
            // Spec parsing
            commands::spec::parse_spec_to_flight,
            commands::spec::parse_spec_to_tickets,
            // Agent-chat side panel streaming (was Insights; Insights folded into
            // the Agents pane via the Scout profile).
            commands::insights::ask_agent_chat_stream,
            // Flight chat
            commands::flight_chat::ask_flight_chat_stream,
            // Side chat (ephemeral context-aware helper)
            commands::side_chat::ask_side_chat_stream,
            // Ideation scanner
            commands::ideation::generate_ideas,
            // GitHub integration
            commands::github::github_set_token,
            commands::github::github_clear_token,
            commands::github::github_has_token,
            commands::github::github_list_repos,
            commands::github::github_list_issues,
            commands::github::github_get_issue,
            commands::github::github_create_pr,
            commands::github::github_list_prs,
            commands::github::github_get_pr_diff,
            commands::github::github_investigate_issue,
            // Memory layer
            commands::memory::scan_codebase_memory,
            commands::memory::summarize_session,
            commands::memory::extract_patterns,
            commands::memory::summarize_flight,
            // Prompt history
            commands::history::read_prompt_history,
            // Usage analytics
            commands::analytics::read_usage_analytics,
            // MCP server management
            commands::mcp::read_mcp_servers,
            commands::mcp::write_mcp_server,
            commands::mcp::delete_mcp_server,
            // Project scaffolding
            commands::scaffold::scaffold_project,
            commands::scaffold::check_scaffold_tools,
            // Dictation / audio capture
            commands::dictation::list_audio_devices,
            commands::dictation::start_recording,
            commands::dictation::stop_recording,
            commands::dictation::get_dictation_history,
            commands::dictation::search_dictation_history,
            commands::dictation::insert_dictation_entry,
            commands::dictation::get_dictation_analytics,
            commands::dictation::get_dictation_settings,
            commands::dictation::set_dictation_settings,
            commands::dictation::list_whisper_models,
            commands::dictation::download_whisper_model,
            commands::dictation::delete_whisper_model,
            // Deploy pipeline
            commands::deploy::read_deploy_config,
            commands::deploy::create_deploy_config,
            commands::deploy::validate_deploy,
            commands::deploy::run_deploy,
            // API keys
            commands::api_keys::set_api_key,
            commands::api_keys::get_api_key_exists,
            commands::api_keys::delete_api_key,
            // API agent sessions
            commands::api_agent::start_api_agent_session,
            commands::api_agent::send_api_agent_message,
            commands::api_agent::cancel_api_agent_session,
            commands::api_agent::close_api_agent_session,
            commands::api_agent::change_model,
            commands::api_agent::set_plan_mode,
            commands::api_agent::set_permission_mode,
            commands::api_agent::respond_permission,
            commands::api_agent::set_approve_writes,
            commands::api_agent::respond_edit,
            commands::api_agent::retry_last_turn,
            // Agent conversation persistence
            commands::conversations::save_conversation,
            commands::conversations::load_conversations,
            commands::conversations::delete_conversation_file,
            commands::conversations::export_conversation_markdown,
            // Checkpoints
            commands::checkpoints::save_checkpoint,
            commands::checkpoints::list_checkpoints,
            commands::checkpoints::delete_checkpoint,
            // Slash commands (user-defined)
            commands::slash_commands::list_slash_commands,
            // Skills (Claude-Code-style ~/.claude/skills/<name>/SKILL.md)
            commands::skills::list_skills,
            // Custom agents (Claude-Code-style ~/.claude/agents/<name>.md)
            commands::custom_agents::list_custom_agents,
            // Pricing / cost helpers
            commands::pricing::calculate_turn_cost,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
