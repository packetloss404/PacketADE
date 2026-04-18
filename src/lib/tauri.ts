import { invoke } from "@tauri-apps/api/core";
import type {
  AgentConfigDto,
  OrchestratorSnapshotDto,
  PersistedStateDto,
  PersistedUiStateDto,
  TaskSpawnRequestDto,
  WorkspaceDto,
} from "@/generated/tauri-schema";
import type { AgentConfig } from "@/types/agent";
import type { Flight, Milestone, ReviewType, Task, TaskResult } from "@/types/flight";
import type { StatusLineData, CodexStatusLineData, GeminiStatusLineData, OpenCodeStatusLineData } from "@/types/statusline";
import type { Workspace } from "@/types/workspace";
import type { MemoryEvent, LearnedPattern } from "@/types/memory";
import type { ServerConfig } from "@/types/server";

// Filesystem
export async function getCwd(): Promise<string> {
  return invoke<string>("get_cwd");
}

export async function listSubdirectories(dirPath: string): Promise<string[]> {
  return invoke<string[]>("list_subdirectories", { dirPath });
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

export async function readFileContents(filePath: string, workspace: string): Promise<string> {
  return invoke<string>("read_file_contents", { filePath, workspace });
}

export async function writeFileContents(filePath: string, workspace: string, content: string): Promise<void> {
  return invoke("write_file_contents", { filePath, workspace, content });
}

// PTY session management
export async function createPtySession(
  projectPath: string,
  cols: number,
  rows: number,
  command: string,
  args: string[] | null,
  env?: Record<string, string> | null,
): Promise<string> {
  return invoke<string>("create_pty_session", { projectPath, cols, rows, command, args, env: env ?? null });
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
export interface CrashEntry {
  timestamp: string;
  path: string;
  summary: string;
}

export async function listCrashes(): Promise<CrashEntry[]> {
  return invoke<CrashEntry[]>("list_crashes");
}

export async function readCrash(path: string): Promise<string> {
  return invoke<string>("read_crash", { path });
}

export async function deleteCrash(path: string): Promise<void> {
  await invoke("delete_crash", { path });
}

export async function analyzeCodeQuality(projectPath: string): Promise<CodeQualityReport> {
  return invoke<CodeQualityReport>("analyze_code_quality", { projectPath });
}

export interface CodeQualityReport {
  total_files: number;
  total_code_lines: number;
  total_lines: number;
  total_comment_lines: number;
  total_blank_lines: number;
  language_count: number;
  languages: { name: string; extension: string; files: number; code_lines: number; comment_lines: number; blank_lines: number; total_lines: number }[];
  avg_complexity: number;
  test_files: number;
  test_lines: number;
  top_complex_files: { path: string; language: string; lines: number; complexity: number }[];
  comment_ratio: number;
  test_ratio: number;
  org_score: number;
}

// Memory

export async function saveServersSlice(servers: ServerConfig[]): Promise<void> {
  return invoke("save_servers_slice", { servers });
}

export async function saveMemorySlice(memoryEvents: MemoryEvent[], memoryPatterns?: LearnedPattern[]): Promise<void> {
  return invoke("save_memory_slice", { memoryEvents, memoryPatterns: memoryPatterns ?? [] });
}

export async function summarizeSession(projectPath: string, sessionLog: string): Promise<string> {
  return invoke<string>("summarize_session", { projectPath, sessionLog });
}

export async function extractPatterns(projectPath: string, summaries: string): Promise<string> {
  return invoke<string>("extract_patterns", { projectPath, summaries });
}

export interface FlightSummaryInput {
  title: string;
  objective: string;
  priority: string;
  status: string;
  task_count: number;
  tasks_done: number;
  tasks_failed: number;
  duration_description: string;
}

export async function summarizeFlight(
  projectPath: string,
  flightSummary: FlightSummaryInput,
  sessionLogs: string
): Promise<string> {
  return invoke<string>("summarize_flight", { projectPath, flightSummary, sessionLogs });
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

export async function readGeminiStatusLineStates(): Promise<GeminiStatusLineData[]> {
  return invoke<GeminiStatusLineData[]>("read_gemini_statusline_states");
}

export async function readOpenCodeStatusLineStates(): Promise<OpenCodeStatusLineData[]> {
  return invoke<OpenCodeStatusLineData[]>("read_opencode_statusline_states");
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

// SSH helpers
export async function sshExec(commandArgs: string[], password?: string | null): Promise<string> {
  return invoke<string>("ssh_exec", { commandArgs, password: password ?? null });
}

export async function sshTestConnection(args: {
  host: string;
  port: number;
  user: string;
  keyPath?: string | null;
  password?: string | null;
}): Promise<void> {
  return invoke("ssh_test_connection", {
    host: args.host,
    port: args.port,
    user: args.user,
    keyPath: args.keyPath ?? null,
    password: args.password ?? null,
  });
}

export async function setSshPassword(targetId: string, password: string): Promise<void> {
  return invoke("set_ssh_password", { targetId, password });
}

export async function deleteSshPassword(targetId: string): Promise<void> {
  return invoke("delete_ssh_password", { targetId });
}

export async function getSshPasswordExists(targetId: string): Promise<boolean> {
  return invoke<boolean>("get_ssh_password_exists", { targetId });
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

type PersistedSettings = {
  maxParallelSessions: number;
  milestoneGating: boolean;
  projectPath: string;
};

type PersistedUi = {
  selectedFlightId?: string | null;
  selectedView?: string | null;
  theme?: "dark" | "light" | null;
};

export type PersistedState = {
  version: number;
  flights: Flight[];
  agents: AgentConfig[];
  settings: PersistedSettings;
  ui: PersistedUi;
  workspaces: Workspace[];
  memoryEvents: MemoryEvent[];
  memoryPatterns: LearnedPattern[];
  servers: ServerConfig[];
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

export type RunningTaskSnapshot = {
  taskId: string;
  milestoneId: string;
  flightId: string;
  sessionId: string;
  agentConfigId: string;
  startedAt: number;
};

export type OrchestratorSnapshot = {
  runningTaskIds: string[];
  runningTasks: RunningTaskSnapshot[];
  activeFlightIds: string[];
  pausedAtMilestone: [string, string][];
};

function normalizeOptionalRecord(
  record?: { [key: string]: string | null | undefined },
): Record<string, string | null> | undefined {
  if (!record) return undefined;
  const normalized: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function toOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function fromDtoAgent(agent: AgentConfigDto): AgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgs: agent.defaultArgs,
    description: agent.description,
    installed: agent.installed,
    capabilities: agent.capabilities,
    icon: agent.icon,
    color: agent.color,
    statusPatterns: {
      approval: agent.statusPatterns.approval,
      thinking: agent.statusPatterns.thinking,
      toolUse: agent.statusPatterns.toolUse.map((tool) => ({
        pattern: tool.pattern,
        tool: tool.tool,
        fileGroup: tool.fileGroup,
      })),
      idle: agent.statusPatterns.idle,
    },
    approvalActions: agent.approvalActions,
    isBuiltin: agent.isBuiltin,
  };
}

function toDtoAgent(agent: AgentConfig): AgentConfigDto {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgs: agent.defaultArgs,
    description: agent.description,
    installed: agent.installed,
    capabilities: agent.capabilities,
    icon: agent.icon,
    color: agent.color,
    statusPatterns: {
      approval: agent.statusPatterns.approval,
      thinking: agent.statusPatterns.thinking,
      toolUse: agent.statusPatterns.toolUse.map((tool) => ({
        pattern: tool.pattern,
        tool: tool.tool,
        fileGroup: tool.fileGroup,
      })),
      idle: agent.statusPatterns.idle,
    },
    approvalActions: agent.approvalActions ?? { approve: "y\n", deny: "n\n", abort: "\u0003" },
    isBuiltin: agent.isBuiltin,
  };
}

function fromDtoTaskResult(result: NonNullable<PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number]["result"]>): TaskResult {
  return {
    exitCode: result.exitCode,
    summary: result.summary,
    filesChanged: result.filesChanged,
    errors: result.errors,
    duration: result.duration,
    handoff: result.handoff
      ? {
          summary: result.handoff.summary,
          filesChanged: result.handoff.filesChanged,
          testsNeeded: result.handoff.testsNeeded,
          followUps: result.handoff.followUps,
        }
      : undefined,
    validation: result.validation
      ? {
          verdict: result.validation.verdict,
          summary: result.validation.summary,
          assertions: result.validation.assertions.map((assertion): NonNullable<TaskResult["validation"]>["assertions"][number] => ({
            label: assertion.label,
            status: assertion.status,
            details: assertion.details,
          })),
        }
      : undefined,
  };
}

function toDtoTaskResult(result: TaskResult): NonNullable<PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number]["result"]> {
  return {
    exitCode: result.exitCode,
    summary: result.summary,
    filesChanged: result.filesChanged,
    errors: result.errors,
    duration: result.duration,
    handoff: result.handoff
      ? {
          summary: result.handoff.summary,
          filesChanged: result.handoff.filesChanged,
          testsNeeded: result.handoff.testsNeeded,
          followUps: result.handoff.followUps,
        }
      : undefined,
    validation: result.validation
      ? {
          verdict: result.validation.verdict,
          summary: result.validation.summary,
          assertions: result.validation.assertions.map((assertion) => ({
            label: assertion.label,
            status: assertion.status,
            details: assertion.details,
          })),
        }
      : undefined,
  };
}

function fromDtoTask(task: PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number]): Task {
  return {
    id: task.id,
    milestoneId: task.milestoneId,
    flightId: task.flightId,
    title: task.title,
    description: task.description,
    order: task.order,
    status: task.status,
    type: task.type,
    agentConfigId: task.agentConfigId,
    agentArgs: task.agentArgs,
    model: task.model,
    dependsOn: task.dependsOn,
    sessionId: task.sessionId,
    result: task.result ? fromDtoTaskResult(task.result) : undefined,
    reviewPacket: task.reviewPacket
      ? {
          id: task.reviewPacket.id,
          taskId: task.reviewPacket.taskId,
          flightId: task.reviewPacket.flightId,
          milestoneId: task.reviewPacket.milestoneId,
          requestedAt: task.reviewPacket.requestedAt,
          reviewType: task.reviewPacket.reviewType as ReviewType,
          summary: task.reviewPacket.summary,
          diff: task.reviewPacket.diff,
          command: task.reviewPacket.command,
          filePaths: task.reviewPacket.filePaths,
          agentId: task.reviewPacket.agentId,
          sessionId: task.reviewPacket.sessionId,
        }
      : undefined,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cost: task.cost,
    tokens: task.tokens,
  };
}

function toDtoTask(task: Task): PersistedStateDto["flights"][number]["milestones"][number]["tasks"][number] {
  return {
    id: task.id,
    milestoneId: task.milestoneId,
    flightId: task.flightId,
    title: task.title,
    description: task.description,
    order: task.order,
    status: task.status,
    type: task.type,
    agentConfigId: task.agentConfigId,
    agentArgs: task.agentArgs,
    model: task.model,
    dependsOn: task.dependsOn,
    sessionId: task.sessionId,
    result: task.result ? toDtoTaskResult(task.result) : undefined,
    reviewPacket: task.reviewPacket
      ? {
          id: task.reviewPacket.id,
          taskId: task.reviewPacket.taskId,
          flightId: task.reviewPacket.flightId,
          milestoneId: task.reviewPacket.milestoneId,
          requestedAt: task.reviewPacket.requestedAt,
          reviewType: task.reviewPacket.reviewType,
          summary: task.reviewPacket.summary,
          diff: task.reviewPacket.diff,
          command: task.reviewPacket.command,
          filePaths: task.reviewPacket.filePaths,
          agentId: task.reviewPacket.agentId,
          sessionId: task.reviewPacket.sessionId,
        }
      : undefined,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cost: task.cost,
    tokens: task.tokens,
  };
}

function fromDtoFlight(flight: PersistedStateDto["flights"][number]): Flight {
  return {
    id: flight.id,
    title: flight.title,
    objective: flight.objective,
    status: flight.status,
    priority: flight.priority,
    projectPath: flight.projectPath,
    workspaceId: flight.workspaceId ?? null,
    gitBranch: flight.gitBranch,
    milestones: flight.milestones.map((milestone): Milestone => ({
      id: milestone.id,
      flightId: milestone.flightId,
      title: milestone.title,
      description: milestone.description,
      order: milestone.order,
      status: milestone.status,
      tasks: milestone.tasks.map(fromDtoTask),
      validationCriteria: milestone.validationCriteria,
    })),
    linkedSessionIds: flight.linkedSessionIds,
    issueIds: flight.issueIds ?? [],
    createdAt: flight.createdAt,
    updatedAt: flight.updatedAt,
    completedAt: flight.completedAt,
    totalCost: flight.totalCost,
    totalTokens: flight.totalTokens,
  };
}

function toDtoFlight(flight: Flight): PersistedStateDto["flights"][number] {
  return {
    id: flight.id,
    title: flight.title,
    objective: flight.objective,
    status: flight.status,
    priority: flight.priority,
    projectPath: flight.projectPath,
    gitBranch: flight.gitBranch,
    milestones: flight.milestones.map((milestone) => ({
      id: milestone.id,
      flightId: milestone.flightId,
      title: milestone.title,
      description: milestone.description,
      order: milestone.order,
      status: milestone.status,
      tasks: milestone.tasks.map(toDtoTask),
      validationCriteria: milestone.validationCriteria,
    })),
    linkedSessionIds: flight.linkedSessionIds,
    issueIds: flight.issueIds,
    createdAt: flight.createdAt,
    updatedAt: flight.updatedAt,
    completedAt: flight.completedAt,
    totalCost: flight.totalCost,
    totalTokens: flight.totalTokens,
  };
}

function fromDtoWorkspace(workspace: WorkspaceDto): Workspace {
  return {
    id: workspace.id,
    name: workspace.name,
    agents: workspace.agents,
    panes: workspace.panes.map((pane) => ({
      id: pane.id,
      agentId: pane.agentId,
      sessionId: pane.sessionId,
      gridPosition: pane.gridPosition,
    })),
    projectPath: workspace.projectPath,
    prompt: workspace.prompt,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    status: workspace.status,
    bypassPermissions: workspace.bypassPermissions,
    modelOverrides: normalizeOptionalRecord(workspace.modelOverrides),
    effortOverrides: normalizeOptionalRecord(workspace.effortOverrides),
  };
}

function toDtoWorkspace(workspace: Workspace): WorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    agents: workspace.agents,
    panes: workspace.panes.map((pane, index) => ({
      id: pane.id,
      agentId: pane.agentId,
      sessionId: pane.sessionId,
      gridPosition: pane.gridPosition ?? { row: 0, col: index },
    })),
    projectPath: workspace.projectPath,
    prompt: workspace.prompt,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    status: workspace.status,
    bypassPermissions: workspace.bypassPermissions,
    modelOverrides: workspace.modelOverrides,
    effortOverrides: workspace.effortOverrides,
  };
}

