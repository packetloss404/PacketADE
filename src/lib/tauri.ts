import { invoke } from "@tauri-apps/api/core";
import type { AgentConfig, AgentStatusPatterns } from "@/types/agent";
import type { Flight, Milestone, Task, TaskResult } from "@/types/flight";
import type { StatusLineData, CodexStatusLineData } from "@/types/statusline";

// Filesystem
export async function getCwd(): Promise<string> {
  return invoke<string>("get_cwd");
}

export async function listDirectory(dirPath: string, workspace: string): Promise<{
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  extension: string | null;
}[]> {
  return invoke("list_directory", { dirPath, workspace });
}

// PTY session management
export async function createPtySession(
  projectPath: string,
  cols: number,
  rows: number,
  command: string,
  args: string[] | null
): Promise<string> {
  return invoke<string>("create_pty_session", { projectPath, cols, rows, command, args });
}

export async function writePty(sessionId: string, data: string): Promise<void> {
  return invoke("write_pty", { sessionId, data });
}

export async function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_pty", { sessionId, cols, rows });
}

export async function killPty(sessionId: string): Promise<void> {
  return invoke("kill_pty", { sessionId });
}

// Code quality
export async function analyzeCodeQuality(projectPath: string): Promise<unknown> {
  return invoke("analyze_code_quality", { projectPath });
}

// Memory
export async function scanCodebaseMemory(projectPath: string): Promise<string> {
  return invoke<string>("scan_codebase_memory", { projectPath });
}

export async function summarizeSession(projectPath: string, sessionLog: string): Promise<string> {
  return invoke<string>("summarize_session", { projectPath, sessionLog });
}

export async function extractPatterns(projectPath: string, summaries: string): Promise<string> {
  return invoke<string>("extract_patterns", { projectPath, summaries });
}

// Git
export async function getGitBranch(projectPath: string): Promise<string> {
  return invoke<string>("get_git_branch", { projectPath });
}

export async function getGitStatus(projectPath: string): Promise<string> {
  return invoke<string>("get_git_status", { projectPath });
}

export async function gitCommit(
  projectPath: string,
  message: string,
  stageAll: boolean
): Promise<string> {
  return invoke<string>("git_commit", { projectPath, message, stageAll });
}

export async function gitPush(projectPath: string): Promise<string> {
  return invoke<string>("git_push", { projectPath });
}

export async function gitPull(projectPath: string): Promise<string> {
  return invoke<string>("git_pull", { projectPath });
}

export async function gitCreateBranch(
  projectPath: string,
  branchName: string,
  checkout: boolean
): Promise<string> {
  return invoke<string>("git_create_branch", { projectPath, branchName, checkout });
}

export async function readStatusLineStates(): Promise<StatusLineData[]> {
  return invoke<StatusLineData[]>("read_statusline_states");
}

export async function readCodexStatusLineStates(): Promise<CodexStatusLineData[]> {
  return invoke<CodexStatusLineData[]>("read_codex_statusline_states");
}

// PTY session management (extended)
export async function killPtyAndWait(sessionId: string, timeoutMs: number = 5000): Promise<boolean> {
  return invoke<boolean>("kill_pty_and_wait", { sessionId, timeoutMs });
}

export async function listPtySessions(): Promise<
  { id: string; project_path: string; pid: number | null; alive: boolean }[]
> {
  return invoke("list_pty_sessions");
}

export async function readPtyTranscript(
  sessionId: string,
): Promise<{ session_id: string; data: string; truncated: boolean }> {
  return invoke("read_pty_transcript", { sessionId });
}

// Git safety check
export type GitSafetyReport = {
  isGitRepo: boolean;
  branch: string | null;
  hasUpstream: boolean;
  isClean: boolean;
  uncommittedCount: number;
  behindUpstream: number;
  warnings: string[];
};

