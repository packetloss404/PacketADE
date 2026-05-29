use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::orchestration::{OrchestratorSnapshot, RunningTaskSnapshot};
use crate::core::{
    agent_config as core_agent, flight as core_flight, orchestrator as core_orchestrator,
    storage as core_storage, workspace as core_workspace,
};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub enum WorkspaceAgentSlotDto {
    #[serde(rename = "terminal")]
    Terminal,
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "opencode")]
    Opencode,
    #[serde(rename = "packetcode")]
    Packetcode,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatusDto {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ThemeDto {
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GridPositionDto {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePaneDto {
    pub id: String,
    pub agent_id: WorkspaceAgentSlotDto,
    pub session_id: Option<String>,
    pub grid_position: GridPositionDto,
    #[ts(optional)]
    pub accent_color: Option<String>,
    #[ts(optional)]
    pub pinned_commands: Option<Vec<String>>,
    #[ts(optional)]
    pub task_id: Option<String>,
    #[ts(optional)]
    pub flight_id: Option<String>,
    #[ts(optional)]
    pub agent_config_id: Option<String>,
    #[ts(optional)]
    pub initial_prompt: Option<String>,
    #[ts(optional)]
    pub override_command: Option<String>,
    #[ts(optional)]
    pub override_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoDto {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub agents: Vec<WorkspaceAgentSlotDto>,
    pub panes: Vec<WorkspacePaneDto>,
    pub project_path: String,
    #[ts(optional)]
    pub prompt: Option<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    pub status: WorkspaceStatusDto,
    #[ts(optional)]
    pub bypass_permissions: Option<bool>,
    #[ts(optional)]
    pub model_overrides: Option<HashMap<String, Option<String>>>,
    #[ts(optional)]
    pub effort_overrides: Option<HashMap<String, Option<String>>>,
    #[ts(optional)]
    pub server_id: Option<String>,
    #[ts(optional)]
    pub remote_project_path: Option<String>,
    #[ts(optional)]
    pub github_repo: Option<GithubRepoDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PersistedUiStateDto {
    #[ts(optional)]
    pub selected_flight_id: Option<String>,
    #[ts(optional)]
    pub selected_view: Option<String>,
    #[ts(optional)]
    pub theme: Option<ThemeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSettingsDto {
    pub max_parallel_sessions: usize,
    pub milestone_gating: bool,
    pub project_path: String,
    #[serde(default = "crate::api::default_auto_commit_trailer_enabled_dto")]
    pub auto_commit_trailer_enabled: bool,
    #[serde(default = "crate::api::default_auto_commit_trailer_format_dto")]
    pub auto_commit_trailer_format: String,
}

pub(crate) fn default_auto_commit_trailer_enabled_dto() -> bool {
    true
}

pub(crate) fn default_auto_commit_trailer_format_dto() -> String {
    core_orchestrator::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentCapabilityDto {
    CodeEdit,
    CodeReview,
    Testing,
    Research,
    Shell,
    Refactor,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsePatternDto {
    pub pattern: String,
    pub tool: String,
    #[ts(optional)]
    pub file_group: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusPatternsDto {
    pub approval: Vec<String>,
    pub thinking: Vec<String>,
    pub tool_use: Vec<ToolUsePatternDto>,
    pub idle: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalActionsDto {
    pub approve: String,
    pub deny: String,
    pub abort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub default_args: Vec<String>,
    pub description: String,
    pub installed: bool,
    pub capabilities: Vec<AgentCapabilityDto>,
    pub icon: String,
    pub color: String,
    pub status_patterns: AgentStatusPatternsDto,
    pub approval_actions: AgentApprovalActionsDto,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FlightStatusDto {
    Draft,
    /// Mission Planner spec-mode conversation (planner is the chat partner).
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

/// Mission Planner status mirror of `core_flight::PlannerStatus` for the
/// frontend wire format. See `core/flight.rs::PlannerStatus`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlannerStatusDto {
    Idle,
    Awake,
    Paused,
    QuotaPaused,
    Completed,
    Failed,
}

/// Mission Planner: persisted approval-gate record mirror of
/// `core_flight::MissionApprovalRequest`. Filed by the planner via the
/// `request_user_approval` MCP tool (E2) and drained by the
/// `resolve_mission_approval` Tauri command.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MissionApprovalRequestDto {
    pub id: String,
    pub mission_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[ts(type = "number")]
    pub awaiting_since: u64,
    pub resolved: bool,
    #[serde(default)]
    #[ts(optional)]
    pub resolution: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub resolved_at: Option<u64>,
}

impl From<core_flight::MissionApprovalRequest> for MissionApprovalRequestDto {
    fn from(value: core_flight::MissionApprovalRequest) -> Self {
        Self {
            id: value.id,
            mission_id: value.mission_id,
            question: value.question,
            options: value.options,
            awaiting_since: value.awaiting_since,
            resolved: value.resolved,
            resolution: value.resolution,
            resolved_at: value.resolved_at,
        }
    }
}

impl From<MissionApprovalRequestDto> for core_flight::MissionApprovalRequest {
    fn from(value: MissionApprovalRequestDto) -> Self {
        Self {
            id: value.id,
            mission_id: value.mission_id,
            question: value.question,
            options: value.options,
            awaiting_since: value.awaiting_since,
            resolved: value.resolved,
            resolution: value.resolution,
            resolved_at: value.resolved_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FlightPriorityDto {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneStatusDto {
    Pending,
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatusDto {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TaskTypeDto {
    Implementation,
    Testing,
    Review,
    Validation,
    Research,
    Refactor,
    Documentation,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ValidationVerdictDto {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTypeDto {
    ToolCall,
    FileWrite,
    Command,
    MilestoneGate,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskHandoffDto {
    pub summary: String,
    pub files_changed: Vec<String>,
    pub tests_needed: Vec<String>,
    pub follow_ups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidationAssertionDto {
    pub label: String,
    pub status: ValidationVerdictDto,
    #[ts(optional)]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidationReportDto {
    pub verdict: ValidationVerdictDto,
    pub summary: String,
    pub assertions: Vec<TaskValidationAssertionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskResultDto {
    pub exit_code: Option<i32>,
    pub summary: String,
    pub files_changed: Vec<String>,
    pub errors: Vec<String>,
    #[ts(type = "number")]
    pub duration: u64,
    #[ts(optional)]
    pub handoff: Option<TaskHandoffDto>,
    #[ts(optional)]
    pub validation: Option<TaskValidationReportDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPacketDto {
    pub id: String,
    pub task_id: String,
    pub flight_id: String,
    pub milestone_id: String,
    #[ts(type = "number")]
    pub requested_at: u64,
    pub review_type: ReviewTypeDto,
    pub summary: String,
    #[ts(optional)]
    pub diff: Option<String>,
    #[ts(optional)]
    pub command: Option<String>,
    pub file_paths: Vec<String>,
    #[ts(optional)]
    pub agent_id: Option<String>,
    #[ts(optional)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub milestone_id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: TaskStatusDto,
    #[serde(rename = "type")]
    pub task_type: TaskTypeDto,
    pub agent_config_id: String,
    #[ts(optional)]
    pub agent_args: Option<Vec<String>>,
    #[ts(optional)]
    pub model: Option<String>,
    pub depends_on: Vec<String>,
    pub session_id: Option<String>,
    #[ts(optional)]
    pub result: Option<TaskResultDto>,
    #[ts(optional)]
    pub review_packet: Option<ReviewPacketDto>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(optional)]
    #[ts(type = "number")]
    pub started_at: Option<u64>,
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    pub cost: f64,
    #[ts(type = "number")]
    pub tokens: u64,
    /// Mission Planner: number of `replan_after_failure` calls this task
    /// has triggered (excluding RateLimit/Network exemptions). Mirrored
    /// from `MissionPlannerSession.replans_per_task` by
    /// `MissionPlannerRegistry::bump_replan_count`. Read by
    /// `render_task_failed` for the budget header (`replanCount / 3`).
    #[serde(default)]
    pub replan_count: u32,
    #[serde(default)]
    #[ts(optional)]
    pub owned_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneDto {
    pub id: String,
    pub flight_id: String,
    pub title: String,
    pub description: String,
    pub order: usize,
    pub status: MilestoneStatusDto,
    pub tasks: Vec<TaskDto>,
    pub validation_criteria: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatusDto {
    Queued,
    Provisioning,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AttemptTargetDto {
    Local {
        #[serde(rename = "basePath")]
        base_path: String,
        #[serde(rename = "worktreePath")]
        worktree_path: String,
    },
    Ssh {
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "basePath")]
        base_path: String,
        #[serde(rename = "worktreePath")]
        worktree_path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttemptDto {
    pub id: String,
    pub flight_id: String,
    pub target: AttemptTargetDto,
    pub agent_config_id: String,
    pub model: String,
    pub provider: String,
    pub branch: String,
    pub base_branch: String,
    pub session_id: String,
    pub status: AttemptStatusDto,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub started_at: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    #[ts(type = "number")]
    pub tokens: u64,
    #[serde(default)]
    #[ts(optional)]
    pub error_message: Option<String>,
    /// v0.8-G: when the parent Flight publishes attempts as draft PRs, the
    /// resulting PR number is round-tripped here. Optional everywhere
    /// because most attempts will not have a draft PR.
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub draft_pr_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FlightDto {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub status: FlightStatusDto,
    pub priority: FlightPriorityDto,
    pub project_path: String,
    #[serde(default)]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[ts(optional)]
    pub git_branch: Option<String>,
    pub milestones: Vec<MilestoneDto>,
    pub linked_session_ids: Vec<String>,
    #[serde(default)]
    pub issue_ids: Vec<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[ts(optional)]
    #[ts(type = "number")]
    pub completed_at: Option<u64>,
    pub total_cost: f64,
    #[ts(type = "number")]
    pub total_tokens: u64,
    #[serde(default)]
    #[ts(optional)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub attempts: Vec<AttemptDto>,
    /// Mission Planner: long-lived `api-claude-oauth` session id that owns
    /// this mission. Absent for missions that never used the planner.
    #[serde(default)]
    #[ts(optional)]
    pub planner_session_id: Option<String>,
    /// Mission Planner: last-known status of the planner agent for this
    /// mission.
    #[serde(default)]
    #[ts(optional)]
    pub planner_status: Option<PlannerStatusDto>,
    /// Mission Planner (E8): cumulative USD cost attributed to the planner's
    /// own turns. Distinct from `total_cost` which rolls up executor task
    /// spend. Absent until the planner closes its first turn.
    #[serde(default)]
    #[ts(optional)]
    pub planner_cost: Option<f64>,
    /// Mission Planner (E8): cumulative input+output tokens used by the
    /// planner session. Absent until the planner closes its first turn.
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "number")]
    pub planner_tokens: Option<u64>,
    /// Mission Planner (E8): provider string the planner runs on (e.g.
    /// `"claude-oauth"` for subscription, `"api-claude"` for API-key). The
    /// StatGrid chip renders these differently because subscription usage
    /// doesn't burn API credit.
    #[serde(default)]
    #[ts(optional)]
    pub planner_provider: Option<String>,
    /// v0.8-G: when true on an async-mode Flight, the executor pipeline
    /// pushes each attempt's branch and opens a draft PR after the attempt
    /// reaches a terminal state. Persisted so the toggle round-trips.
    #[serde(default)]
    pub publish_attempts_as_prs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigDto {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub last_connected_at: Option<u64>,
    #[serde(default)]
    pub installed_agents: Vec<String>,
    #[serde(default)]
    pub host_fingerprint: Option<String>,
}

impl From<core_storage::ServerConfig> for ServerConfigDto {
    fn from(s: core_storage::ServerConfig) -> Self {
        Self {
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            auth_method: s.auth_method,
            key_path: s.key_path,
            remote_path: s.remote_path,
            last_connected_at: s.last_connected_at,
            installed_agents: s.installed_agents,
            host_fingerprint: s.host_fingerprint,
        }
    }
}

impl From<ServerConfigDto> for core_storage::ServerConfig {
    fn from(s: ServerConfigDto) -> Self {
        Self {
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            auth_method: s.auth_method,
            key_path: s.key_path,
            remote_path: s.remote_path,
            last_connected_at: s.last_connected_at,
            installed_agents: s.installed_agents,
            host_fingerprint: s.host_fingerprint,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStateDto {
    pub version: u32,
    pub flights: Vec<FlightDto>,
    pub agents: Vec<AgentConfigDto>,
    pub settings: OrchestratorSettingsDto,
    pub ui: PersistedUiStateDto,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceDto>,
    #[serde(default)]
    #[ts(type = "any[]")]
    pub memory_events: Vec<serde_json::Value>,
    #[serde(default)]
    #[ts(type = "any[]")]
    pub memory_patterns: Vec<serde_json::Value>,
    #[serde(default)]
    pub servers: Vec<ServerConfigDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpawnRequestDto {
    pub flight_id: String,
    pub milestone_id: String,
    pub task_id: String,
    pub agent_config_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub prompt: String,
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunningTaskSnapshotDto {
    pub task_id: String,
    pub milestone_id: String,
    pub flight_id: String,
    pub session_id: String,
    pub agent_config_id: String,
    #[ts(type = "number")]
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSnapshotDto {
    pub running_task_ids: Vec<String>,
    pub running_tasks: Vec<RunningTaskSnapshotDto>,
    pub active_flight_ids: Vec<String>,
    pub paused_at_milestone: Vec<(String, String)>,
}

impl From<core_workspace::GridPosition> for GridPositionDto {
    fn from(value: core_workspace::GridPosition) -> Self {
        Self {
            row: value.row,
            col: value.col,
        }
    }
}

impl From<GridPositionDto> for core_workspace::GridPosition {
    fn from(value: GridPositionDto) -> Self {
        Self {
            row: value.row,
            col: value.col,
        }
    }
}

impl From<String> for WorkspaceAgentSlotDto {
    fn from(value: String) -> Self {
        match value.as_str() {
            "terminal" => Self::Terminal,
            "claude-code" => Self::ClaudeCode,
            "codex" => Self::Codex,
            "gemini" => Self::Gemini,
            "opencode" => Self::Opencode,
            "packetcode" => Self::Packetcode,
            _ => Self::Terminal,
        }
    }
}

impl From<WorkspaceAgentSlotDto> for String {
    fn from(value: WorkspaceAgentSlotDto) -> Self {
        match value {
            WorkspaceAgentSlotDto::Terminal => "terminal".to_string(),
            WorkspaceAgentSlotDto::ClaudeCode => "claude-code".to_string(),
            WorkspaceAgentSlotDto::Codex => "codex".to_string(),
            WorkspaceAgentSlotDto::Gemini => "gemini".to_string(),
            WorkspaceAgentSlotDto::Opencode => "opencode".to_string(),
            WorkspaceAgentSlotDto::Packetcode => "packetcode".to_string(),
        }
    }
}

impl From<String> for WorkspaceStatusDto {
    fn from(value: String) -> Self {
        match value.as_str() {
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
}

impl From<WorkspaceStatusDto> for String {
    fn from(value: WorkspaceStatusDto) -> Self {
        match value {
            WorkspaceStatusDto::Active => "active".to_string(),
            WorkspaceStatusDto::Archived => "archived".to_string(),
        }
    }
}

impl From<core_workspace::WorkspacePane> for WorkspacePaneDto {
    fn from(value: core_workspace::WorkspacePane) -> Self {
        Self {
            id: value.id,
            agent_id: value.agent_id.into(),
            session_id: value.session_id,
            grid_position: value.grid_position.into(),
            accent_color: value.accent_color,
            pinned_commands: value.pinned_commands,
            task_id: value.task_id,
            flight_id: value.flight_id,
            agent_config_id: value.agent_config_id,
            initial_prompt: value.initial_prompt,
            override_command: value.override_command,
            override_args: value.override_args,
        }
    }
}

impl From<WorkspacePaneDto> for core_workspace::WorkspacePane {
    fn from(value: WorkspacePaneDto) -> Self {
        Self {
            id: value.id,
            agent_id: value.agent_id.into(),
            session_id: value.session_id,
            grid_position: value.grid_position.into(),
            accent_color: value.accent_color,
            pinned_commands: value.pinned_commands,
            task_id: value.task_id,
            flight_id: value.flight_id,
            agent_config_id: value.agent_config_id,
            initial_prompt: value.initial_prompt,
            override_command: value.override_command,
            override_args: value.override_args,
        }
    }
}

impl From<core_workspace::GithubRepo> for GithubRepoDto {
    fn from(value: core_workspace::GithubRepo) -> Self {
        Self {
            owner: value.owner,
            repo: value.repo,
        }
    }
}

impl From<GithubRepoDto> for core_workspace::GithubRepo {
    fn from(value: GithubRepoDto) -> Self {
        Self {
            owner: value.owner,
            repo: value.repo,
        }
    }
}

impl From<core_workspace::Workspace> for WorkspaceDto {
    fn from(value: core_workspace::Workspace) -> Self {
        Self {
            id: value.id,
            name: value.name,
            agents: value.agents.into_iter().map(Into::into).collect(),
            panes: value.panes.into_iter().map(Into::into).collect(),
            project_path: value.project_path,
            prompt: value.prompt,
            created_at: value.created_at,
            updated_at: value.updated_at,
            status: value.status.into(),
            bypass_permissions: value.bypass_permissions,
            model_overrides: value.model_overrides,
            effort_overrides: value.effort_overrides,
            server_id: value.server_id,
            remote_project_path: value.remote_project_path,
            github_repo: value.github_repo.map(Into::into),
        }
    }
}

impl From<WorkspaceDto> for core_workspace::Workspace {
    fn from(value: WorkspaceDto) -> Self {
        Self {
            id: value.id,
            name: value.name,
            agents: value.agents.into_iter().map(Into::into).collect(),
            panes: value.panes.into_iter().map(Into::into).collect(),
            project_path: value.project_path,
            prompt: value.prompt,
            created_at: value.created_at,
            updated_at: value.updated_at,
            status: value.status.into(),
            bypass_permissions: value.bypass_permissions,
            model_overrides: value.model_overrides,
            effort_overrides: value.effort_overrides,
            server_id: value.server_id,
            remote_project_path: value.remote_project_path,
            github_repo: value.github_repo.map(Into::into),
        }
    }
}

impl From<core_storage::PersistedUiState> for PersistedUiStateDto {
    fn from(value: core_storage::PersistedUiState) -> Self {
        Self {
            selected_flight_id: value.selected_flight_id,
            selected_view: value.selected_view,
            theme: value.theme.and_then(|theme| match theme.as_str() {
                "dark" => Some(ThemeDto::Dark),
                "light" => Some(ThemeDto::Light),
                _ => None,
            }),
        }
    }
}

impl From<PersistedUiStateDto> for core_storage::PersistedUiState {
    fn from(value: PersistedUiStateDto) -> Self {
        Self {
            selected_flight_id: value.selected_flight_id,
            selected_view: value.selected_view,
            theme: value.theme.map(|theme| match theme {
                ThemeDto::Dark => "dark".to_string(),
                ThemeDto::Light => "light".to_string(),
            }),
        }
    }
}

impl From<core_orchestrator::OrchestratorSettings> for OrchestratorSettingsDto {
    fn from(value: core_orchestrator::OrchestratorSettings) -> Self {
        Self {
            max_parallel_sessions: value.max_parallel_sessions,
            milestone_gating: value.milestone_gating,
            project_path: value.project_path,
            auto_commit_trailer_enabled: value.auto_commit_trailer_enabled,
            auto_commit_trailer_format: value.auto_commit_trailer_format,
        }
    }
}

impl From<OrchestratorSettingsDto> for core_orchestrator::OrchestratorSettings {
    fn from(value: OrchestratorSettingsDto) -> Self {
        Self {
            max_parallel_sessions: value.max_parallel_sessions,
            milestone_gating: value.milestone_gating,
            project_path: value.project_path,
            auto_commit_trailer_enabled: value.auto_commit_trailer_enabled,
            auto_commit_trailer_format: value.auto_commit_trailer_format,
        }
    }
}

impl From<core_agent::AgentCapability> for AgentCapabilityDto {
    fn from(value: core_agent::AgentCapability) -> Self {
        match value {
            core_agent::AgentCapability::CodeEdit => Self::CodeEdit,
            core_agent::AgentCapability::CodeReview => Self::CodeReview,
            core_agent::AgentCapability::Testing => Self::Testing,
            core_agent::AgentCapability::Research => Self::Research,
            core_agent::AgentCapability::Shell => Self::Shell,
            core_agent::AgentCapability::Refactor => Self::Refactor,
        }
    }
}

impl From<AgentCapabilityDto> for core_agent::AgentCapability {
    fn from(value: AgentCapabilityDto) -> Self {
        match value {
            AgentCapabilityDto::CodeEdit => Self::CodeEdit,
            AgentCapabilityDto::CodeReview => Self::CodeReview,
            AgentCapabilityDto::Testing => Self::Testing,
            AgentCapabilityDto::Research => Self::Research,
            AgentCapabilityDto::Shell => Self::Shell,
            AgentCapabilityDto::Refactor => Self::Refactor,
        }
    }
}

impl From<core_agent::ToolUsePattern> for ToolUsePatternDto {
    fn from(value: core_agent::ToolUsePattern) -> Self {
        Self {
            pattern: value.pattern,
            tool: value.tool,
            file_group: value.file_group,
        }
    }
}

impl From<ToolUsePatternDto> for core_agent::ToolUsePattern {
    fn from(value: ToolUsePatternDto) -> Self {
        Self {
            pattern: value.pattern,
            tool: value.tool,
            file_group: value.file_group,
        }
    }
}

impl From<core_agent::AgentStatusPatterns> for AgentStatusPatternsDto {
    fn from(value: core_agent::AgentStatusPatterns) -> Self {
        Self {
            approval: value.approval,
            thinking: value.thinking,
            tool_use: value.tool_use.into_iter().map(Into::into).collect(),
            idle: value.idle,
        }
    }
}

impl From<AgentStatusPatternsDto> for core_agent::AgentStatusPatterns {
    fn from(value: AgentStatusPatternsDto) -> Self {
        Self {
            approval: value.approval,
            thinking: value.thinking,
            tool_use: value.tool_use.into_iter().map(Into::into).collect(),
            idle: value.idle,
        }
    }
}

impl From<core_agent::AgentApprovalActions> for AgentApprovalActionsDto {
    fn from(value: core_agent::AgentApprovalActions) -> Self {
        Self {
            approve: value.approve,
            deny: value.deny,
            abort: value.abort,
        }
    }
}

impl From<AgentApprovalActionsDto> for core_agent::AgentApprovalActions {
    fn from(value: AgentApprovalActionsDto) -> Self {
        Self {
            approve: value.approve,
            deny: value.deny,
            abort: value.abort,
        }
    }
}

impl From<core_agent::AgentConfig> for AgentConfigDto {
    fn from(value: core_agent::AgentConfig) -> Self {
        Self {
            id: value.id,
            name: value.name,
            command: value.command,
            default_args: value.default_args,
            description: value.description,
            installed: value.installed,
            capabilities: value.capabilities.into_iter().map(Into::into).collect(),
            icon: value.icon,
            color: value.color,
            status_patterns: value.status_patterns.into(),
            approval_actions: value.approval_actions.into(),
            is_builtin: value.is_builtin,
        }
    }
}

impl From<AgentConfigDto> for core_agent::AgentConfig {
    fn from(value: AgentConfigDto) -> Self {
        Self {
            id: value.id,
            name: value.name,
            command: value.command,
            default_args: value.default_args,
            description: value.description,
            installed: value.installed,
            capabilities: value.capabilities.into_iter().map(Into::into).collect(),
            icon: value.icon,
            color: value.color,
            status_patterns: value.status_patterns.into(),
            approval_actions: value.approval_actions.into(),
            is_builtin: value.is_builtin,
        }
    }
}

macro_rules! impl_enum_conversion {
    ($dto:ty, $core:ty, { $($core_variant:path => $dto_variant:path),+ $(,)? }) => {
        impl From<$core> for $dto {
            fn from(value: $core) -> Self {
                match value {
                    $($core_variant => $dto_variant,)+
                }
            }
        }

        impl From<$dto> for $core {
            fn from(value: $dto) -> Self {
                match value {
                    $($dto_variant => $core_variant,)+
                }
            }
        }
    };
}

impl_enum_conversion!(FlightStatusDto, core_flight::FlightStatus, {
    core_flight::FlightStatus::Draft => FlightStatusDto::Draft,
    core_flight::FlightStatus::Spec => FlightStatusDto::Spec,
    core_flight::FlightStatus::Planning => FlightStatusDto::Planning,
    core_flight::FlightStatus::Ready => FlightStatusDto::Ready,
    core_flight::FlightStatus::Active => FlightStatusDto::Active,
    core_flight::FlightStatus::Paused => FlightStatusDto::Paused,
    core_flight::FlightStatus::Review => FlightStatusDto::Review,
    core_flight::FlightStatus::Done => FlightStatusDto::Done,
    core_flight::FlightStatus::Failed => FlightStatusDto::Failed,
    core_flight::FlightStatus::Cancelled => FlightStatusDto::Cancelled
});

impl_enum_conversion!(PlannerStatusDto, core_flight::PlannerStatus, {
    core_flight::PlannerStatus::Idle => PlannerStatusDto::Idle,
    core_flight::PlannerStatus::Awake => PlannerStatusDto::Awake,
    core_flight::PlannerStatus::Paused => PlannerStatusDto::Paused,
    core_flight::PlannerStatus::QuotaPaused => PlannerStatusDto::QuotaPaused,
    core_flight::PlannerStatus::Completed => PlannerStatusDto::Completed,
    core_flight::PlannerStatus::Failed => PlannerStatusDto::Failed
});

impl_enum_conversion!(FlightPriorityDto, core_flight::FlightPriority, {
    core_flight::FlightPriority::Low => FlightPriorityDto::Low,
    core_flight::FlightPriority::Medium => FlightPriorityDto::Medium,
    core_flight::FlightPriority::High => FlightPriorityDto::High,
    core_flight::FlightPriority::Critical => FlightPriorityDto::Critical
});

impl_enum_conversion!(MilestoneStatusDto, core_flight::MilestoneStatus, {
    core_flight::MilestoneStatus::Pending => MilestoneStatusDto::Pending,
    core_flight::MilestoneStatus::Active => MilestoneStatusDto::Active,
    core_flight::MilestoneStatus::Done => MilestoneStatusDto::Done,
    core_flight::MilestoneStatus::Failed => MilestoneStatusDto::Failed
});

impl_enum_conversion!(TaskStatusDto, core_flight::TaskStatus, {
    core_flight::TaskStatus::Pending => TaskStatusDto::Pending,
    core_flight::TaskStatus::Blocked => TaskStatusDto::Blocked,
    core_flight::TaskStatus::Queued => TaskStatusDto::Queued,
    core_flight::TaskStatus::Running => TaskStatusDto::Running,
    core_flight::TaskStatus::ApprovalNeeded => TaskStatusDto::ApprovalNeeded,
    core_flight::TaskStatus::Paused => TaskStatusDto::Paused,
    core_flight::TaskStatus::Done => TaskStatusDto::Done,
    core_flight::TaskStatus::Failed => TaskStatusDto::Failed,
    core_flight::TaskStatus::Cancelled => TaskStatusDto::Cancelled
});

impl_enum_conversion!(TaskTypeDto, core_flight::TaskType, {
    core_flight::TaskType::Implementation => TaskTypeDto::Implementation,
    core_flight::TaskType::Testing => TaskTypeDto::Testing,
    core_flight::TaskType::Review => TaskTypeDto::Review,
    core_flight::TaskType::Validation => TaskTypeDto::Validation,
    core_flight::TaskType::Research => TaskTypeDto::Research,
    core_flight::TaskType::Refactor => TaskTypeDto::Refactor,
    core_flight::TaskType::Documentation => TaskTypeDto::Documentation
});

impl_enum_conversion!(ValidationVerdictDto, core_flight::ValidationVerdict, {
    core_flight::ValidationVerdict::Pass => ValidationVerdictDto::Pass,
    core_flight::ValidationVerdict::Fail => ValidationVerdictDto::Fail,
    core_flight::ValidationVerdict::Warn => ValidationVerdictDto::Warn
});

impl_enum_conversion!(ReviewTypeDto, core_flight::ReviewType, {
    core_flight::ReviewType::ToolCall => ReviewTypeDto::ToolCall,
    core_flight::ReviewType::FileWrite => ReviewTypeDto::FileWrite,
    core_flight::ReviewType::Command => ReviewTypeDto::Command,
    core_flight::ReviewType::MilestoneGate => ReviewTypeDto::MilestoneGate
});

impl From<core_flight::TaskHandoff> for TaskHandoffDto {
    fn from(value: core_flight::TaskHandoff) -> Self {
        Self {
            summary: value.summary,
            files_changed: value.files_changed,
            tests_needed: value.tests_needed,
            follow_ups: value.follow_ups,
        }
    }
}

impl From<TaskHandoffDto> for core_flight::TaskHandoff {
    fn from(value: TaskHandoffDto) -> Self {
        Self {
            summary: value.summary,
            files_changed: value.files_changed,
            tests_needed: value.tests_needed,
            follow_ups: value.follow_ups,
        }
    }
}

impl From<core_flight::TaskValidationAssertion> for TaskValidationAssertionDto {
    fn from(value: core_flight::TaskValidationAssertion) -> Self {
        Self {
            label: value.label,
            status: value.status.into(),
            details: value.details,
        }
    }
}

impl From<TaskValidationAssertionDto> for core_flight::TaskValidationAssertion {
    fn from(value: TaskValidationAssertionDto) -> Self {
        Self {
            label: value.label,
            status: value.status.into(),
            details: value.details,
        }
    }
}

impl From<core_flight::TaskValidationReport> for TaskValidationReportDto {
    fn from(value: core_flight::TaskValidationReport) -> Self {
        Self {
            verdict: value.verdict.into(),
            summary: value.summary,
            assertions: value.assertions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TaskValidationReportDto> for core_flight::TaskValidationReport {
    fn from(value: TaskValidationReportDto) -> Self {
        Self {
            verdict: value.verdict.into(),
            summary: value.summary,
            assertions: value.assertions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<core_flight::TaskResult> for TaskResultDto {
    fn from(value: core_flight::TaskResult) -> Self {
        Self {
            exit_code: value.exit_code,
            summary: value.summary,
            files_changed: value.files_changed,
            errors: value.errors,
            duration: value.duration_ms,
            handoff: value.handoff.map(Into::into),
            validation: value.validation.map(Into::into),
        }
    }
}

impl From<TaskResultDto> for core_flight::TaskResult {
    fn from(value: TaskResultDto) -> Self {
        Self {
            exit_code: value.exit_code,
            summary: value.summary,
            files_changed: value.files_changed,
            errors: value.errors,
            duration_ms: value.duration,
            handoff: value.handoff.map(Into::into),
            validation: value.validation.map(Into::into),
        }
    }
}

impl From<core_flight::ReviewPacket> for ReviewPacketDto {
    fn from(value: core_flight::ReviewPacket) -> Self {
        Self {
            id: value.id,
            task_id: value.task_id,
            flight_id: value.flight_id,
            milestone_id: value.milestone_id,
            requested_at: value.requested_at,
            review_type: value.review_type.into(),
            summary: value.summary,
            diff: value.diff,
            command: value.command,
            file_paths: value.file_paths,
            agent_id: value.agent_id,
            session_id: value.session_id,
        }
    }
}

impl From<ReviewPacketDto> for core_flight::ReviewPacket {
    fn from(value: ReviewPacketDto) -> Self {
        Self {
            id: value.id,
            task_id: value.task_id,
            flight_id: value.flight_id,
            milestone_id: value.milestone_id,
            requested_at: value.requested_at,
            review_type: value.review_type.into(),
            summary: value.summary,
            diff: value.diff,
            command: value.command,
            file_paths: value.file_paths,
            agent_id: value.agent_id,
            session_id: value.session_id,
        }
    }
}

impl From<core_flight::Task> for TaskDto {
    fn from(value: core_flight::Task) -> Self {
        Self {
            id: value.id,
            milestone_id: value.milestone_id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            task_type: value.task_type.into(),
            agent_config_id: value.agent_config_id,
            agent_args: value.agent_args,
            model: value.model,
            depends_on: value.depends_on,
            session_id: value.session_id,
            result: value.result.map(Into::into),
            review_packet: value.review_packet.map(Into::into),
            created_at: value.created_at,
            started_at: value.started_at,
            completed_at: value.completed_at,
            cost: value.cost,
            tokens: value.tokens,
            owned_paths: if value.owned_paths.is_empty() {
                None
            } else {
                Some(value.owned_paths)
            },
            replan_count: value.replan_count,
        }
    }
}

impl From<TaskDto> for core_flight::Task {
    fn from(value: TaskDto) -> Self {
        Self {
            id: value.id,
            milestone_id: value.milestone_id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            task_type: value.task_type.into(),
            agent_config_id: value.agent_config_id,
            agent_args: value.agent_args,
            model: value.model,
            depends_on: value.depends_on,
            session_id: value.session_id,
            result: value.result.map(Into::into),
            review_packet: value.review_packet.map(Into::into),
            created_at: value.created_at,
            started_at: value.started_at,
            completed_at: value.completed_at,
            cost: value.cost,
            tokens: value.tokens,
            owned_paths: value.owned_paths.unwrap_or_default(),
            replan_count: value.replan_count,
        }
    }
}

impl From<core_flight::Milestone> for MilestoneDto {
    fn from(value: core_flight::Milestone) -> Self {
        Self {
            id: value.id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            tasks: value.tasks.into_iter().map(Into::into).collect(),
            validation_criteria: value.validation_criteria,
        }
    }
}

impl From<MilestoneDto> for core_flight::Milestone {
    fn from(value: MilestoneDto) -> Self {
        Self {
            id: value.id,
            flight_id: value.flight_id,
            title: value.title,
            description: value.description,
            order: value.order,
            status: value.status.into(),
            tasks: value.tasks.into_iter().map(Into::into).collect(),
            validation_criteria: value.validation_criteria,
        }
    }
}

impl From<core_flight::AttemptStatus> for AttemptStatusDto {
    fn from(s: core_flight::AttemptStatus) -> Self {
        match s {
            core_flight::AttemptStatus::Queued => Self::Queued,
            core_flight::AttemptStatus::Provisioning => Self::Provisioning,
            core_flight::AttemptStatus::Running => Self::Running,
            core_flight::AttemptStatus::Reviewing => Self::Reviewing,
            core_flight::AttemptStatus::Completed => Self::Completed,
            core_flight::AttemptStatus::Failed => Self::Failed,
            core_flight::AttemptStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<AttemptStatusDto> for core_flight::AttemptStatus {
    fn from(s: AttemptStatusDto) -> Self {
        match s {
            AttemptStatusDto::Queued => Self::Queued,
            AttemptStatusDto::Provisioning => Self::Provisioning,
            AttemptStatusDto::Running => Self::Running,
            AttemptStatusDto::Reviewing => Self::Reviewing,
            AttemptStatusDto::Completed => Self::Completed,
            AttemptStatusDto::Failed => Self::Failed,
            AttemptStatusDto::Cancelled => Self::Cancelled,
        }
    }
}

impl From<core_flight::AttemptTarget> for AttemptTargetDto {
    fn from(t: core_flight::AttemptTarget) -> Self {
        match t {
            core_flight::AttemptTarget::Local {
                base_path,
                worktree_path,
            } => Self::Local {
                base_path,
                worktree_path,
            },
            core_flight::AttemptTarget::Ssh {
                target_id,
                base_path,
                worktree_path,
            } => Self::Ssh {
                target_id,
                base_path,
                worktree_path,
            },
        }
    }
}

impl From<AttemptTargetDto> for core_flight::AttemptTarget {
    fn from(t: AttemptTargetDto) -> Self {
        match t {
            AttemptTargetDto::Local {
                base_path,
                worktree_path,
            } => Self::Local {
                base_path,
                worktree_path,
            },
            AttemptTargetDto::Ssh {
                target_id,
                base_path,
                worktree_path,
            } => Self::Ssh {
                target_id,
                base_path,
                worktree_path,
            },
        }
    }
}

impl From<core_flight::Attempt> for AttemptDto {
    fn from(a: core_flight::Attempt) -> Self {
        Self {
            id: a.id,
            flight_id: a.flight_id,
            target: a.target.into(),
            agent_config_id: a.agent_config_id,
            model: a.model,
            provider: a.provider,
            branch: a.branch,
            base_branch: a.base_branch,
            session_id: a.session_id,
            status: a.status.into(),
            started_at: a.started_at,
            completed_at: a.completed_at,
            cost: a.cost,
            tokens: a.tokens,
            error_message: a.error_message,
            draft_pr_number: a.draft_pr_number,
        }
    }
}

impl From<AttemptDto> for core_flight::Attempt {
    fn from(a: AttemptDto) -> Self {
        Self {
            id: a.id,
            flight_id: a.flight_id,
            target: a.target.into(),
            agent_config_id: a.agent_config_id,
            model: a.model,
            provider: a.provider,
            branch: a.branch,
            base_branch: a.base_branch,
            session_id: a.session_id,
            status: a.status.into(),
            started_at: a.started_at,
            completed_at: a.completed_at,
            cost: a.cost,
            tokens: a.tokens,
            error_message: a.error_message,
            draft_pr_number: a.draft_pr_number,
        }
    }
}

impl From<core_flight::Flight> for FlightDto {
    fn from(value: core_flight::Flight) -> Self {
        Self {
            id: value.id,
            title: value.title,
            objective: value.objective,
            status: value.status.into(),
            priority: value.priority.into(),
            project_path: value.project_path,
            workspace_id: value.workspace_id,
            git_branch: value.git_branch,
            milestones: value.milestones.into_iter().map(Into::into).collect(),
            linked_session_ids: value.linked_session_ids,
            issue_ids: Vec::new(),
            created_at: value.created_at,
            updated_at: value.updated_at,
            completed_at: value.completed_at,
            total_cost: value.total_cost,
            total_tokens: value.total_tokens,
            prompt: value.prompt,
            attempts: value.attempts.into_iter().map(Into::into).collect(),
            planner_session_id: value.planner_session_id,
            planner_status: value.planner_status.map(Into::into),
            planner_cost: value.planner_cost,
            planner_tokens: value.planner_tokens,
            planner_provider: value.planner_provider,
            publish_attempts_as_prs: value.publish_attempts_as_prs,
        }
    }
}

impl From<FlightDto> for core_flight::Flight {
    fn from(value: FlightDto) -> Self {
        Self {
            id: value.id,
            title: value.title,
            objective: value.objective,
            status: value.status.into(),
            priority: value.priority.into(),
            project_path: value.project_path,
            workspace_id: value.workspace_id,
            git_branch: value.git_branch,
            milestones: value.milestones.into_iter().map(Into::into).collect(),
            linked_session_ids: value.linked_session_ids,
            created_at: value.created_at,
            updated_at: value.updated_at,
            completed_at: value.completed_at,
            total_cost: value.total_cost,
            total_tokens: value.total_tokens,
            prompt: value.prompt,
            attempts: value.attempts.into_iter().map(Into::into).collect(),
            planner_session_id: value.planner_session_id,
            planner_status: value.planner_status.map(Into::into),
            planner_cost: value.planner_cost,
            planner_tokens: value.planner_tokens,
            planner_provider: value.planner_provider,
            publish_attempts_as_prs: value.publish_attempts_as_prs,
        }
    }
}

impl From<core_storage::PersistedState> for PersistedStateDto {
    fn from(value: core_storage::PersistedState) -> Self {
        Self {
            version: value.version,
            flights: value.flights.into_iter().map(Into::into).collect(),
            agents: value.agents.into_iter().map(Into::into).collect(),
            settings: value.settings.into(),
            ui: value.ui.into(),
            workspaces: value.workspaces.into_iter().map(Into::into).collect(),
            memory_events: value.memory_events,
            memory_patterns: value.memory_patterns,
            servers: value.servers.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PersistedStateDto> for core_storage::PersistedState {
    fn from(value: PersistedStateDto) -> Self {
        Self {
            version: value.version,
            flights: value.flights.into_iter().map(Into::into).collect(),
            agents: value.agents.into_iter().map(Into::into).collect(),
            settings: value.settings.into(),
            ui: value.ui.into(),
            issues: Vec::new(),
            workspaces: value.workspaces.into_iter().map(Into::into).collect(),
            retrospectives: Vec::new(),
            memory_events: value.memory_events,
            memory_patterns: value.memory_patterns,
            servers: value.servers.into_iter().map(Into::into).collect(),
            // Mission approvals only travel as part of the planner state
            // surface; the legacy DTO→core round-trip used by the
            // settings save path does not carry them, so we drop them
            // here. (The frontend reads approvals through a dedicated
            // mission-planner query, not through PersistedStateDto.)
            mission_approvals: Vec::new(),
        }
    }
}

impl From<core_orchestrator::TaskSpawnRequest> for TaskSpawnRequestDto {
    fn from(value: core_orchestrator::TaskSpawnRequest) -> Self {
        Self {
            flight_id: value.flight_id,
            milestone_id: value.milestone_id,
            task_id: value.task_id,
            agent_config_id: value.agent_config_id,
            command: value.command,
            args: value.args,
            prompt: value.prompt,
            project_path: value.project_path,
        }
    }
}

impl From<TaskSpawnRequestDto> for core_orchestrator::TaskSpawnRequest {
    fn from(value: TaskSpawnRequestDto) -> Self {
        Self {
            flight_id: value.flight_id,
            milestone_id: value.milestone_id,
            task_id: value.task_id,
            agent_config_id: value.agent_config_id,
            command: value.command,
            args: value.args,
            prompt: value.prompt,
            project_path: value.project_path,
        }
    }
}

impl From<RunningTaskSnapshot> for RunningTaskSnapshotDto {
    fn from(value: RunningTaskSnapshot) -> Self {
        Self {
            task_id: value.task_id,
            milestone_id: value.milestone_id,
            flight_id: value.flight_id,
            session_id: value.session_id,
            agent_config_id: value.agent_config_id,
            started_at: value.started_at,
        }
    }
}

impl From<OrchestratorSnapshot> for OrchestratorSnapshotDto {
    fn from(value: OrchestratorSnapshot) -> Self {
        Self {
            running_task_ids: value.running_task_ids,
            running_tasks: value.running_tasks.into_iter().map(Into::into).collect(),
            active_flight_ids: value.active_flight_ids,
            paused_at_milestone: value.paused_at_milestone,
        }
    }
}

#[cfg(test)]
fn generated_typescript_schema() -> String {
    let mut lines = vec![
        "// Auto-generated from Rust API DTOs. Run `pnpm generate:tauri-schema` to refresh."
            .to_string(),
        String::new(),
    ];

    macro_rules! push_decl {
        ($ty:ty) => {{
            let decl = <$ty as TS>::decl();
            lines.push(format!(
                "export {}{}",
                decl,
                if decl.ends_with('\n') { "" } else { "\n" }
            ));
        }};
    }

    push_decl!(WorkspaceAgentSlotDto);
    push_decl!(WorkspaceStatusDto);
    push_decl!(ThemeDto);
    push_decl!(GridPositionDto);
    push_decl!(WorkspacePaneDto);
    push_decl!(GithubRepoDto);
    push_decl!(WorkspaceDto);
    push_decl!(ServerConfigDto);
    push_decl!(PersistedUiStateDto);
    push_decl!(OrchestratorSettingsDto);
    push_decl!(AgentCapabilityDto);
    push_decl!(ToolUsePatternDto);
    push_decl!(AgentStatusPatternsDto);
    push_decl!(AgentApprovalActionsDto);
    push_decl!(AgentConfigDto);
    push_decl!(FlightStatusDto);
    push_decl!(PlannerStatusDto);
    push_decl!(MissionApprovalRequestDto);
    push_decl!(FlightPriorityDto);
    push_decl!(MilestoneStatusDto);
    push_decl!(TaskStatusDto);
    push_decl!(TaskTypeDto);
    push_decl!(ValidationVerdictDto);
    push_decl!(ReviewTypeDto);
    push_decl!(TaskHandoffDto);
    push_decl!(TaskValidationAssertionDto);
    push_decl!(TaskValidationReportDto);
    push_decl!(TaskResultDto);
    push_decl!(ReviewPacketDto);
    push_decl!(TaskDto);
    push_decl!(MilestoneDto);
    push_decl!(AttemptStatusDto);
    push_decl!(AttemptTargetDto);
    push_decl!(AttemptDto);
    push_decl!(FlightDto);
    push_decl!(PersistedStateDto);
    push_decl!(TaskSpawnRequestDto);
    push_decl!(RunningTaskSnapshotDto);
    push_decl!(OrchestratorSnapshotDto);

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "run manually to refresh checked-in TS bindings"]
    fn export_api_bindings() {
        let out_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated");
        std::fs::create_dir_all(&out_dir).unwrap();
        std::fs::write(
            out_dir.join("tauri-schema.ts"),
            generated_typescript_schema(),
        )
        .unwrap();
    }

    #[test]
    fn persisted_state_dto_serializes_with_camel_case_transport_keys() {
        let dto = PersistedStateDto {
            version: 1,
            flights: vec![FlightDto {
                id: "flight-1".into(),
                title: "Flight".into(),
                objective: "Objective".into(),
                status: FlightStatusDto::Active,
                priority: FlightPriorityDto::High,
                project_path: "/test".into(),
                workspace_id: None,
                git_branch: Some("main".into()),
                milestones: vec![MilestoneDto {
                    id: "ms-1".into(),
                    flight_id: "flight-1".into(),
                    title: "Milestone".into(),
                    description: "Desc".into(),
                    order: 0,
                    status: MilestoneStatusDto::Active,
                    tasks: vec![TaskDto {
                        id: "task-1".into(),
                        milestone_id: "ms-1".into(),
                        flight_id: "flight-1".into(),
                        title: "Task".into(),
                        description: "Desc".into(),
                        order: 0,
                        status: TaskStatusDto::Running,
                        task_type: TaskTypeDto::Implementation,
                        agent_config_id: "claude-code".into(),
                        agent_args: None,
                        model: None,
                        depends_on: Vec::new(),
                        session_id: None,
                        result: Some(TaskResultDto {
                            exit_code: Some(0),
                            summary: "ok".into(),
                            files_changed: vec!["src/main.rs".into()],
                            errors: Vec::new(),
                            duration: 10,
                            handoff: None,
                            validation: None,
                        }),
                        review_packet: None,
                        created_at: 0,
                        started_at: None,
                        completed_at: None,
                        cost: 0.0,
                        tokens: 0,
                        owned_paths: None,
                        replan_count: 0,
                    }],
                    validation_criteria: Vec::new(),
                }],
                linked_session_ids: vec!["session-1".into()],
                issue_ids: Vec::new(),
                created_at: 0,
                updated_at: 0,
                completed_at: None,
                total_cost: 0.0,
                total_tokens: 0,
                prompt: None,
                attempts: vec![],
                planner_session_id: None,
                planner_status: None,
                planner_cost: None,
                planner_tokens: None,
                planner_provider: None,
                publish_attempts_as_prs: false,
            }],
            agents: Vec::new(),
            settings: OrchestratorSettingsDto {
                max_parallel_sessions: 3,
                milestone_gating: true,
                project_path: "/test".into(),
                auto_commit_trailer_enabled: true,
                auto_commit_trailer_format: core_orchestrator::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT
                    .into(),
            },
            ui: PersistedUiStateDto {
                selected_flight_id: None,
                selected_view: None,
                theme: Some(ThemeDto::Dark),
            },
            workspaces: Vec::new(),
            memory_events: Vec::new(),
            memory_patterns: Vec::new(),
            servers: Vec::new(),
        };

        let value = serde_json::to_value(dto).unwrap();
        assert!(value["settings"].get("maxParallelSessions").is_some());
        assert!(value["settings"].get("milestoneGating").is_some());
        assert!(value["settings"].get("projectPath").is_some());
        assert!(value["flights"][0].get("projectPath").is_some());
        assert!(value["flights"][0]["milestones"][0]
            .get("flightId")
            .is_some());
        assert!(value["flights"][0]["milestones"][0]["tasks"][0]
            .get("milestoneId")
            .is_some());
        assert!(value["flights"][0]["milestones"][0]["tasks"][0]
            .get("agentConfigId")
            .is_some());
        assert!(value["flights"][0]["milestones"][0]["tasks"][0]["result"]
            .get("filesChanged")
            .is_some());
        assert_eq!(value["ui"]["theme"], "dark");
    }

    #[test]
    fn workspace_dto_preserves_frontend_metadata_through_core_round_trip() {
        let json = r#"{
            "id": "workspace-1",
            "name": "Workspace",
            "agents": ["codex"],
            "panes": [
                {
                    "id": "pane-1",
                    "agentId": "codex",
                    "sessionId": "session-1",
                    "gridPosition": { "row": 0, "col": 0 },
                    "accentColor": "accent-green",
                    "pinnedCommands": ["pnpm test"],
                    "taskId": "task-1",
                    "flightId": "flight-1",
                    "agentConfigId": "codex",
                    "initialPrompt": "Start here",
                    "overrideCommand": "codex",
                    "overrideArgs": ["--ask-for-approval", "never"]
                }
            ],
            "projectPath": "/repo",
            "prompt": null,
            "createdAt": 1,
            "updatedAt": 2,
            "status": "active",
            "githubRepo": { "owner": "openai", "repo": "packetade" }
        }"#;

        let dto: WorkspaceDto = serde_json::from_str(json).expect("workspace dto should parse");
        let core: core_workspace::Workspace = dto.into();

        let pane = &core.panes[0];
        assert_eq!(pane.accent_color.as_deref(), Some("accent-green"));
        assert_eq!(
            pane.pinned_commands.as_deref(),
            Some(&["pnpm test".to_string()][..])
        );
        assert_eq!(pane.task_id.as_deref(), Some("task-1"));
        assert_eq!(pane.flight_id.as_deref(), Some("flight-1"));
        assert_eq!(pane.agent_config_id.as_deref(), Some("codex"));
        assert_eq!(pane.initial_prompt.as_deref(), Some("Start here"));
        assert_eq!(pane.override_command.as_deref(), Some("codex"));
        assert_eq!(
            pane.override_args.as_deref(),
            Some(&["--ask-for-approval".to_string(), "never".to_string()][..])
        );
        let github_repo = core
            .github_repo
            .as_ref()
            .expect("github repo should persist");
        assert_eq!(github_repo.owner, "openai");
        assert_eq!(github_repo.repo, "packetade");

        let back: WorkspaceDto = core.into();
        let value = serde_json::to_value(back).unwrap();
        assert_eq!(value["githubRepo"]["owner"], "openai");
        assert_eq!(value["githubRepo"]["repo"], "packetade");
        assert_eq!(value["panes"][0]["accentColor"], "accent-green");
        assert_eq!(value["panes"][0]["pinnedCommands"][0], "pnpm test");
        assert_eq!(value["panes"][0]["taskId"], "task-1");
        assert_eq!(value["panes"][0]["flightId"], "flight-1");
        assert_eq!(value["panes"][0]["agentConfigId"], "codex");
        assert_eq!(value["panes"][0]["initialPrompt"], "Start here");
        assert_eq!(value["panes"][0]["overrideCommand"], "codex");
        assert_eq!(value["panes"][0]["overrideArgs"][0], "--ask-for-approval");
        assert_eq!(value["panes"][0]["overrideArgs"][1], "never");
    }

    #[test]
    fn task_dto_replan_count_round_trips_through_core_and_camel_case() {
        // Core Task → TaskDto → Core Task should preserve replan_count.
        let mut task = core_flight::Task {
            id: "t1".into(),
            milestone_id: "m1".into(),
            flight_id: "f1".into(),
            title: "x".into(),
            description: String::new(),
            order: 0,
            status: core_flight::TaskStatus::Failed,
            task_type: core_flight::TaskType::Implementation,
            agent_config_id: "claude-code".into(),
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
        };
        task.replan_count = 2;

        let dto: TaskDto = task.into();
        assert_eq!(dto.replan_count, 2);

        // Wire shape: camelCase `replanCount` is what the frontend reads.
        let value = serde_json::to_value(&dto).unwrap();
        assert_eq!(value["replanCount"], 2);

        // Round-trip back through core_flight::Task.
        let back: core_flight::Task = dto.into();
        assert_eq!(back.replan_count, 2);
    }

    #[test]
    fn task_dto_replan_count_defaults_when_missing_in_camel_case_json() {
        // Frontend / legacy persisted state may emit a TaskDto JSON without
        // `replanCount` — `#[serde(default)]` on the DTO must let us
        // deserialize cleanly with the field set to 0.
        let json = r#"{
            "id": "t1",
            "milestoneId": "m1",
            "flightId": "f1",
            "title": "x",
            "description": "",
            "order": 0,
            "status": "queued",
            "type": "implementation",
            "agentConfigId": "claude-code",
            "dependsOn": [],
            "sessionId": null,
            "createdAt": 0,
            "cost": 0.0,
            "tokens": 0
        }"#;
        let dto: TaskDto = serde_json::from_str(json).expect("legacy task dto should parse");
        assert_eq!(dto.replan_count, 0);
    }
}