function fromDtoPersistedState(state: PersistedStateDto): PersistedState {
  return {
    version: state.version,
    flights: state.flights.map(fromDtoFlight),
    agents: state.agents.map(fromDtoAgent),
    settings: {
      maxParallelSessions: state.settings.maxParallelSessions,
      milestoneGating: state.settings.milestoneGating,
      projectPath: state.settings.projectPath,
    },
    ui: {
      selectedFlightId: state.ui.selectedFlightId ?? null,
      selectedView: state.ui.selectedView ?? null,
      theme: state.ui.theme ?? null,
    },
    workspaces: state.workspaces.map(fromDtoWorkspace),
    memoryEvents: (state.memoryEvents ?? []) as MemoryEvent[],
    memoryPatterns: (state.memoryPatterns ?? []) as LearnedPattern[],
    servers: (state.servers ?? []).map(fromDtoServer),
  };
}

function fromDtoServer(s: PersistedStateDto["servers"][number]): ServerConfig {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    authMethod: s.authMethod as ServerConfig["authMethod"],
    keyPath: s.keyPath ?? undefined,
    remotePath: s.remotePath ?? undefined,
    lastConnectedAt: s.lastConnectedAt != null ? Number(s.lastConnectedAt) : undefined,
    installedAgents: s.installedAgents,
  };
}

