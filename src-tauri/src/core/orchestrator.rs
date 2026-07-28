use super::flight::*;

/// Default `auto_commit_trailer_format` used when the user hasn't customised
/// one. Placeholders rendered by `core::worktree::install_prepare_commit_msg_hook`:
///   `{flightId}`    — Flight Flight id (e.g. `F-A1B2`), or `unknown` when
///                     unavailable (e.g. agents-pane conversation worktrees).
///   `{attemptId}`   — Attempt id (e.g. `A-X1Y2`).
///   `{flightTitle}` — Free-form flight title; sanitised for shell context.
pub const DEFAULT_AUTO_COMMIT_TRAILER_FORMAT: &str =
    "Run-By: PacketADE flight F-{flightId} attempt A-{attemptId}";

/// Persisted app settings (formerly the task orchestrator's settings). Consumed
/// by the worktree auto-trailer hook and the settings UI; persisted via
/// `storage::save_settings`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrchestratorSettings {
    pub max_parallel_sessions: usize,
    pub milestone_gating: bool,
    pub project_path: String,
    /// v0.8 setting: when true, the worktree provisioner installs a
    /// `prepare-commit-msg` hook that appends an auto-trailer to every
    /// commit. Off → no hook is installed at all (existing hooks are
    /// untouched). Persisted via `save_settings`.
    #[serde(default = "default_auto_commit_trailer_enabled")]
    pub auto_commit_trailer_enabled: bool,
    /// v0.8 setting: format string used by the auto-trailer hook. Supports
    /// `{flightId}`, `{attemptId}`, and `{flightTitle}` placeholders.
    #[serde(default = "default_auto_commit_trailer_format")]
    pub auto_commit_trailer_format: String,
    #[serde(default = "default_autonomy_mode")]
    pub autonomy_default_mode: AutonomyDefaultMode,
    #[serde(default)]
    pub autonomy_default_policy: AutonomyPolicy,
}

fn default_auto_commit_trailer_enabled() -> bool {
    true
}

fn default_auto_commit_trailer_format() -> String {
    DEFAULT_AUTO_COMMIT_TRAILER_FORMAT.to_string()
}

fn default_autonomy_mode() -> AutonomyDefaultMode {
    AutonomyDefaultMode::Assisted
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self {
            max_parallel_sessions: 3,
            milestone_gating: true,
            project_path: std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| ".".to_string()),
            auto_commit_trailer_enabled: true,
            auto_commit_trailer_format: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT.to_string(),
            autonomy_default_mode: AutonomyDefaultMode::Assisted,
            autonomy_default_policy: AutonomyPolicy::default(),
        }
    }
}

