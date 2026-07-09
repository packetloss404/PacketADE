// Auto-generated from Rust API DTOs. Run `pnpm generate:tauri-schema` to refresh.

export type WorkspaceAgentSlotDto = "terminal" | "claude-code" | "codex" | "gemini" | "opencode" | "packetcode";

export type WorkspaceStatusDto = "active" | "archived";

export type ThemeDto = "dark" | "light";

export type GridPositionDto = { row: number, col: number, };

export type WorkspacePaneDto = { id: string, agentId: WorkspaceAgentSlotDto, sessionId: string | null, gridPosition: GridPositionDto, accentColor?: string, pinnedCommands?: Array<string>, taskId?: string, flightId?: string, agentConfigId?: string, initialPrompt?: string, overrideCommand?: string, overrideArgs?: Array<string>, 
/**
 * Pane kind discriminant (tile program, P1-S1). Absent ⇒ terminal. `kind`
 * is the SOLE discriminant; `agent_id` is never overloaded — conversation
 * panes carry the inert carrier `agentId: "terminal"`.
 */
kind?: string, 
/**
 * Set iff `kind == Some("conversation")`.
 */
conversationId?: string, };

export type GithubRepoDto = { owner: string, repo: string, };

export type WorkspaceDto = { id: string, name: string, agents: Array<WorkspaceAgentSlotDto>, panes: Array<WorkspacePaneDto>, projectPath: string, prompt?: string, createdAt: number, updatedAt: number, status: WorkspaceStatusDto, bypassPermissions?: boolean, modelOverrides?: { [key in string]?: string | null }, effortOverrides?: { [key in string]?: string | null }, serverId?: string, remoteProjectPath?: string, githubRepo?: GithubRepoDto, };

export type ServerConfigDto = { id: string, name: string, host: string, port: number, username: string, authMethod: string, keyPath: string | null, remotePath: string | null, lastConnectedAt: bigint | null, installedAgents: Array<string>, hostFingerprint: string | null, };

export type PersistedUiStateDto = { selectedFlightId?: string, selectedView?: string, theme?: ThemeDto, };

export type OrchestratorSettingsDto = { maxParallelSessions: number, milestoneGating: boolean, projectPath: string, autoCommitTrailerEnabled: boolean, autoCommitTrailerFormat: string, };

export type AgentCapabilityDto = "code_edit" | "code_review" | "testing" | "research" | "shell" | "refactor";

export type ToolUsePatternDto = { pattern: string, tool: string, fileGroup?: number, };

export type AgentStatusPatternsDto = { approval: Array<string>, thinking: Array<string>, toolUse: Array<ToolUsePatternDto>, idle: Array<string>, };

export type AgentApprovalActionsDto = { approve: string, deny: string, abort: string, };

export type AgentConfigDto = { id: string, name: string, command: string, defaultArgs: Array<string>, description: string, installed: boolean, capabilities: Array<AgentCapabilityDto>, icon: string, color: string, statusPatterns: AgentStatusPatternsDto, approvalActions: AgentApprovalActionsDto, isBuiltin: boolean, };

export type FlightStatusDto = "draft" | "spec" | "planning" | "ready" | "active" | "paused" | "review" | "done" | "failed" | "cancelled";

export type PlannerStatusDto = "idle" | "awake" | "paused" | "quota_paused" | "completed" | "failed";

export type FlightApprovalRequestDto = { id: string, flightId: string, question: string, options: Array<string>, awaitingSince: number, resolved: boolean, resolution?: string, resolvedAt?: number, };

export type FlightPriorityDto = "low" | "medium" | "high" | "critical";

export type MilestoneStatusDto = "pending" | "active" | "done" | "failed";

export type TaskStatusDto = "pending" | "blocked" | "queued" | "running" | "approval_needed" | "paused" | "done" | "failed" | "cancelled";

export type TaskTypeDto = "implementation" | "testing" | "review" | "validation" | "research" | "refactor" | "documentation";

export type ValidationVerdictDto = "pass" | "fail" | "warn";

export type ReviewTypeDto = "tool_call" | "file_write" | "command" | "milestone_gate";

export type TaskHandoffDto = { summary: string, filesChanged: Array<string>, testsNeeded: Array<string>, followUps: Array<string>, };

export type TaskValidationAssertionDto = { label: string, status: ValidationVerdictDto, details?: string, };

export type TaskValidationReportDto = { verdict: ValidationVerdictDto, summary: string, assertions: Array<TaskValidationAssertionDto>, };

export type TaskResultDto = { exitCode: number | null, summary: string, filesChanged: Array<string>, errors: Array<string>, duration: number, handoff?: TaskHandoffDto, validation?: TaskValidationReportDto, };

