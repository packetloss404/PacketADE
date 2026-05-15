import { invoke } from "@tauri-apps/api/core";
import type {
  AgentConfigDto,
  MissionApprovalRequestDto,
  OrchestratorSnapshotDto,
  PersistedStateDto,
  PersistedUiStateDto,
  TaskSpawnRequestDto,
  WorkspaceDto,
} from "@/generated/tauri-schema";
import type { AgentConfig } from "@/types/agent";
import type { Attempt, Flight, Milestone, ReviewType, Task, TaskResult } from "@/types/flight";
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

/** Phase 3.3: minimum SSH config the remote git commands need. The
 *  frontend builds this by looking up the workspace's `serverId` in
 *  `serverStore`. Field names are camelCase so the Tauri layer can
 *  deserialize them via `#[serde(rename_all = "camelCase")]`. */
export interface GitServerConfigInput {
  id: string;
  host: string;
  port: number;
  username: string;
  keyPath?: string | null;
  hostFingerprint?: string | null;
}

/** Convert a saved `ServerConfig` to the minimum shape the remote git +
 *  clone commands accept. Centralised so callers can't accidentally
 *  forget to forward `hostFingerprint` (which would silently downgrade
 *  to TOFU). */
export function toGitServerConfigInput(server: ServerConfig): GitServerConfigInput {
  return {
    id: server.id,
    host: server.host,
    port: server.port,
    username: server.username,
    keyPath: server.keyPath ?? null,
    hostFingerprint: server.hostFingerprint ?? null,
  };
}

/** Phase 3.3: remote variant of `getGitBranch`. Runs `git rev-parse
 *  --abbrev-ref HEAD` on the remote host described by `serverConfig`. */
export async function getGitBranchRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
): Promise<string> {
  return invoke<string>("get_git_branch_remote", { serverConfig, remotePath });
}

/** Phase 3.3: remote variant of `getGitStatus`. Returns `git status
 *  --short` output verbatim so the existing parser keeps working. */
export async function getGitStatusRemote(
  serverConfig: GitServerConfigInput,
  remotePath: string,
): Promise<string> {
  return invoke<string>("get_git_status_remote", { serverConfig, remotePath });
}

/** Phase 3.2: clone `repoUrl` into `destPath` on the SSH host. Returns
 *  the remote path that was created plus the freshly-cloned default
 *  branch (`git rev-parse --abbrev-ref HEAD`). The Tauri layer
 *  validates `branch`, `destPath`, and `repoUrl` against a tight
 *  allowlist before running anything on the remote shell. */
export interface CloneRemoteResult {
  remotePath: string;
  defaultBranch: string;
}

export async function cloneRepoRemote(args: {
  serverId: string;
  serverConfig: GitServerConfigInput;
  repoUrl: string;
  destPath: string;
  branch?: string | null;
}): Promise<CloneRemoteResult> {
  return invoke<CloneRemoteResult>("clone_repo_remote", {
    serverId: args.serverId,
    serverConfig: args.serverConfig,
    repoUrl: args.repoUrl,
    destPath: args.destPath,
    branch: args.branch ?? null,
  });
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

/**
 * T3.F: provision a git worktree for an Agents-pane conversation. Returns
 * the absolute path the conversation should use as its `projectPath` so
 * every tool call lands inside the worktree on a dedicated branch
 * (`pkt/<convId>`). Idempotent.
 */
export async function createConversationWorktree(
  projectPath: string,
  convId: string,
  baseBranch: string,
): Promise<string> {
  return invoke<string>("create_conversation_worktree", {
    projectPath,
    convId,
    baseBranch,
  });
}

export async function removeConversationWorktree(
  projectPath: string,
  convId: string,
): Promise<void> {
  return invoke("remove_conversation_worktree", { projectPath, convId });
}

/**
 * A4: resolve the AGENTS.md / CLAUDE.md cascade for `cwd`. Walks
 * `~/.claude/AGENTS{.override,}.md` → git-root → cwd, picks one of
 * `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per directory,
 * concatenates root → leaf with source-attribution headers, caps at
 * 32 KiB. Returns null when nothing was found anywhere.
 */
export async function resolveAgentsMd(cwd: string): Promise<string | null> {
  return invoke<string | null>("resolve_agents_md", { cwd });
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
  hostFingerprint?: string | null;
}): Promise<void> {
  return invoke("ssh_test_connection", {
    host: args.host,
    port: args.port,
    user: args.user,
    keyPath: args.keyPath ?? null,
    password: args.password ?? null,
    hostFingerprint: args.hostFingerprint ?? null,
  });
}