export async function gitSafetyCheck(projectPath: string): Promise<GitSafetyReport> {
  const payload = await invoke<{
    is_git_repo: boolean;
    branch: string | null;
    has_upstream: boolean;
    is_clean: boolean;
    uncommitted_count: number;
    behind_upstream: number;
    warnings: string[];
  }>("git_safety_check", { projectPath });
  return {
    isGitRepo: payload.is_git_repo,
    branch: payload.branch,
    hasUpstream: payload.has_upstream,
    isClean: payload.is_clean,
    uncommittedCount: payload.uncommitted_count,
    behindUpstream: payload.behind_upstream,
    warnings: payload.warnings,
  };
}

// Agent detection
export async function detectAgent(command: string): Promise<boolean> {
  return invoke<boolean>("detect_agent", { command });
}

// === Rust <-> TypeScript type conversion layer ===

type PersistedStatePayload = {
  version: number;
  flights: RustFlight[];
  agents: RustAgentConfig[];
  settings: {
    max_parallel_sessions: number;
    milestone_gating: boolean;
    project_path: string;
  };
  ui: {
    selected_flight_id?: string | null;
    selected_view?: string | null;
    theme?: "dark" | "light" | null;
  };
};

type RustFlight = {
  id: string;
  title: string;
  objective: string;
  status: Flight["status"];
  priority: Flight["priority"];
  project_path: string;
  git_branch?: string | null;
  milestones: RustMilestone[];
  linked_session_ids: string[];
  created_at: number;
  updated_at: number;
  completed_at?: number | null;
  total_cost: number;
  total_tokens: number;
};

type RustMilestone = {
  id: string;
  flight_id: string;
  title: string;
  description: string;
  order: number;
  status: Milestone["status"];
  tasks: RustTask[];
  validation_criteria: string[];
};

type RustTask = {
  id: string;
  milestone_id: string;
  flight_id: string;
  title: string;
  description: string;
  order: number;
  status: Task["status"];
  task_type: Task["type"];
  agent_config_id: string;
  agent_args?: string[] | null;
  model?: string | null;
  depends_on: string[];
  session_id?: string | null;
  result?: RustTaskResult | null;
  created_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  cost: number;
  tokens: number;
};

type RustTaskResult = {
  exit_code: number | null;
  summary: string;
  files_changed: string[];
  errors: string[];
  duration_ms: number;
  handoff?: RustTaskHandoff | null;
  validation?: RustTaskValidationReport | null;
};

type RustTaskHandoff = {
  summary: string;
  files_changed: string[];
  tests_needed: string[];
  follow_ups: string[];
};

type RustTaskValidationAssertion = {
  label: string;
  status: "pass" | "fail" | "warn";
  details?: string | null;
};

type RustTaskValidationReport = {
  verdict: "pass" | "fail" | "warn";
  summary: string;
  assertions: RustTaskValidationAssertion[];
};

type RustAgentConfig = {
  id: string;
  name: string;
  command: string;
  default_args: string[];
  description: string;
  installed: boolean;
  capabilities: AgentConfig["capabilities"];
  icon: string;
  color: string;
  status_patterns: {
    approval: string[];
    thinking: string[];
    tool_use: { pattern: string; tool: string; file_group?: number | null }[];
    idle: string[];
  };
  is_builtin: boolean;
  approval_actions: {
    approve: string;
    deny: string;
    abort: string;
  };
};

export type PersistedState = {
  version: number;
  flights: Flight[];
  agents: AgentConfig[];
  settings: {
    maxParallelSessions: number;
    milestoneGating: boolean;
    projectPath: string;
  };
  ui: {
    selectedFlightId?: string | null;
    selectedView?: string | null;
    theme?: "dark" | "light" | null;
  };
};

export type OrchestrationSpawnRequest = {
  flightId: string;
  milestoneId: string;
  taskId: string;
  agentConfigId: string;
  command: string;
  args: string[];
  prompt: string;
  projectPath: string;
};

// === Persisted state ===