/// Normalize persisted flights into a safe post-restart state.
///
/// Run once at startup (the legacy task-scheduler command layer was removed;
/// this recovery is all that survives of it). An app that closed or crashed
/// mid-run may have flights whose milestone/task status still reads `Active` /
/// `Running` / `Queued` and whose tasks reference now-dead session ids. This
/// resets those interrupted states to a resumable `Paused`/`Pending` shape and
/// clears stale session references so the Flight Deck never shows a task stuck
/// "Running" after a restart.
pub fn recover_flights_on_startup(flights: &mut [Flight]) {
    for flight in flights {
        flight.linked_session_ids.clear();

        if let Some(runtime) = &mut flight.autonomy_runtime {
            if runtime.status == AutonomyRunStatus::Running {
                runtime.status = AutonomyRunStatus::Paused;
                runtime.paused_at = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                );
                runtime.hard_stop_reason =
                    Some("Paused after PacketADE restarted. Resume explicitly.".to_string());
            }
        }

        let mut interrupted = false;

        for ms in &mut flight.milestones {
            if ms.status == MilestoneStatus::Active {
                ms.status = MilestoneStatus::Pending;
            }

            for task in &mut ms.tasks {
                if matches!(
                    task.status,
                    TaskStatus::Queued | TaskStatus::Running | TaskStatus::ApprovalNeeded
                ) {
                    task.status = TaskStatus::Paused;
                    interrupted = true;
                }

                if task.session_id.is_some() {
                    task.session_id = None;
                }
            }
        }

        if interrupted && matches!(flight.status, FlightStatus::Active | FlightStatus::Review) {
            flight.status = FlightStatus::Paused;
            flight.updated_at = now();
        }
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interrupted_flight() -> Flight {
        Flight {
            id: "flight-1".to_string(),
            title: "Flight".to_string(),
            objective: "Objective".to_string(),
            status: FlightStatus::Active,
            priority: FlightPriority::High,
            project_path: "D:/projects/FlightDeck".to_string(),
            workspace_id: None,
            git_branch: Some("feature/test".to_string()),
            milestones: vec![Milestone {
                id: "ms-1".to_string(),
                flight_id: "flight-1".to_string(),
                title: "Milestone".to_string(),
                description: "Desc".to_string(),
                order: 0,
                status: MilestoneStatus::Active,
                tasks: vec![Task {
                    id: "task-1".to_string(),
                    milestone_id: "ms-1".to_string(),
                    flight_id: "flight-1".to_string(),
                    title: "Task".to_string(),
                    description: "Run the task".to_string(),
                    order: 0,
                    status: TaskStatus::Running,
                    task_type: TaskType::Implementation,
                    agent_config_id: "claude-code".to_string(),
                    agent_args: None,
                    model: None,
                    depends_on: Vec::new(),
                    session_id: Some("sess-1".to_string()),
                    result: None,
                    review_packet: None,
                    created_at: 0,
                    started_at: None,
                    completed_at: None,
                    cost: 0.0,
                    tokens: 0,
                    owned_paths: Vec::new(),
                    replan_count: 0,
                }],
                validation_criteria: Vec::new(),
            }],
            linked_session_ids: vec!["sess-1".to_string()],
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: Vec::new(),
            review_gate_policy: None,
            execution_mode: None,
            integration_branch: None,
            coordination_inbox: Vec::new(),
            autonomy_mode: None,
            autonomy_policy: None,
            autonomy_runtime: None,
            planning_conversation_id: None,
            planner_session_id: None,
            planner_status: None,
            planner_cost: None,
            planner_tokens: None,
            planner_provider: None,
            publish_attempts_as_prs: false,
            coordination_log: Vec::new(),
        }
    }

    #[test]
    fn recover_normalizes_interrupted_flight_after_restart() {
        let mut flights = vec![interrupted_flight()];

        recover_flights_on_startup(&mut flights);

        let flight = &flights[0];
        assert_eq!(flight.status, FlightStatus::Paused);
        assert!(flight.linked_session_ids.is_empty());
        assert_eq!(flight.milestones[0].status, MilestoneStatus::Pending);
        let task = &flight.milestones[0].tasks[0];
        assert_eq!(task.status, TaskStatus::Paused);
        assert_eq!(task.session_id, None);
    }

    #[test]
    fn recover_leaves_settled_flight_untouched() {
        let mut flights = vec![interrupted_flight()];
        // A completed flight with terminal task/milestone status must survive
        // recovery unchanged (aside from the always-cleared linked sessions).
        flights[0].status = FlightStatus::Done;
        flights[0].milestones[0].status = MilestoneStatus::Done;
        flights[0].milestones[0].tasks[0].status = TaskStatus::Done;
        flights[0].milestones[0].tasks[0].session_id = None;
        flights[0].linked_session_ids.clear();

        recover_flights_on_startup(&mut flights);

        let flight = &flights[0];
        assert_eq!(flight.status, FlightStatus::Done);
        assert_eq!(flight.milestones[0].status, MilestoneStatus::Done);
        assert_eq!(flight.milestones[0].tasks[0].status, TaskStatus::Done);
    }

    #[test]
    fn recover_never_resumes_bounded_autonomy_after_restart() {
        let mut flight = interrupted_flight();
        flight.autonomy_mode = Some(AutonomyFlightMode::Yolo);
        flight.autonomy_policy = Some(AutonomyPolicy::default());
        flight.autonomy_runtime = Some(AutonomyRuntime {
            status: AutonomyRunStatus::Running,
            started_at: Some(1),
            paused_at: None,
            stopped_at: None,
            hard_stop_reason: None,
            action_history: Vec::new(),
        });

        recover_flights_on_startup(std::slice::from_mut(&mut flight));

        let runtime = flight.autonomy_runtime.expect("runtime");
        assert_eq!(runtime.status, AutonomyRunStatus::Paused);
        assert!(runtime.paused_at.is_some());
        assert!(runtime
            .hard_stop_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Resume explicitly")));
    }
}