/** One discovered SSH host key — matches `commands::pty::HostKey`. */
export interface HostKey {
  algorithm: string;
  /** Raw `known_hosts`-format line from `ssh-keyscan`. */
  key: string;
  /** SHA256:<base64> fingerprint derived via `ssh-keygen -lf -`. */
  fingerprint: string;
}

/** Run `ssh-keyscan` on a host and return its public host keys + SHA256
 *  fingerprints. Used by the Servers UI on first save so the user can
 *  verify and pin the host key before any traffic is sent. */
export async function sshFetchFingerprint(host: string, port: number): Promise<HostKey[]> {
  return invoke<HostKey[]>("ssh_fetch_fingerprint", { host, port });
}

/** Append a `known_hosts`-format line to the app-managed known_hosts
 *  file. Called after the user confirms the fingerprint shown by
 *  `sshFetchFingerprint`. Idempotent. */
export async function sshPinHost(host: string, port: number, hostkeyLine: string): Promise<void> {
  return invoke("ssh_pin_host", { host, port, hostkeyLine });
}

/** Absolute path of the app-managed `known_hosts` file. Fetch once at
 *  startup and cache in `serverStore.knownHostsPath`. */
export async function getAppKnownHostsPath(): Promise<string> {
  return invoke<string>("get_app_known_hosts_path");
}

/** Result of probing a remote filesystem path over SSH. */
export interface RemotePathCheck {
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
}

/** Probe a remote SSH host to check whether `remotePath` exists, is a
 *  directory, and contains `.git`. Used by the workspace creation modal
 *  for live validation of the "Remote project path" input. Times out at
 *  8s. When `hostFingerprint` is provided, SSH connects with strict
 *  host-key checking against the app-managed known_hosts file. */