function toDtoServer(s: ServerConfig): PersistedStateDto["servers"][number] {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    authMethod: s.authMethod,
    keyPath: s.keyPath ?? null,
    remotePath: s.remotePath ?? null,
    lastConnectedAt: s.lastConnectedAt != null ? BigInt(s.lastConnectedAt) : null,
    installedAgents: s.installedAgents,
  };
}

function toDtoPersistedState(state: PersistedState): PersistedStateDto {
  return {
    version: state.version,
    flights: state.flights.map(toDtoFlight),
    agents: state.agents.map(toDtoAgent),
    settings: {
      maxParallelSessions: state.settings.maxParallelSessions,
      milestoneGating: state.settings.milestoneGating,
      projectPath: state.settings.projectPath,
    },
    ui: {
      selectedFlightId: toOptional(state.ui.selectedFlightId),
      selectedView: toOptional(state.ui.selectedView),
      theme: toOptional(state.ui.theme),
    },
    workspaces: state.workspaces.map(toDtoWorkspace),
    memoryEvents: state.memoryEvents,
    memoryPatterns: state.memoryPatterns,
    servers: state.servers.map(toDtoServer),
  };
}

// === Persisted state ===

export async function loadPersistedState(): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("load_persisted_state");
  return fromDtoPersistedState(payload);
}