export async function loadPersistedState(): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("load_persisted_state");
  return fromRustPersistedState(payload);
}

export async function savePersistedState(state: PersistedState): Promise<void> {
  return invoke("save_persisted_state", { state: toRustPersistedState(state) });
}

export async function saveFlightsSlice(flights: Flight[]): Promise<void> {
  return invoke("save_flights_slice", { flights: flights.map(toRustFlight) });
}

export async function saveAgentsSlice(agents: AgentConfig[]): Promise<void> {
  return invoke("save_agents_slice", { agents: agents.map(toRustAgent) });
}

export async function saveSettingsSlice(settings: PersistedState["settings"]): Promise<void> {
  return invoke("save_settings_slice", {
    settings: {
      max_parallel_sessions: settings.maxParallelSessions,
      milestone_gating: settings.milestoneGating,
      project_path: settings.projectPath,
    },
  });
}

export async function saveUiSlice(ui: PersistedState["ui"]): Promise<void> {
  return invoke("save_ui_slice", {
    ui: {
      selected_flight_id: ui.selectedFlightId ?? null,
      selected_view: ui.selectedView ?? null,
      theme: ui.theme ?? null,
    },
  });
}

// === Flight orchestration ===

export async function launchFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("launch_flight", { flightId });
  return fromRustPersistedState(payload);
}

export async function pauseFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("pause_flight", { flightId });
  return fromRustPersistedState(payload);
}

export async function resumeFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("resume_flight", { flightId });
  return fromRustPersistedState(payload);
}

export async function cancelFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("cancel_flight", { flightId });
  return fromRustPersistedState(payload);
}

export async function orchestrationTick(): Promise<OrchestrationSpawnRequest[]> {
  const payload = await invoke<
    Array<{
      flight_id: string;
      milestone_id: string;
      task_id: string;
      agent_config_id: string;
      command: string;
      args: string[];
      prompt: string;
      project_path: string;
    }>
  >("orchestration_tick");

  return payload.map((entry) => ({
    flightId: entry.flight_id,
    milestoneId: entry.milestone_id,
    taskId: entry.task_id,
    agentConfigId: entry.agent_config_id,
    command: entry.command,
    args: entry.args,
    prompt: entry.prompt,
    projectPath: entry.project_path,
  }));
}

export type OrchestratorSnapshot = {
  runningTaskIds: string[];
  activeFlightIds: string[];
  pausedAtMilestone: [string, string][];
};

export async function getOrchestrationState(): Promise<OrchestratorSnapshot> {
  const payload = await invoke<{
    running_task_ids: string[];
    active_flight_ids: string[];
    paused_at_milestone: [string, string][];
  }>("get_orchestration_state");
  return {
    runningTaskIds: payload.running_task_ids,
    activeFlightIds: payload.active_flight_ids,
    pausedAtMilestone: payload.paused_at_milestone,
  };
}

export async function recordTaskSpawn(params: {
  sessionId: string;
  flightId: string;
  milestoneId: string;
  taskId: string;
  agentConfigId: string;
  command: string;
  args: string[];
  prompt: string;
  projectPath: string;
}): Promise<void> {
  return invoke("record_task_spawn", {
    sessionId: params.sessionId,
    flightId: params.flightId,
    milestoneId: params.milestoneId,
    taskId: params.taskId,
    agentConfigId: params.agentConfigId,
    command: params.command,
    args: params.args,
    prompt: params.prompt,
    projectPath: params.projectPath,
  });
}

export async function notifyApprovalNeeded(taskId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("notify_approval_needed", { taskId });
  return fromRustPersistedState(payload);
}

export async function notifyApprovalResolved(taskId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("notify_approval_resolved", { taskId });
  return fromRustPersistedState(payload);
}

export async function notifyTaskComplete(taskId: string, success: boolean): Promise<PersistedState> {
  const payload = await invoke<PersistedStatePayload>("notify_task_complete", {
    taskId,
    success,
  });
  return fromRustPersistedState(payload);
}

