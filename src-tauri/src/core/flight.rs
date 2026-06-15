use serde::{Deserialize, Serialize};

// === Flight Status & Priority ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlightStatus {
    Draft,
    /// Flight Planner spec-mode conversation — planner is the chat partner,
    /// no decomposition has happened yet. Transitions to `Planning`/`Active`
    /// when the user hits Launch.
    Spec,
    Planning,
    Ready,
    Active,
    Paused,
    Review,
    Done,
    Failed,
    Cancelled,
}

impl FlightStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Draft => "Draft",
            Self::Spec => "Spec",
            Self::Planning => "Planning",
            Self::Ready => "Ready",
            Self::Active => "Active",
            Self::Paused => "Paused",
            Self::Review => "Review",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }
}

// === Flight Planner status (mirrors `commands::flight_planner::PlannerStatus`) ===
//
// This is the persisted form serialized into the Flight DTO. Kept in this
// module so the `Flight` struct's `planner_status` field doesn't need to
// import from `commands`. The runtime registry holds its own copy; this enum
// is just the wire/persistence shape.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlannerStatus {
    Idle,
    Awake,
    Paused,
    QuotaPaused,
    Completed,
    Failed,
}

impl PlannerStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Awake => "Awake",
            Self::Paused => "Paused",
            Self::QuotaPaused => "Quota Paused",
            Self::Completed => "Completed",
            Self::Failed => "Failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlightPriority {
    Low,
    Medium,
    High,
    Critical,
}

impl FlightPriority {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
            Self::Critical => "Critical",
        }
    }
}

// === Milestone ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneStatus {
    Pending,
    Active,
    Done,
    Failed,
}

impl MilestoneStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::Active => "Active",
            Self::Done => "Done",
            Self::Failed => "Failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: MilestoneStatus,
    pub tasks: Vec<Task>,
    pub validation_criteria: Vec<String>,
}

// === Task ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Blocked,
    Queued,
    Running,
    ApprovalNeeded,
    Paused,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::Blocked => "Blocked",
            Self::Queued => "Queued",
            Self::Running => "Running",
            Self::ApprovalNeeded => "Needs Approval",
            Self::Paused => "Paused",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Implementation,
    Testing,
    Review,
    Validation,
    Research,
    Refactor,
    Documentation,
}