export async function savePersistedState(state: PersistedState): Promise<void> {
  return invoke("save_persisted_state", { state: toDtoPersistedState(state) });
}

export async function saveFlightsSlice(flights: Flight[]): Promise<void> {
  return invoke("save_flights_slice", { flights: flights.map(toDtoFlight) });
}

export async function saveAgentsSlice(agents: AgentConfig[]): Promise<void> {
  return invoke("save_agents_slice", { agents: agents.map(toDtoAgent) });
}

export async function saveWorkspacesSlice(workspaces: Workspace[]): Promise<void> {
  return invoke("save_workspaces_slice", { workspaces: workspaces.map(toDtoWorkspace) });
}

export async function saveSettingsSlice(settings: PersistedState["settings"]): Promise<void> {
  return invoke("save_settings_slice", { settings });
}

export async function saveUiSlice(ui: PersistedState["ui"]): Promise<void> {
  const payload: PersistedUiStateDto = {
    selectedFlightId: toOptional(ui.selectedFlightId),
    selectedView: toOptional(ui.selectedView),
    theme: toOptional(ui.theme),
  };
  return invoke("save_ui_slice", { ui: payload });
}

// === Flight orchestration ===

export async function launchFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("launch_flight", { flightId });
  return fromDtoPersistedState(payload);
}

