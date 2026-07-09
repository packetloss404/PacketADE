pub mod api;
mod claude;
mod commands;
pub mod core;

use commands::agent_sidecar::SidecarManager;
use commands::api_agent::ApiAgentState;
use commands::code_quality_autofix::CodeQualityAutoFixState;
use commands::dictation::audio::create_dictation_state;
use commands::dictation::whisper::WhisperState;
use commands::github::create_github_auth_state;
use commands::flight_planner::{spawn_wake_consumer, FlightPlannerRegistry};
use commands::orchestration::create_shared_orchestrator;
use commands::pty::create_shared_pty_manager;
use commands::quality_runner::QualityRunnerState;

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let log_dir = dirs_log_dir();
    let file_appender = tracing_appender::rolling::daily(log_dir, "packetade.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Leak the guard so the writer stays alive for the process lifetime
    std::mem::forget(_guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

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
        let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{}/.local/share", home)
        });
        std::path::PathBuf::from(base)
            .join(LOG_DIR_NAME)
            .join("logs")
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
        std::path::PathBuf::from(appdata)
            .join(LOG_DIR_NAME)
            .join("logs")
    }
}

/// PTY spawn helper. Re-invoked as
/// `packetade __pty_spawn <cwd> <program> <args...>` by the vendored
/// portable-pty (`UnixSlavePty::spawn_command`), with the slave pty wired to
/// fd 0/1/2. This runs in a fresh, single-threaded process that the parent
/// created via `posix_spawn` (fork-safe in a multi-threaded host), so it can
/// safely become a session leader, claim the pty as its controlling terminal,
/// chdir, and exec the real program. Never returns.
#[cfg(unix)]
pub fn pty_spawn_helper(args: &[std::ffi::OsString]) -> ! {
    use std::os::unix::ffi::OsStrExt;

    // args = [cwd, program, arg1, ...]
    let cwd = args.first().cloned().unwrap_or_default();
    let exec_argv = args.get(1..).unwrap_or(&[]);

    unsafe {
        if !cwd.is_empty() {
            if let Ok(c) = std::ffi::CString::new(cwd.as_bytes()) {
                libc::chdir(c.as_ptr());
            }
        }
        // Become a session leader and claim the pty (fd 0) as the controlling
        // terminal so SIGWINCH/job control work for the TUI CLIs.
        libc::setsid();
        libc::ioctl(0, libc::TIOCSCTTY as _, 0);
    }

    let c_args: Vec<std::ffi::CString> = exec_argv
        .iter()
        .filter_map(|a| std::ffi::CString::new(a.as_bytes()).ok())
        .collect();
    if c_args.is_empty() {
        std::process::exit(127);
    }
    let mut ptrs: Vec<*const libc::c_char> = c_args.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe {
        libc::execvp(ptrs[0], ptrs.as_ptr());
    }
    // Only reached if exec failed.
    std::process::exit(127);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Repair PATH for GUI launches (Finder/Dock/Spotlight give us only the
    // minimal launchd PATH). Reconstructs PATH from known install dirs + the
    // user's shell rc files *without executing the shell*, so it never trips
    // privacy prompts via the user's config. Must run before the sidecar, PTY,
    // or any CLI lookup (`which claude`, `gh`, `git`, `node`, …).
    //
    // CRITICAL: this calls `std::env::set_var`, which is only sound while the
    // process is single-threaded. It MUST run before anything spawns a thread —
    // notably `init_tracing()` below, which starts a background log-writer
    // thread. Mutating `environ` once another thread exists is UB and corrupts
    // the environment such that a later PTY `fork()`+`exec()` aborts in the
    // child ("crashed on child side of fork pre-exec"). So this is the very
    // first statement in `run()`.
    core::shell_path::fix_path_for_gui_launch();

    init_tracing();
    // Rename ~/.packetcode → ~/.packetade once per upgrade. Must run before
    // any command that reads/writes the data dir.
    core::migration::migrate_data_dir();
    commands::crashes::install_panic_hook();

    // Reap PTY-agent children stranded by a previous run's abnormal exit
    // (SIGKILL / crash / force-quit) before we spawn anything new. Runs after
    // migrate_data_dir so the registry resolves to the current data dir.
    core::pty::reap_orphaned_pty_children();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(create_github_auth_state())
        .manage(create_shared_pty_manager())
        .manage(create_shared_orchestrator())
        .manage(create_dictation_state())
        .manage(WhisperState::default())
        .manage(std::sync::Arc::new(ApiAgentState::new()))
        .manage(std::sync::Arc::new(QualityRunnerState::new()))
        .manage(std::sync::Arc::new(CodeQualityAutoFixState::new()))
        .manage(FlightPlannerRegistry::default())
        .setup(|app| {
            // Spawn the Node agent sidecar and stash the supervisor in
            // managed state so slice C's routing layer can reach it via
            // `State<Arc<SidecarManager>>`. The manager spawns the child
            // asynchronously, so `.setup()` returns immediately.
            use tauri::Manager;
            let manager = SidecarManager::new(app.handle().clone());
            app.manage(manager);

            // Flight Planner (E1) wake bus: drains `PlannerWakeEvent`s
            // emitted by orchestration hooks, debounces a ~2s window per
            // flight, and forwards consolidated wake turns to each
            // flight's `api-claude-oauth` sidecar session via the new
            // typed `inject_user_turn` message (protocol v5). Idempotent
            // wrt repeated calls; the consumer is owned by the spawned
            // tokio task and the wake-tx is installed on the
            // already-managed `FlightPlannerRegistry`.
            spawn_wake_consumer(app.handle().clone());

            // Flight Planner (E6 safety rail) cold-start enforcement.
            // Planner sidecar sessions are ephemeral — they die with the
            // host app — so on a fresh app start any flight whose planner
            // was Awake / Idle / QuotaPaused (or merely had a
            // `planner_session_id` pinned) is pointing at a dead session.
            // Flip those to Paused and clear the stale id so the user has
            // to explicitly resume via the UI before the wake bus starts
            // dispatching turns at a planner that doesn't exist.
            // Async-spawned because `with_state_lock` is async; the setup
            // hook returns immediately. Failure logs at warn but does NOT
            // block boot — the worst case is the UI showing a stale
            // "Awake" badge that won't actually fire wakes (the wake
            // consumer's status check skips them).
            tauri::async_runtime::spawn(async {
                match commands::flight_planner::enforce_cold_start_paused().await {
                    Ok(n) if n > 0 => tracing::info!(
                        paused = n,
                        "cold-start: paused {} active flight(s) awaiting user resume",
                        n
                    ),
                    Ok(_) => tracing::debug!("cold-start: no active flights to pause"),
                    Err(e) => tracing::warn!(
                        error = %e,
                        "cold-start: failed to enforce paused planner state",
                    ),
                }
            });

            // Start the auth-credentials fs watcher so the AuthBadge in the
            // Agents pane updates the moment a `claude login` / `codex
            // login` completes, without the user having to re-open the
            // dropdown.
            if let Err(e) = commands::auth_watcher::init(&app.handle()) {
                tracing::warn!("auth_watcher init failed: {}", e);
            }

            // Per-platform window chrome. The config sets
            // `decorations: true` + `titleBarStyle: "Overlay"` so macOS
            // shows traffic lights overlaid on our custom TitleBar
            // (titleBarStyle is macOS-only). On Windows + Linux, that same
            // `decorations: true` would re-introduce the native title bar
            // alongside our custom one — so we strip decorations at
            // runtime here. The custom TitleBar is the only chrome on
            // those platforms.
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                }
            }

            Ok(())
        })
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
            commands::pty::ssh_fetch_fingerprint,
            commands::pty::ssh_pin_host,
            commands::pty::ssh_check_remote_path,
            commands::pty::get_app_known_hosts_path,
            commands::ssh_keys::set_ssh_password,
            commands::ssh_keys::delete_ssh_password,
            commands::ssh_keys::get_ssh_password_exists,
            // Git
            commands::git::get_git_branch,
            commands::git::get_git_status,
            commands::git::get_file_head_content,
            commands::git::get_git_branch_remote,
            commands::git::get_git_status_remote,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_create_branch,
            // P1-15: per-file staging for the GitDashboard commit flow
            commands::git::git_stage_files,
            commands::git::git_unstage_files,
            // v0.8-G pr modal upgrades — push a specific branch for
            // "Publish attempts as draft PRs"
            commands::git::git_push_branch,
            // v0.8-15 workspace github bind
            commands::git::git_get_origin_url,
            commands::git::git_safety_check,
            commands::git::create_conversation_worktree,
            commands::git::remove_conversation_worktree,
            // P2-S1: local squash-merge with ruled safety semantics
            commands::git::merge_conversation_branch,
            // v0.8.5 fix: issue worktree wiring
            commands::git::create_issue_worktree,
            commands::agents_md::resolve_agents_md,
            // Code quality
            commands::code_quality::analyze_code_quality,
            // Quality runner (lint/typecheck/test/cargo)
            commands::quality_runner::detect_quality_checks,
            commands::quality_runner::run_quality_checks,
            commands::quality_runner::cancel_quality_run,
            // v0.8.8 quality autofix
            commands::code_quality_autofix::code_quality_probe_fixers,
            commands::code_quality_autofix::code_quality_run_fix,
            commands::code_quality_autofix::cancel_quality_fix,
            // v0.8.8 quality ai
            commands::code_quality::code_quality_ai_explain,
            commands::code_quality::code_quality_ai_summarize,
            // Crash reports
            commands::crashes::list_crashes,
            commands::crashes::read_crash,
            commands::crashes::delete_crash,
            // Filesystem
            commands::fs::list_directory,
            commands::fs::list_subdirectories,
            commands::fs::get_cwd,
            commands::fs::path_is_dir,
            commands::fs::read_file_contents,
            commands::fs::write_file_contents,
            commands::fs::list_project_files,
            commands::fs::read_file_for_diff,
            // Flight lifecycle orchestration
            commands::flight_attempts::launch_flight_async,
            commands::flight_attempts::cancel_flight_attempt,
            commands::flight_attempts::cleanup_attempt_worktree_ssh,
            commands::flight_attempts::mark_attempt_status,
            // v0.8-G pr modal upgrades — async-Flight draft-PR publish
            commands::flight_attempts::set_attempt_draft_pr,
            commands::flight_attempts::set_flight_publish_attempts_as_prs,
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
            // v0.8-H memory inline
            commands::memory::toggle_pinned_pattern,
            commands::state::save_servers_slice,
            // Agent detection
            commands::agent::detect_agent,
            // v0.8.3 cli detection
            commands::agent::detect_cli_catalog,
            // Status line
            commands::statusline::claude::read_statusline_states,
            commands::statusline::codex::read_codex_statusline_states,
            commands::statusline::gemini::read_gemini_statusline_states,
            commands::statusline::opencode::read_opencode_statusline_states,
            // Spec parsing
            commands::spec::parse_spec_to_flight,
            commands::spec::parse_spec_to_tickets,
            // v0.8.5 issues spec import
            commands::issues::issues_extract_from_spec,
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
            commands::github::github_get_authenticated_user,
            commands::github::github_list_issues,
            commands::github::github_get_issue,
            commands::github::github_create_pr,
            commands::github::github_list_prs,
            commands::github::github_get_pr_diff,
            commands::github::github_investigate_issue,
            // v0.8-C issues interactive
            commands::github::github_list_issue_comments,
            commands::github::github_post_issue_comment,
            commands::github::github_close_issue,
            commands::github::github_reopen_issue,
            commands::github::github_set_issue_assignees,
            commands::github::github_set_issue_labels,
            commands::github::github_set_issue_milestone,
            commands::github::github_list_repo_labels,
            commands::github::github_list_repo_milestones,
            commands::github::github_list_repo_assignable_users,
            commands::github::github_list_issues_page,
            commands::github::github_list_prs_page,
            commands::github::github_list_repos_page,
            // v0.8-G pr modal upgrades
            commands::github::github_list_branches,
            commands::github::github_set_pr_reviewers,
            commands::github::github_set_pr_labels,
            commands::github::github_set_pr_milestone,
            // v0.8-E ai pr
            commands::github::github_ai_pr_description,
            commands::github::github_ai_pr_review,
            // v0.8-F ai digest
            commands::github::github_ai_catch_up,
            commands::github::github_ai_triage,
            // v0.8-A pr actions (re-shipped)
            commands::github::github_merge_pr,
            commands::github::github_close_pr,
            commands::github::github_reopen_pr,
            commands::github::github_convert_pr_to_draft,
            // v0.8-B ci checks (re-shipped)
            commands::github::github_get_pr_checks,
            // v0.8-13 pr review viewer
            commands::github::github_list_pr_reviews,
            commands::github::github_list_pr_review_comments,
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
            // Remote SSH repo clone (used by workspace creation)
            commands::git::clone_repo_remote,
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
            // Provider auth status probe
            commands::provider_auth::get_provider_auth_status,
            commands::provider_auth::sign_out_provider,
            // Local-only per-provider launch counter (Tier 4 slice B)
            commands::provider_stats::get_provider_launch_stats,
            // Ollama local model discovery
            commands::ollama::get_ollama_base_url,
            commands::ollama::set_ollama_base_url,
            commands::ollama::list_ollama_models,
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
            commands::api_agent::cancel_pending_tools,
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
            // Sidecar lifecycle status (for the status-bar chip)
            commands::agent_sidecar::get_sidecar_status,
            // Flight Planner (E1)
            commands::flight_planner::start_flight_planner,
            commands::flight_planner::stop_flight_planner,
            commands::flight_planner::pause_flight_planner,
            commands::flight_planner::resume_flight_planner,
            commands::flight_planner::inject_planner_turn,
            commands::flight_planner::trigger_planner_decomposition,
            commands::flight_planner::resolve_flight_approval,
            commands::flight_planner::get_flight_approvals,
            // Flight Planner — journal read access (E7)
            commands::flight_planner::get_flight_journal,
            commands::flight_planner::get_flight_journal_tail,
            commands::flight_planner::get_flight_journal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