// === Rust <-> TypeScript conversion functions ===

function fromRustPersistedState(payload: PersistedStatePayload): PersistedState {
  return {
    version: payload.version,
    flights: payload.flights.map(fromRustFlight),
    agents: payload.agents.map(fromRustAgent),
    settings: {
      maxParallelSessions: payload.settings.max_parallel_sessions,
      milestoneGating: payload.settings.milestone_gating,
      projectPath: payload.settings.project_path,
    },
    ui: {
      selectedFlightId: payload.ui.selected_flight_id ?? null,
      selectedView: payload.ui.selected_view ?? null,
      theme: payload.ui.theme ?? null,
    },
  };
}

function toRustPersistedState(state: PersistedState): PersistedStatePayload {
  return {
    version: state.version,
    flights: state.flights.map(toRustFlight),
    agents: state.agents.map(toRustAgent),
    settings: {
      max_parallel_sessions: state.settings.maxParallelSessions,
      milestone_gating: state.settings.milestoneGating,
      project_path: state.settings.projectPath,
    },
    ui: {
      selected_flight_id: state.ui.selectedFlightId ?? null,
      selected_view: state.ui.selectedView ?? null,
      theme: state.ui.theme ?? null,
    },
  };
}

function fromRustFlight(flight: RustFlight): Flight {
  return {
    id: flight.id,
    title: flight.title,
    objective: flight.objective,
    status: flight.status,
    priority: flight.priority,
    projectPath: flight.project_path,
    gitBranch: flight.git_branch ?? undefined,
    milestones: flight.milestones.map(fromRustMilestone),
    linkedSessionIds: flight.linked_session_ids,
    issueIds: [],
    createdAt: flight.created_at,
    updatedAt: flight.updated_at,
    completedAt: flight.completed_at ?? undefined,
    totalCost: flight.total_cost,
    totalTokens: flight.total_tokens,
  };
}

function toRustFlight(flight: Flight): RustFlight {
  return {
    id: flight.id,
    title: flight.title,
    objective: flight.objective,
    status: flight.status,
    priority: flight.priority,
    project_path: flight.projectPath,
    git_branch: flight.gitBranch ?? null,
    milestones: flight.milestones.map(toRustMilestone),
    linked_session_ids: flight.linkedSessionIds,
    created_at: flight.createdAt,
    updated_at: flight.updatedAt,
    completed_at: flight.completedAt ?? null,
    total_cost: flight.totalCost,
    total_tokens: flight.totalTokens,
  };
}

function fromRustMilestone(milestone: RustMilestone): Milestone {
  return {
    id: milestone.id,
    flightId: milestone.flight_id,
    title: milestone.title,
    description: milestone.description,
    order: milestone.order,
    status: milestone.status,
    tasks: milestone.tasks.map(fromRustTask),
    validationCriteria: milestone.validation_criteria,
  };
}

function toRustMilestone(milestone: Milestone): RustMilestone {
  return {
    id: milestone.id,
    flight_id: milestone.flightId,
    title: milestone.title,
    description: milestone.description,
    order: milestone.order,
    status: milestone.status,
    tasks: milestone.tasks.map(toRustTask),
    validation_criteria: milestone.validationCriteria,
  };
}

function fromRustTask(task: RustTask): Task {
  return {
    id: task.id,
    milestoneId: task.milestone_id,
    flightId: task.flight_id,
    title: task.title,
    description: task.description,
    order: task.order,
    status: task.status,
    type: task.task_type,
    agentConfigId: task.agent_config_id,
    agentArgs: task.agent_args ?? undefined,
    model: task.model ?? undefined,
    dependsOn: task.depends_on,
    sessionId: task.session_id ?? null,
    result: task.result ? fromRustTaskResult(task.result) : undefined,
    createdAt: task.created_at,
    startedAt: task.started_at ?? undefined,
    completedAt: task.completed_at ?? undefined,
    cost: task.cost,
    tokens: task.tokens,
  };
}