export async function pauseFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("pause_flight", { flightId });
  return fromDtoPersistedState(payload);
}

export async function resumeFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("resume_flight", { flightId });
  return fromDtoPersistedState(payload);
}

export async function cancelFlightInBackend(flightId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("cancel_flight", { flightId });
  return fromDtoPersistedState(payload);
}

export async function orchestrationTick(): Promise<OrchestrationSpawnRequest[]> {
  const payload = await invoke<TaskSpawnRequestDto[]>("orchestration_tick");
  return payload.map((request) => ({
    flightId: request.flightId,
    milestoneId: request.milestoneId,
    taskId: request.taskId,
    agentConfigId: request.agentConfigId,
    command: request.command,
    args: request.args,
    prompt: request.prompt,
    projectPath: request.projectPath,
  }));
}

export async function getOrchestrationState(): Promise<OrchestratorSnapshot> {
  const payload = await invoke<OrchestratorSnapshotDto>("get_orchestration_state");
  return {
    runningTaskIds: payload.runningTaskIds,
    runningTasks: payload.runningTasks.map((task) => ({
      taskId: task.taskId,
      milestoneId: task.milestoneId,
      flightId: task.flightId,
      sessionId: task.sessionId,
      agentConfigId: task.agentConfigId,
      startedAt: task.startedAt,
    })),
    activeFlightIds: payload.activeFlightIds,
    pausedAtMilestone: payload.pausedAtMilestone,
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
  const payload = await invoke<PersistedStateDto>("notify_approval_needed", { taskId });
  return fromDtoPersistedState(payload);
}

export async function notifyApprovalResolved(taskId: string): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("notify_approval_resolved", { taskId });
  return fromDtoPersistedState(payload);
}

export async function notifyTaskComplete(taskId: string, success: boolean): Promise<PersistedState> {
  const payload = await invoke<PersistedStateDto>("notify_task_complete", {
    taskId,
    success,
  });
  return fromDtoPersistedState(payload);
}

