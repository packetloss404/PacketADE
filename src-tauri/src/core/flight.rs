use serde::{Deserialize, Serialize};

// === Flight Status & Priority ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlightStatus {
    Draft,
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
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub cost: f64,
    pub tokens: u64,
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
    pub git_branch: Option<String>,
    pub milestones: Vec<Milestone>,
    pub linked_session_ids: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
    pub total_cost: f64,
    pub total_tokens: u64,
}

impl Flight {
    /// Get all tasks across all milestones.
    pub fn all_tasks(&self) -> Vec<&Task> {
        self.milestones.iter().flat_map(|m| m.tasks.iter()).collect()
    }

    /// Count done / total tasks.
    pub fn progress(&self) -> (usize, usize) {
        let tasks = self.all_tasks();
        let done = tasks.iter().filter(|t| t.status == TaskStatus::Done).count();
        (done, tasks.len())
    }

    /// Check if any tasks need attention (approval or failed).
    pub fn needs_attention(&self) -> bool {
        self.all_tasks().iter().any(|t| {
            t.status == TaskStatus::ApprovalNeeded || t.status == TaskStatus::Failed
        })
    }
}