function toRustTask(task: Task): RustTask {
  return {
    id: task.id,
    milestone_id: task.milestoneId,
    flight_id: task.flightId,
    title: task.title,
    description: task.description,
    order: task.order,
    status: task.status,
    task_type: task.type,
    agent_config_id: task.agentConfigId,
    agent_args: task.agentArgs ?? null,
    model: task.model ?? null,
    depends_on: task.dependsOn,
    session_id: task.sessionId,
    result: task.result ? toRustTaskResult(task.result) : null,
    created_at: task.createdAt,
    started_at: task.startedAt ?? null,
    completed_at: task.completedAt ?? null,
    cost: task.cost,
    tokens: task.tokens,
  };
}

function fromRustTaskResult(result: RustTaskResult): TaskResult {
  return {
    exitCode: result.exit_code,
    summary: result.summary,
    filesChanged: result.files_changed,
    errors: result.errors,
    duration: result.duration_ms,
    handoff: result.handoff
      ? {
          summary: result.handoff.summary,
          filesChanged: result.handoff.files_changed,
          testsNeeded: result.handoff.tests_needed,
          followUps: result.handoff.follow_ups,
        }
      : undefined,
    validation: result.validation
      ? {
          verdict: result.validation.verdict,
          summary: result.validation.summary,
          assertions: result.validation.assertions.map((assertion) => ({
            label: assertion.label,
            status: assertion.status,
            details: assertion.details ?? undefined,
          })),
        }
      : undefined,
  };
}

function toRustTaskResult(result: TaskResult): RustTaskResult {
  return {
    exit_code: result.exitCode,
    summary: result.summary,
    files_changed: result.filesChanged,
    errors: result.errors,
    duration_ms: result.duration,
    handoff: result.handoff
      ? {
          summary: result.handoff.summary,
          files_changed: result.handoff.filesChanged,
          tests_needed: result.handoff.testsNeeded,
          follow_ups: result.handoff.followUps,
        }
      : null,
    validation: result.validation
      ? {
          verdict: result.validation.verdict,
          summary: result.validation.summary,
          assertions: result.validation.assertions.map((assertion) => ({
            label: assertion.label,
            status: assertion.status,
            details: assertion.details ?? null,
          })),
        }
      : null,
  };
}

function fromRustAgent(agent: RustAgentConfig): AgentConfig {
  const statusPatterns: AgentStatusPatterns = {
    approval: agent.status_patterns.approval,
    thinking: agent.status_patterns.thinking,
    toolUse: agent.status_patterns.tool_use.map((tool) => ({
      pattern: tool.pattern,
      tool: tool.tool,
      fileGroup: tool.file_group ?? undefined,
    })),
    idle: agent.status_patterns.idle,
  };

  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgs: agent.default_args,
    description: agent.description,
    installed: agent.installed,
    capabilities: agent.capabilities,
    icon: agent.icon,
    color: agent.color,
    statusPatterns,
    approvalActions: {
      approve: agent.approval_actions.approve,
      deny: agent.approval_actions.deny,
      abort: agent.approval_actions.abort,
    },
    isBuiltin: agent.is_builtin,
  };
}

function toRustAgent(agent: AgentConfig): RustAgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    default_args: agent.defaultArgs,
    description: agent.description,
    installed: agent.installed,
    capabilities: agent.capabilities,
    icon: agent.icon,
    color: agent.color,
    status_patterns: {
      approval: agent.statusPatterns.approval,
      thinking: agent.statusPatterns.thinking,
      tool_use: agent.statusPatterns.toolUse.map((tool) => ({
        pattern: tool.pattern,
        tool: tool.tool,
        file_group: tool.fileGroup ?? null,
      })),
      idle: agent.statusPatterns.idle,
    },
    approval_actions: {
      approve: agent.approvalActions?.approve ?? "y\n",
      deny: agent.approvalActions?.deny ?? "n\n",
      abort: agent.approvalActions?.abort ?? "\u0003",
    },
    is_builtin: agent.isBuiltin,
  };
}