export type ReviewPacketDto = { id: string, taskId: string, flightId: string, milestoneId: string, requestedAt: number, reviewType: ReviewTypeDto, summary: string, diff?: string, command?: string, filePaths: Array<string>, agentId?: string, sessionId?: string, };

export type TaskDto = { id: string, milestoneId: string, flightId: string, title: string, description: string, order: number, status: TaskStatusDto, type: TaskTypeDto, agentConfigId: string, agentArgs?: Array<string>, model?: string, dependsOn: Array<string>, sessionId: string | null, result?: TaskResultDto, reviewPacket?: ReviewPacketDto, createdAt: number, startedAt?: number, completedAt?: number, cost: number, tokens: number, 
/**
 * Flight Planner: number of `replan_after_failure` calls this task
 * has triggered (excluding RateLimit/Network exemptions). Mirrored
 * from `FlightPlannerSession.replans_per_task` by
 * `FlightPlannerRegistry::bump_replan_count`. Read by
 * `render_task_failed` for the budget header (`replanCount / 3`).
 */
replanCount: number, ownedPaths?: Array<string>, };

export type MilestoneDto = { id: string, flightId: string, title: string, description: string, order: number, status: MilestoneStatusDto, tasks: Array<TaskDto>, validationCriteria: Array<string>, };

export type AttemptStatusDto = "queued" | "provisioning" | "running" | "reviewing" | "completed" | "failed" | "cancelled";

export type AttemptTargetDto = { "kind": "local", basePath: string, worktreePath: string, } | { "kind": "ssh", targetId: string, basePath: string, worktreePath: string, };

export type AttemptDto = { id: string, flightId: string, target: AttemptTargetDto, agentConfigId: string, model: string, provider: string, branch: string, baseBranch: string, sessionId: string, status: AttemptStatusDto, startedAt?: number, completedAt?: number, cost: number, tokens: number, errorMessage?: string, 
/**
 * v0.8-G: when the parent Flight publishes attempts as draft PRs, the
 * resulting PR number is round-tripped here. Optional everywhere
 * because most attempts will not have a draft PR.
 */
draftPrNumber?: number, };

export type FlightDto = { id: string, title: string, objective: string, status: FlightStatusDto, priority: FlightPriorityDto, projectPath: string, workspaceId?: string, gitBranch?: string, milestones: Array<MilestoneDto>, linkedSessionIds: Array<string>, issueIds: Array<string>, createdAt: number, updatedAt: number, completedAt?: number, totalCost: number, totalTokens: number, prompt?: string, attempts: Array<AttemptDto>, 
/**
 * Flight Planner: long-lived `api-claude-oauth` session id that owns
 * this flight. Absent for flights that never used the planner.
 */
plannerSessionId?: string, 
/**
 * Flight Planner: last-known status of the planner agent for this
 * flight.
 */
plannerStatus?: PlannerStatusDto, 
/**
 * Flight Planner (E8): cumulative USD cost attributed to the planner's
 * own turns. Distinct from `total_cost` which rolls up executor task
 * spend. Absent until the planner closes its first turn.
 */
plannerCost?: number, 
/**
 * Flight Planner (E8): cumulative input+output tokens used by the
 * planner session. Absent until the planner closes its first turn.
 */
plannerTokens?: number, 
/**
 * Flight Planner (E8): provider string the planner runs on (e.g.
 * `"claude-oauth"` for subscription, `"api-claude"` for API-key). The
 * StatGrid chip renders these differently because subscription usage
 * doesn't burn API credit.
 */
plannerProvider?: string, 
/**
 * v0.8-G: when true on an async-mode Flight, the executor pipeline
 * pushes each attempt's branch and opens a draft PR after the attempt
 * reaches a terminal state. Persisted so the toggle round-trips.
 */
publishAttemptsAsPrs: boolean, };

export type PersistedStateDto = { version: number, flights: Array<FlightDto>, agents: Array<AgentConfigDto>, issues: any[], settings: OrchestratorSettingsDto, ui: PersistedUiStateDto, workspaces: Array<WorkspaceDto>, memoryEvents: any[], memoryPatterns: any[], servers: Array<ServerConfigDto>, };

export type TaskSpawnRequestDto = { flightId: string, milestoneId: string, taskId: string, agentConfigId: string, command: string, args: Array<string>, prompt: string, projectPath: string, };

export type RunningTaskSnapshotDto = { taskId: string, milestoneId: string, flightId: string, sessionId: string, agentConfigId: string, startedAt: number, };

export type OrchestratorSnapshotDto = { runningTaskIds: Array<string>, runningTasks: Array<RunningTaskSnapshotDto>, activeFlightIds: Array<string>, pausedAtMilestone: Array<[string, string]>, };