export async function parseSpecToFlight(specText: string): Promise<string> {
  return invoke<string>("parse_spec_to_flight", { specText });
}

export async function parseSpecToTickets(specText: string): Promise<string> {
  return invoke<string>("parse_spec_to_tickets", { specText });
}

export async function askAgentChatStream(
  projectPath: string,
  messages: { role: string; content: string }[],
  sessionContext?: string,
  requestId?: string,
): Promise<void> {
  return invoke("ask_agent_chat_stream", {
    projectPath,
    messages,
    sessionContext: sessionContext || null,
    requestId: requestId || null,
  });
}

export async function askFlightChatStream(
  projectPath: string,
  messages: { role: string; content: string }[],
  flightState: {
    title: string;
    objective: string;
    priority: string;
    milestones?: Array<{ title: string; tasks: Array<{ title: string; type: string }> }>;
  },
  retrospectives?: string,
  requestId?: string,
): Promise<void> {
  return invoke("ask_flight_chat_stream", {
    projectPath,
    messages,
    flightState,
    retrospectives: retrospectives || null,
    requestId: requestId || null,
  });
}

export async function askInsightsStream(
  projectPath: string,
  messages: { role: string; content: string }[],
  sessionContext: string | null,
  requestId: string,
): Promise<void> {
  return invoke("ask_insights_stream", { projectPath, messages, sessionContext, requestId });
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

// MCP server management
import type { McpServerEntry } from "@/types/mcp";

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

// Deploy pipeline
import type { DeployConfig } from "@/types/deploy";

interface DeployConfigFile {
  configs: DeployConfig[];
  source: string;
}

export async function readDeployConfig(projectPath: string): Promise<DeployConfigFile> {
  return invoke<DeployConfigFile>("read_deploy_config", { projectPath });
}

// Usage analytics
export async function readUsageAnalytics(): Promise<string> {
  return invoke<string>("read_usage_analytics");
}

export async function createDeployConfig(
  projectPath: string,
  configs: DeployConfig[]
): Promise<void> {
  return invoke("create_deploy_config", { projectPath, configs });
}

export async function validateDeploy(projectPath: string, command: string): Promise<string> {
  return invoke<string>("validate_deploy", { projectPath, command });
}

export async function runDeploy(projectPath: string, command: string, runId: string): Promise<string> {
  return invoke<string>("run_deploy", { projectPath, command, runId });
}

// Dictation (VibeToText)
export function listAudioDevices(): Promise<unknown> {
  return invoke("list_audio_devices");
}

export function startRecordingCmd(deviceIndex?: number): Promise<void> {
  return invoke("start_recording", { deviceIndex: deviceIndex ?? null });
}

export function stopRecordingCmd(): Promise<string> {
  return invoke<string>("stop_recording");
}

export function getDictationHistory(limit: number, offset: number): Promise<string> {
  return invoke<string>("get_dictation_history", { limit, offset });
}

export function getDictationAnalytics(): Promise<string> {
  return invoke<string>("get_dictation_analytics");
}

export function searchDictationHistory(query: string): Promise<string> {
  return invoke<string>("search_dictation_history", { query });
}

export function getDictationSettings(): Promise<string> {
  return invoke<string>("get_dictation_settings");
}

export function setDictationSettings(settings: string): Promise<void> {
  return invoke("set_dictation_settings", { settings });
}

export function downloadWhisperModel(size: string): Promise<void> {
  return invoke("download_whisper_model", { size });
}

export function listWhisperModels(): Promise<unknown> {
  return invoke("list_whisper_models");
}

// API Keys
export async function setApiKey(provider: string, key: string): Promise<void> {
  return invoke("set_api_key", { provider, key });
}

export async function getApiKeyExists(provider: string): Promise<boolean> {
  return invoke<boolean>("get_api_key_exists", { provider });
}

export async function deleteApiKey(provider: string): Promise<void> {
  return invoke("delete_api_key", { provider });
}

export interface ImageAttachment {
  media_type: string;
  data_base64: string;
}

export interface SshConfigInput {
  host: string;
  port: number;
  user: string;
  remote_path: string;
  key_path?: string | null;
}

export interface SlashCommandDef {
  name: string;
  description: string;
  body: string;
  source: string;
}

// API Agent Sessions
export async function startApiAgentSession(
  sessionId: string,
  provider: string,
  model: string,
  projectPath: string,
  initialMessage: string,
  systemPromptOverride?: string | null,
  thinkingEnabled?: boolean,
  attachments?: ImageAttachment[],
  planMode?: boolean,
  sshConfig?: SshConfigInput | null,
): Promise<void> {
  return invoke("start_api_agent_session", {
    sessionId,
    provider,
    model,
    projectPath,
    initialMessage,
    systemPromptOverride: systemPromptOverride ?? null,
    thinkingEnabled: thinkingEnabled ?? null,
    attachments: attachments ?? null,
    planMode: planMode ?? null,
    sshConfig: sshConfig ?? null,
  });
}

export async function sendApiAgentMessage(
  sessionId: string,
  message: string,
  attachments?: ImageAttachment[],
): Promise<void> {
  return invoke("send_api_agent_message", {
    sessionId,
    message,
    attachments: attachments ?? null,
  });
}

export async function setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
  return invoke("set_plan_mode", { sessionId, enabled });
}