impl TaskType {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Implementation => "Impl",
            Self::Testing => "Test",
            Self::Review => "Review",
            Self::Validation => "Validate",
            Self::Research => "Research",
            Self::Refactor => "Refactor",
            Self::Documentation => "Docs",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskHandoff {
    pub summary: String,
    pub files_changed: Vec<String>,
    pub tests_needed: Vec<String>,
    pub follow_ups: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationVerdict {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskValidationAssertion {
    pub label: String,
    pub status: ValidationVerdict,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskValidationReport {
    pub verdict: ValidationVerdict,
    pub summary: String,
    pub assertions: Vec<TaskValidationAssertion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub exit_code: Option<i32>,
    pub summary: String,
    pub files_changed: Vec<String>,
    pub errors: Vec<String>,
    pub duration_ms: u64,
    pub handoff: Option<TaskHandoff>,
    pub validation: Option<TaskValidationReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewType {
    ToolCall,
    FileWrite,
    Command,
    MilestoneGate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewPacket {
    pub id: String,
    pub task_id: String,
    pub flight_id: String,
    pub milestone_id: String,
    pub requested_at: u64,
    pub review_type: ReviewType,
    pub summary: String,
    pub diff: Option<String>,
    pub command: Option<String>,
    pub file_paths: Vec<String>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub milestone_id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: TaskStatus,
    pub task_type: TaskType,
    pub agent_config_id: String,
    pub agent_args: Option<Vec<String>>,
    pub model: Option<String>,
    pub depends_on: Vec<String>,
    pub session_id: Option<String>,
    pub result: Option<TaskResult>,
    pub review_packet: Option<ReviewPacket>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub cost: f64,
    pub tokens: u64,
    /// File/path claims used by Flight Planner collision gates. Paths are
    /// usually repo-relative and optional for legacy/manual tasks.
    #[serde(default)]
    pub owned_paths: Vec<String>,
    /// Number of times the planner has called `replan_after_failure` for
    /// this task. RateLimit/Network failures (per E5) do NOT increment.
    /// Mirrored from `FlightPlannerSession.replans_per_task` whenever
    /// `bump_replan_count` runs. Read by `render_task_failed` to surface
    /// budget to the planner.
    ///
    /// `#[serde(default)]` is critical for backwards-compat with existing
    /// persisted state — without it, old state files written before this
    /// field existed would fail to deserialize.
    #[serde(default)]
    pub replan_count: u32,
}

// === Approval Decision ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecisionType {
    Approved,
    Denied,
    ForceOverridden,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecision {
    pub id: String,
    pub review_packet_id: String,
    pub task_id: String,
    pub flight_id: String,
    pub decision: ApprovalDecisionType,
    pub decided_at: u64,
    pub reason: Option<String>,
}

// === Async Flight Attempts ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Queued,
    Provisioning,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AttemptTarget {
    Local {
        base_path: String,
        worktree_path: String,
    },
    Ssh {
        target_id: String,
        base_path: String,
        worktree_path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub flight_id: String,
    pub target: AttemptTarget,
    pub agent_config_id: String,
    pub model: String,
    pub provider: String,
    pub branch: String,
    pub base_branch: String,
    pub session_id: String,
    pub status: AttemptStatus,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub tokens: u64,
    #[serde(default)]
    pub error_message: Option<String>,
    /// v0.8-G: when the parent Flight has `publish_attempts_as_prs == true`,
    /// the post-attempt pipeline pushes this attempt's branch to `origin`
    /// and opens a GitHub draft PR. The resulting PR number is recorded
    /// here so the Flight Detail UI can surface a "Draft PR #N" link.
    /// `None` if publishing is disabled or the publish step failed
    /// (errors are logged to the attempt's error_message; the attempt
    /// itself stays in whatever terminal state it earned naturally).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_pr_number: Option<u32>,
}

// === Flight ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flight {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub status: FlightStatus,
    pub priority: FlightPriority,
    pub project_path: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub git_branch: Option<String>,
    pub milestones: Vec<Milestone>,
    pub linked_session_ids: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
    pub total_cost: f64,
    pub total_tokens: u64,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    /// Flight Planner: the long-lived `api-claude-oauth` sidecar session
    /// that owns this flight's planning/replan loop. `None` until the user
    /// starts the planner from spec mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_session_id: Option<String>,
    /// Flight Planner: last-known status of the planner agent for this
    /// flight. `None` for flights that never used the planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_status: Option<PlannerStatus>,
    /// Flight Planner (E8): cumulative USD cost attributed to the planner's
    /// own `turn_summary` events (NOT executor sessions — those roll up into
    /// `total_cost` separately). Accumulated from the sidecar's pricing
    /// calculation on every planner-owned turn. `None` until the first turn
    /// closes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_cost: Option<f64>,
    /// Flight Planner (E8): cumulative input+output tokens used by the
    /// planner session. `None` until the first turn closes. Stored as a
    /// single sum because the StatGrid chip displays a single token total;
    /// per-direction breakdown lives on `FlightPlannerSession` in the
    /// registry for the few callers that need it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_tokens: Option<u64>,
    /// Flight Planner (E8): which provider the planner session is running
    /// against. `"claude-oauth"` (subscription, the v1 default) vs
    /// `"api-claude"` (pay-per-token) — the StatGrid chip renders these
    /// differently because subscription usage doesn't burn API credit.
    /// `None` for flights that never used the planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_provider: Option<String>,
    /// v0.8-G: when set on an async-mode Flight, the executor pipeline
    /// pushes each attempt's branch to `origin` and opens a draft GitHub
    /// PR after the attempt reaches a terminal `completed`/`reviewing`
    /// state. The resulting PR number is written back to
    /// `Attempt.draft_pr_number`. Defaults to `false` for back-compat with
    /// previously-persisted Flights.
    #[serde(default)]
    pub publish_attempts_as_prs: bool,
}

impl Flight {
    /// Get all tasks across all milestones.
    pub fn all_tasks(&self) -> Vec<&Task> {
        self.milestones
            .iter()
            .flat_map(|m| m.tasks.iter())
            .collect()
    }

    /// Count done / total tasks.
    pub fn progress(&self) -> (usize, usize) {
        let tasks = self.all_tasks();
        let done = tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Done)
            .count();
        (done, tasks.len())
    }

    /// Check if any tasks need attention (approval or failed).
    pub fn needs_attention(&self) -> bool {
        self.all_tasks()
            .iter()
            .any(|t| t.status == TaskStatus::ApprovalNeeded || t.status == TaskStatus::Failed)
    }
}

// === Flight Approval Request ===
//
// Persisted record of a pending `request_user_approval` tool call from the
// Flight Planner. The planner files this synchronously (async-return per
// the locked design) and keeps working; the user resolves it later via
// `resolve_flight_approval`, which flips `resolved=true`, records the
// chosen option, and fires a `WakeTrigger::UserMessageInJournal` so the
// planner sees the answer on its next turn.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightApprovalRequest {
    /// `approval_id` — the value returned to the planner in the
    /// `pending_approval:<id>` sentinel.
    pub id: String,
    #[serde(alias = "missionId")]
    pub flight_id: String,
    pub question: String,
    /// Optional multiple-choice options. Empty vec = free-form text answer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// Unix millis when the planner filed the approval.
    pub awaiting_since: u64,
    pub resolved: bool,
    /// The option the user picked, or `"dismissed"` for a dismissed
    /// approval. `None` while `resolved == false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// Unix millis when the user resolved the approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
}

// === Issue ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptanceCriterion {
    pub id: String,
    pub text: String,
    pub checked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub ticket_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub labels: Vec<String>,
    pub epic: Option<String>,
    pub session_id: Option<String>,
    pub flight_id: Option<String>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub blocked_by: Vec<String>,
    pub blocks: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_task(status: TaskStatus) -> Task {
        Task {
            id: uuid::Uuid::new_v4().to_string(),
            milestone_id: "m1".to_string(),
            flight_id: "f1".to_string(),
            title: "Test task".to_string(),
            description: String::new(),
            order: 0,
            status,
            task_type: TaskType::Implementation,
            agent_config_id: String::new(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: None,
            result: None,
            review_packet: None,
            created_at: 0,
            started_at: None,
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            owned_paths: Vec::new(),
            replan_count: 0,
        }
    }

    fn make_milestone(tasks: Vec<Task>) -> Milestone {
        Milestone {
            id: "m1".to_string(),
            flight_id: "f1".to_string(),
            title: "Milestone 1".to_string(),
            description: String::new(),
            order: 0,
            status: MilestoneStatus::Active,
            tasks,
            validation_criteria: Vec::new(),
        }
    }

    fn make_flight(milestones: Vec<Milestone>) -> Flight {
        Flight {
            id: "f1".to_string(),
            title: "Test flight".to_string(),
            objective: String::new(),
            status: FlightStatus::Active,
            priority: FlightPriority::Medium,
            project_path: "/tmp/test".to_string(),
            workspace_id: None,
            git_branch: None,
            milestones,
            linked_session_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            total_cost: 0.0,
            total_tokens: 0,
            prompt: None,
            attempts: Vec::new(),
            planner_session_id: None,
            planner_status: None,
            planner_cost: None,
            planner_tokens: None,
            planner_provider: None,
            publish_attempts_as_prs: false,
        }
    }

    #[test]
    fn all_tasks_returns_tasks_across_milestones() {
        let m1 = make_milestone(vec![make_task(TaskStatus::Done)]);
        let m2 = make_milestone(vec![
            make_task(TaskStatus::Pending),
            make_task(TaskStatus::Running),
        ]);
        let flight = make_flight(vec![m1, m2]);
        assert_eq!(flight.all_tasks().len(), 3);
    }

    #[test]
    fn progress_counts_done_tasks() {
        let t1 = make_task(TaskStatus::Done);
        let t2 = make_task(TaskStatus::Running);
        let flight = make_flight(vec![make_milestone(vec![t1, t2])]);
        let (done, total) = flight.progress();
        assert_eq!(done, 1);
        assert_eq!(total, 2);
    }

    #[test]
    fn needs_attention_detects_approval_needed() {
        let flight = make_flight(vec![make_milestone(vec![make_task(
            TaskStatus::ApprovalNeeded,
        )])]);
        assert!(flight.needs_attention());
    }

    #[test]
    fn needs_attention_detects_failed() {
        let flight = make_flight(vec![make_milestone(vec![make_task(TaskStatus::Failed)])]);
        assert!(flight.needs_attention());
    }

    #[test]
    fn needs_attention_false_when_all_ok() {
        let flight = make_flight(vec![make_milestone(vec![make_task(TaskStatus::Running)])]);
        assert!(!flight.needs_attention());
    }

    #[test]
    fn task_status_is_terminal() {
        assert!(TaskStatus::Done.is_terminal());
        assert!(TaskStatus::Failed.is_terminal());
        assert!(TaskStatus::Cancelled.is_terminal());
        assert!(!TaskStatus::Running.is_terminal());
        assert!(!TaskStatus::Pending.is_terminal());
        assert!(!TaskStatus::ApprovalNeeded.is_terminal());
    }

    #[test]
    fn task_replan_count_defaults_to_zero_on_deserialize() {
        // Old persisted state (pre-E5) won't have `replanCount` on Task.
        // The `#[serde(default)]` attribute must let it round-trip into a
        // zero-initialized field rather than failing deserialization.
        let json = r#"{
            "id": "t1",
            "milestone_id": "m1",
            "flight_id": "f1",
            "title": "x",
            "description": "y",
            "order": 0,
            "status": "queued",
            "task_type": "implementation",
            "agent_config_id": "claude-code",
            "depends_on": [],
            "session_id": null,
            "created_at": 0,
            "cost": 0.0,
            "tokens": 0
        }"#;
        let task: Task = serde_json::from_str(json).expect("legacy task json should parse");
        assert_eq!(task.replan_count, 0);
    }

    #[test]
    fn task_replan_count_round_trips() {
        let mut task = make_task(TaskStatus::Failed);
        task.replan_count = 2;
        let json = serde_json::to_string(&task).unwrap();
        let back: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(back.replan_count, 2);
    }
}