export async function sshCheckRemotePath(args: {
  host: string;
  port: number;
  user: string;
  authMethod: "agent" | "key" | "password";
  keyPath?: string | null;
  password?: string | null;
  hostFingerprint?: string | null;
  remotePath: string;
}): Promise<RemotePathCheck> {
  return invoke<RemotePathCheck>("ssh_check_remote_path", {
    host: args.host,
    port: args.port,
    user: args.user,
    authMethod: args.authMethod,
    keyPath: args.keyPath ?? null,
    password: args.password ?? null,
    hostFingerprint: args.hostFingerprint ?? null,
    remotePath: args.remotePath,
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

// Async parallel agent attempts (Flight Deck "one prompt → N agents")
export type AttemptTargetSpec =
  | {
      kind: "local";
      basePath: string;
      baseBranch: string;
      agentConfigId: string;
      provider: string;
      model: string;
    }
  | {
      kind: "ssh";
      targetId: string;
      host: string;
      port: number;
      user: string;
      keyPath?: string | null;
      /** Phase 2: pinned SHA256 host-key fingerprint, copied from
       *  `ServerConfig.hostFingerprint`. When omitted, the per-attempt
       *  SSH connection falls back to TOFU `accept-new` and the Rust
       *  side logs a warning. */
      hostFingerprint?: string | null;
      basePath: string;
      baseBranch: string;
      agentConfigId: string;
      provider: string;
      model: string;
    };

export async function launchFlightAsync(
  flightId: string,
  prompt: string,
  targets: AttemptTargetSpec[],
): Promise<Attempt[]> {
  const dtoTargets = targets.map((t) => {
    if (t.kind === "local") {
      return {
        kind: "local",
        base_path: t.basePath,
        base_branch: t.baseBranch,
        agent_config_id: t.agentConfigId,
        provider: t.provider,
        model: t.model,
      };
    }
    return {
      kind: "ssh",
      target_id: t.targetId,
      host: t.host,
      port: t.port,
      user: t.user,
      key_path: t.keyPath ?? null,
      host_fingerprint: t.hostFingerprint ?? null,
      base_path: t.basePath,
      base_branch: t.baseBranch,
      agent_config_id: t.agentConfigId,
      provider: t.provider,
      model: t.model,
    };
  });
  const dtoAttempts = await invoke<PersistedStateDto["flights"][number]["attempts"]>(
    "launch_flight_async",
    { flightId, prompt, targets: dtoTargets },
  );
  return dtoAttempts.map(fromDtoAttempt);
}

export async function cancelFlightAttempt(
  flightId: string,
  attemptId: string,
): Promise<void> {
  return invoke("cancel_flight_attempt", { flightId, attemptId });
}

export async function cleanupAttemptWorktreeSsh(args: {
  flightId: string;
  attemptId: string;
  host: string;
  port: number;
  user: string;
  keyPath?: string | null;
  basePath: string;
  targetId: string;
  /** Phase 2: pinned SHA256 host-key fingerprint, sourced from the saved
   *  `ServerConfig.hostFingerprint`. */
  hostFingerprint?: string | null;
}): Promise<void> {
  return invoke("cleanup_attempt_worktree_ssh", {
    flightId: args.flightId,
    attemptId: args.attemptId,
    host: args.host,
    port: args.port,
    user: args.user,
    keyPath: args.keyPath ?? null,
    basePath: args.basePath,
    targetId: args.targetId,
    hostFingerprint: args.hostFingerprint ?? null,
  });
}

export async function markAttemptStatus(
  flightId: string,
  attemptId: string,
  status: "reviewing" | "completed" | "failed" | "cancelled",
): Promise<void> {
  return invoke("mark_attempt_status", { flightId, attemptId, status });
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

function fromDtoAttempt(a: PersistedStateDto["flights"][number]["attempts"][number]): Attempt {
  return {
    id: a.id,
    flightId: a.flightId,
    target: a.target,
    agentConfigId: a.agentConfigId,
    model: a.model,
    provider: a.provider,
    branch: a.branch,
    baseBranch: a.baseBranch,
    sessionId: a.sessionId,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    cost: a.cost,
    tokens: a.tokens,
    errorMessage: a.errorMessage,
  };
}

function toDtoAttempt(a: Attempt): PersistedStateDto["flights"][number]["attempts"][number] {
  return {
    id: a.id,
    flightId: a.flightId,
    target: a.target,
    agentConfigId: a.agentConfigId,
    model: a.model,
    provider: a.provider,
    branch: a.branch,
    baseBranch: a.baseBranch,
    sessionId: a.sessionId,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    cost: a.cost,
    tokens: a.tokens,
    errorMessage: a.errorMessage,
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
    prompt: flight.prompt,
    attempts: (flight.attempts ?? []).map(fromDtoAttempt),
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
    prompt: flight.prompt,
    attempts: (flight.attempts ?? []).map(toDtoAttempt),
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
    serverId: workspace.serverId,
    remoteProjectPath: workspace.remoteProjectPath,
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
    serverId: workspace.serverId,
    remoteProjectPath: workspace.remoteProjectPath,
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
    hostFingerprint: s.hostFingerprint ?? null,
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

export type ProviderAuthStatus = {
  status: "ready" | "login_required" | "missing_key" | "service_down" | "coming_soon";
  hint: string; // short CTA/explanation, e.g. "Run claude login" or "Ollama not reachable"
};

export async function getProviderAuthStatus(provider: string): Promise<ProviderAuthStatus> {
  return invoke("get_provider_auth_status", { provider });
}

// Ollama local model discovery — queries the Ollama daemon's /api/tags
// endpoint to list models the user has pulled locally. Returns an empty
// array when the daemon is reachable but has no models. Throws on
// connection failure.
export type OllamaModel = {
  name: string;
  size: number | null;
  modified_at: string | null;
};

export async function getOllamaBaseUrl(): Promise<string> {
  return invoke<string>("get_ollama_base_url");
}

export async function setOllamaBaseUrl(baseUrl: string | null): Promise<string> {
  return invoke<string>("set_ollama_base_url", { baseUrl });
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  return invoke("list_ollama_models");
}

export interface ImageAttachment {
  media_type: string;
  data_base64: string;
}

export interface ResumeMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SshConfigInput {
  host: string;
  port: number;
  user: string;
  remote_path: string;
  key_path?: string | null;
  /** Phase 2: callers should derive this from `ServerConfig` (the canonical
   *  SSH model) so flight attempts and API-agent sessions pin host keys
   *  instead of falling back to TOFU. Frontend conversion site lives in
   *  `agentTaskStore` (per-message build) and `LaunchAsyncFlightModal`
   *  (per-attempt spec build). */
  target_id?: string | null;
  host_fingerprint?: string | null;
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
  allowedTools?: string[] | null,
  /** v3: opaque resume token from a prior `done` event. Lets sidecar
   * providers continue the model-side conversation across app restarts. */
  resumeToken?: string | null,
  /** F9: per-conversation MCP server filter. null = all enabled servers
   * (back-compat). [] = explicitly none. Otherwise only listed names are
   * forwarded to the sidecar. Applied on session start; no mid-session
   * swap (sidecar protocol has no `set_mcp_servers`). */
  enabledMcpServerIds?: string[] | null,
  /** Persisted transcript used when rehydrating providers that do not have a
   * native provider resume token, or when restoring in-process histories. */
  resumeMessages?: ResumeMessage[] | null,
  permissionMode?: "auto" | "ask_for_risky" | "allow_all" | "deny_all" | null,
  approveWrites?: boolean | null,
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
    allowedTools: allowedTools ?? null,
    resumeToken: resumeToken ?? null,
    enabledMcpServerIds: enabledMcpServerIds ?? null,
    resumeMessages: resumeMessages ?? null,
    permissionMode: permissionMode ?? null,
    approveWrites: approveWrites ?? null,
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
  /** v3: when set, the sidecar provider writes this content directly
   * (per-hunk acceptance) instead of letting the model's full `after`
   * land. In-process providers ignore this for now. */
  mergedContent?: string,
): Promise<void> {
  return invoke("respond_edit", {
    sessionId,
    toolId,
    decision,
    mergedContent: mergedContent ?? null,
  });
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

export interface SkillDef {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  source: string;
  body: string;
}

export async function listSkills(projectPath: string): Promise<SkillDef[]> {
  return invoke<SkillDef[]>("list_skills", { projectPath });
}

export async function cancelApiAgentSession(sessionId: string): Promise<void> {
  return invoke("cancel_api_agent_session", { sessionId });
}

/**
 * F8: drain parked permission/edit prompts as denied without killing the
 * agent loop. The model continues with synthetic "User cancelled this tool"
 * tool_results. Use `cancelApiAgentSession` instead when the user wants the
 * whole conversation to stop.
 */
export async function cancelPendingTools(sessionId: string): Promise<void> {
  return invoke("cancel_pending_tools", { sessionId });
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

// Side chat — fire-and-forget. Listen for `side-chat:done` / `side-chat:error`
// for the result; see src/lib/events.ts for the event names.
export async function askSideChatStream(question: string, context: string): Promise<void> {
  return invoke("ask_side_chat_stream", { question, context });
}

// === Sidecar lifecycle (v2 Tier 2 slice B) =================================
//
// The Node agent-sidecar is supervised by the Rust backend. This surface lets
// the status-bar chip show its current state and react to transitions.

// Cross-restart counters persisted in `~/.packetade/sidecar-stats.json`
// (v2 Tier 4 slice A). Populated on every `getSidecarStatus` poll and every
// `sidecar-status:changed` event. All fields snake_case to match the Rust
// wire format verbatim.
export type SidecarLifetimeStats = {
  total_starts: number;
  total_crashes: number;
  last_crash_time: string | null;
  last_version: string | null;
  last_error: string | null;
  total_uptime_secs: number;
};

export type SidecarStatus = {
  state: "ready" | "restarting" | "down" | "not_started";
  restart_count: number;
  last_error: string | null;
  pid: number | null;
  version: string | null;
  lifetime: SidecarLifetimeStats;
};

export async function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("get_sidecar_status");
}

// === Provider launch stats (v2 Tier 4 slice B) =============================
//
// Local-only per-provider launch counter. Increments once per
// `start_api_agent_session` call. Nothing is reported externally; this binding
// just exposes the counter so the existing cost/analytics view could consume
// it later if desired.

export type ProviderLaunchStats = {
  counts: Record<string, number>;
  last_launch: Record<string, string>;
};

export async function getProviderLaunchStats(): Promise<ProviderLaunchStats> {
  return invoke<ProviderLaunchStats>("get_provider_launch_stats");
}

// === Mission Planner (E1) =================================================
//
// Autonomous planner sessions bound to a Mission. The planner is a long-lived
// `api-claude-oauth` sidecar session — it emits the standard
// `api-agent:*:<sessionId>` event stream, so consumers attach to those events
// via `apiAgent*Event` helpers using the returned plannerSessionId.

export async function startMissionPlanner(
  missionId: string,
  projectPath: string,
  provisionalSessionId?: string,
): Promise<string> {
  return invoke<string>("start_mission_planner", {
    missionId,
    projectPath,
    provisionalSessionId,
  });
}

export async function stopMissionPlanner(missionId: string): Promise<void> {
  return invoke("stop_mission_planner", { missionId });
}

export async function pauseMissionPlanner(missionId: string): Promise<void> {
  return invoke("pause_mission_planner", { missionId });
}

export async function resumeMissionPlanner(missionId: string): Promise<void> {
  return invoke("resume_mission_planner", { missionId });
}

export async function injectPlannerTurn(
  missionId: string,
  content: string,
  source: "user" | "wake_trigger",
): Promise<void> {
  return invoke("inject_planner_turn", { missionId, content, source });
}

// E2 — async-return approval gate. The planner's `request_user_approval`
// tool files an approval and keeps working; the frontend surfaces it via the
// `mission-planner:approval-request:<missionId>` event and resolves it back
// to the planner with this binding. `choice` is one of the option labels the
// planner offered, the user's free-text answer, `"acknowledged"`, or
// `"dismissed"`.
export async function resolveMissionApproval(
  approvalId: string,
  choice: string,
): Promise<void> {
  return invoke("resolve_mission_approval", { approvalId, choice });
}

// Cold-start hydration for `missionPlannerStore.pendingApprovals`. Event
// listeners installed in `startPlanner` only see approvals filed AFTER they
// attach; this binding backfills any unresolved approvals already on disk
// (paused mission resume, page reload, cold app start). Returns only
// unresolved entries — resolved approvals are historical.
export async function getMissionApprovals(
  missionId: string,
): Promise<MissionApprovalRequestDto[]> {
  return invoke<MissionApprovalRequestDto[]>("get_mission_approvals", { missionId });
}