export async function parseSpecToTickets(specText: string): Promise<string> {
  return invoke<string>("parse_spec_to_tickets", { specText });
}

export async function askInsights(
  projectPath: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  return invoke<string>("ask_insights", { projectPath, messages });
}

export async function askInsightsStream(
  projectPath: string,
  messages: { role: string; content: string }[],
  sessionContext?: string
): Promise<void> {
  return invoke("ask_insights_stream", {
    projectPath,
    messages,
    sessionContext: sessionContext || null,
  });
}

export async function generateIdeas(
  projectPath: string,
  ideaTypes: string[]
): Promise<string> {
  return invoke<string>("generate_ideas", { projectPath, ideaTypes });
}

// GitHub integration
export async function githubSetToken(token: string): Promise<void> {
  return invoke("github_set_token", { token });
}

export async function githubClearToken(): Promise<void> {
  return invoke("github_clear_token");
}

export async function githubHasToken(): Promise<boolean> {
  return invoke<boolean>("github_has_token");
}

export async function githubListRepos(): Promise<string> {
  return invoke<string>("github_list_repos");
}

export async function githubListIssues(
  owner: string,
  repo: string
): Promise<string> {
  return invoke<string>("github_list_issues", { owner, repo });
}

export async function githubCreatePr(
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<string> {
  return invoke<string>("github_create_pr", { owner, repo, title, body, head, base });
}

export async function githubListPrs(
  owner: string,
  repo: string
): Promise<string> {
  return invoke<string>("github_list_prs", { owner, repo });
}

export async function githubGetPrDiff(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  return invoke<string>("github_get_pr_diff", { owner, repo, prNumber });
}

export async function githubInvestigateIssue(
  projectPath: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string> {
  return invoke<string>("github_investigate_issue", {
    projectPath,
    owner,
    repo,
    issueNumber,
  });
}

// Prompt history
export async function readPromptHistory(): Promise<string> {
  return invoke<string>("read_prompt_history");
}

// Usage analytics
export async function readUsageAnalytics(): Promise<string> {
  return invoke<string>("read_usage_analytics");
}

// MCP server management
import type { McpServerEntry } from "@/types/mcp";
import type { ScaffoldResult, ToolAvailability } from "@/types/scaffold";

export async function readMcpServers(projectPath: string): Promise<McpServerEntry[]> {
  return invoke<McpServerEntry[]>("read_mcp_servers", { projectPath });
}

export async function writeMcpServer(
  projectPath: string,
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  scope: string
): Promise<void> {
  return invoke("write_mcp_server", { projectPath, name, command, args, env, scope });
}

export async function deleteMcpServer(
  projectPath: string,
  name: string,
  scope: string
): Promise<void> {
  return invoke("delete_mcp_server", { projectPath, name, scope });
}

// Project scaffolding
export async function scaffoldProject(
  parentDir: string,
  projectName: string,
  template: string
): Promise<ScaffoldResult> {
  return invoke<ScaffoldResult>("scaffold_project", { parentDir, projectName, template });
}

export async function checkScaffoldTools(): Promise<ToolAvailability> {
  return invoke<ToolAvailability>("check_scaffold_tools");
}

// Deploy pipeline
import type { DeployConfig } from "@/types/deploy";

interface DeployConfigFile {
  configs: DeployConfig[];
  source: string;
}

export async function readDeployConfig(projectPath: string): Promise<DeployConfigFile> {
  return invoke<DeployConfigFile>("read_deploy_config", { projectPath });
}

export async function createDeployConfig(
  projectPath: string,
  configs: DeployConfig[]
): Promise<void> {
  return invoke("create_deploy_config", { projectPath, configs });
}