export async function setPermissionMode(
  sessionId: string,
  mode: "auto" | "ask_for_risky" | "allow_all" | "deny_all",
): Promise<void> {
  return invoke("set_permission_mode", { sessionId, mode });
}

export async function respondPermission(
  sessionId: string,
  toolId: string,
  decision: "allow_once" | "allow_always" | "deny",
): Promise<void> {
  return invoke("respond_permission", { sessionId, toolId, decision });
}

export async function setApproveWrites(sessionId: string, enabled: boolean): Promise<void> {
  return invoke("set_approve_writes", { sessionId, enabled });
}

export async function respondEdit(
  sessionId: string,
  toolId: string,
  decision: "apply" | "reject",
): Promise<void> {
  return invoke("respond_edit", { sessionId, toolId, decision });
}

export async function retryLastTurn(sessionId: string, newModel?: string): Promise<void> {
  return invoke("retry_last_turn", { sessionId, newModel: newModel ?? null });
}

export async function saveCheckpoint(sessionId: string, data: string): Promise<string> {
  return invoke<string>("save_checkpoint", { sessionId, data });
}

export async function listCheckpoints(sessionId: string): Promise<string[]> {
  return invoke<string[]>("list_checkpoints", { sessionId });
}

export async function deleteCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
  return invoke("delete_checkpoint", { sessionId, checkpointId });
}

export async function exportConversationMarkdown(
  title: string,
  model: string,
  messagesJson: string,
): Promise<string> {
  return invoke<string>("export_conversation_markdown", { title, model, messagesJson });
}

export async function listSlashCommands(projectPath: string): Promise<SlashCommandDef[]> {
  return invoke<SlashCommandDef[]>("list_slash_commands", { projectPath });
}

export async function cancelApiAgentSession(sessionId: string): Promise<void> {
  return invoke("cancel_api_agent_session", { sessionId });
}

export async function closeApiAgentSession(sessionId: string): Promise<void> {
  return invoke("close_api_agent_session", { sessionId });
}

// API Agent: persistence + utilities
export async function saveConversation(id: string, data: string): Promise<void> {
  return invoke("save_conversation", { id, data });
}

export async function loadConversations(): Promise<string[]> {
  return invoke<string[]>("load_conversations");
}

export async function deleteConversationFile(id: string): Promise<void> {
  return invoke("delete_conversation_file", { id });
}

export async function changeAgentModel(sessionId: string, newModel: string): Promise<void> {
  return invoke("change_model", { sessionId, newModel });
}

export async function calculateTurnCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
): Promise<number> {
  return invoke<number>("calculate_turn_cost", {
    model,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
  });
}

export async function listProjectFiles(
  projectPath: string,
  filter?: string,
  limit?: number,
): Promise<string[]> {
  return invoke<string[]>("list_project_files", {
    projectPath,
    filter: filter ?? null,
    limit: limit ?? null,
  });
}

export async function readFileForDiff(
  projectPath: string,
  relPath: string,
): Promise<string | null> {
  return invoke<string | null>("read_file_for_diff", { projectPath, relPath });
}

