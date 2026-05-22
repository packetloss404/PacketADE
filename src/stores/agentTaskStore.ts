import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  createPtySession,
  writePty,
  killPty,
  listPtySessions,
  readPtyTranscript,
  startApiAgentSession,
  sendApiAgentMessage,
  cancelApiAgentSession,
  closeApiAgentSession,
  saveConversation,
  loadConversations,
  deleteConversationFile,
  changeAgentModel,
  setPlanMode as tauriSetPlanMode,
  setPermissionMode as tauriSetPermissionMode,
  setApproveWrites as tauriSetApproveWrites,
  retryLastTurn as tauriRetryLastTurn,
  saveCheckpoint as tauriSaveCheckpoint,
  listCheckpoints as tauriListCheckpoints,
  exportConversationMarkdown,
  type ImageAttachment,
  type ResumeMessage,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
/** Phase 2: SSH conversations now reference a `ServerConfig` from
 *  `serverStore` plus a per-session remote path. This payload is what the
 *  Agents UI hands to `createApiConversation` — it carries every field we
 *  need to start the backend session AND seed `AgentConversation.sshTarget`
 *  without re-reading `serverStore`. The legacy `SshTarget` type / store
 *  was deleted in Phase 2; persisted records were migrated into
 *  `serverStore`'s servers list. */
export interface AgentSshConfigInput {
  /** ServerConfig id from `serverStore`. Persisted on the conversation so
   *  later hydration can re-resolve the server (or fall back gracefully
   *  if the server was deleted). */
  serverId: string;
  /** Display name surfaced in the conversation sidebar / header. */
  name: string;
  host: string;
  port: number;
  user: string;
  /** Per-session remote project path. May differ from
   *  `ServerConfig.remotePath` (the server-level default). */
  remotePath: string;
  keyPath?: string | null;
  /** Pinned SHA256 host-key fingerprint, copied from
   *  `ServerConfig.hostFingerprint`. Forwarded to the backend so strict
   *  host-key checking applies. */
  hostFingerprint?: string | null;
}
import { ptyOutputEvent, ptyExitEvent } from "@/lib/events";
import { generateId } from "@/lib/storage";
import { LEGACY_STORAGE_PREFIX, storageKey } from "@/lib/brand";
import { useMemoryStore } from "@/stores/memoryStore";
import { getAgentAutoArchiveIdleMs } from "@/stores/agentSettingsStore";
import { useAgentStore } from "@/stores/agentStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";
import { loadAgentsMd } from "@/lib/agentsMd";
import type { GitHubRepo } from "@/types/github";
import type {
  AgentConversation,
  AgentMessage,
  AgentToolCall,
  DiffComment,
  PermissionMode,
} from "@/types/agent-conversation";
import { installApiAgentListeners } from "@/stores/apiAgentListeners";

/** Build a serializable snapshot of a conversation for `saveConversation`.
 * Pulls plan/spec state out of `agentPlanStore` so the persisted record
 * keeps its on-disk shape even though those fields no longer live on the
 * in-memory conversation object. Ephemeral substores (approval,
 * streaming) are intentionally omitted — they reset on hydration. */
function snapshotForPersist(conv: AgentConversation): AgentConversation {
  const plans = useAgentPlanStore.getState();
  return {
    ...conv,
    spec: plans.getSpec(conv.id),
    specStage: plans.getSpecStage(conv.id),
    plan: plans.getPlan(conv.id),
    planApproved: plans.getPlanApproved(conv.id) || undefined,
  };
}

/** Debounced save: per-conversation timers so rapid streaming events coalesce. */
const SAVE_DEBOUNCE_MS = 500;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(conv: AgentConversation): void {
  if (conv.mode !== "api") return; // only persist API conversations
  const existing = saveTimers.get(conv.id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    saveTimers.delete(conv.id);
    saveConversation(conv.id, JSON.stringify(snapshotForPersist(conv))).catch((e) => {
      console.warn("Failed to save conversation:", conv.id, e);
    });
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(conv.id, handle);
}

/** Request a save for a conversation by id. Plan-store mutations call
 * this so plan/spec edits debounce-persist through the same path as
 * conversation mutations, without plan-store needing to import the full
 * agentTaskStore module at load time. */
export function requestConversationSave(conversationId: string): void {
  const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === conversationId);
  if (conv) scheduleSave(conv);
}

function nonOverlappingSuffix(base: string, tail: string): string {
  if (!base || !tail) return tail;
  const max = Math.min(base.length, tail.length);
  for (let len = max; len > 0; len--) {
    if (base.endsWith(tail.slice(0, len))) return tail.slice(len);
  }
  return tail;
}

async function installPtyListenersWithReplay(
  sessionId: string,
  onOutput: (chunk: string) => void,
  onExit: () => void,
): Promise<UnlistenFn[]> {
  let buffering = true;
  let buffered = "";
  let exitWhileBuffering = false;
  let finished = false;
  const unlisteners: UnlistenFn[] = [];

  const finish = () => {
    if (finished) return;
    if (buffering) {
      exitWhileBuffering = true;
      return;
    }
    finished = true;
    for (const unlisten of unlisteners) {
      try {
        unlisten();
      } catch {
        // listener already gone
      }
    }
    onExit();
  };

  const [outputUnlisten, exitUnlisten] = await Promise.all([
    listen<string>(ptyOutputEvent(sessionId), (event) => {
      if (buffering) {
        buffered += event.payload;
      } else {
        onOutput(event.payload);
      }
    }),
    listen<string>(ptyExitEvent(sessionId), finish),
  ]);
  unlisteners.push(outputUnlisten, exitUnlisten);
  if (finished) {
    outputUnlisten();
    exitUnlisten();
  }

  const transcript = await readPtyTranscript(sessionId).catch(() => null);
  const replayed = transcript?.data ?? "";
  if (replayed) onOutput(replayed);
  const bufferedRemainder = nonOverlappingSuffix(replayed, buffered);
  if (bufferedRemainder) onOutput(bufferedRemainder);
  buffering = false;
  if (exitWhileBuffering) finish();

  const sessions = await listPtySessions().catch(() => null);
  const liveSession = sessions?.find((s) => s.id === sessionId);
  if (sessions && (!liveSession || !liveSession.alive)) finish();

  return unlisteners;
}

export type BuiltinCliAgent = "claude-code" | "codex" | "gemini" | "opencode" | "packetcode";
export type ApiAgentCli =
  | "api-claude-oauth"
  | "api-claude"
  | "api-openai-codex"
  | "api-openai-agents"
  | "api-openai"
  | "api-minimax"
  | "api-openrouter"
  | "api-ollama";

export type AgentCli =
  | "claude-code"
  | "codex"
  | "gemini"
  | "opencode"
  | "packetcode"
  | "api-claude-oauth"
  | "api-claude"
  | "api-openai-codex"
  | "api-openai-agents"
  | "api-openai"
  | "api-minimax"
  | "api-openrouter"
  | "api-ollama"
  | (string & {});

/** Check if an agent type uses API mode (vs PTY/CLI mode). */
export function isApiAgent(agent: AgentCli): boolean {
  return agent.startsWith("api-");
}

/** Get the provider name from an API agent type. */
export function apiAgentProvider(agent: AgentCli): string {
  const map: Partial<Record<AgentCli, string>> = {
    "api-claude-oauth": "claude-oauth",
    "api-claude": "anthropic",
    "api-openai-codex": "openai-codex",
    "api-openai-agents": "openai-agents",
    "api-openai": "openai",
    "api-minimax": "minimax",
    "api-openrouter": "openrouter",
    "api-ollama": "ollama",
  };
  return map[agent] ?? "anthropic";
}

function apiAgentCommandPath(agent: AgentCli): string | null {
  if (agent !== "api-openai-codex") return null;
  const manualPath = useCliOverrideStore.getState().overrides.codex?.manualPath.trim();
  return manualPath || null;
}
export type AgentTaskStatus = "running" | "done" | "failed" | "cancelled";

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  agent: AgentCli;
  projectPath: string;
  status: AgentTaskStatus;
  sessionId: string | null;
  output: string;
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
}

/** Max output buffer per task (256 KB) to avoid memory bloat */
const MAX_OUTPUT_SIZE = 256 * 1024;

/** Fallback command names for PTY-based agents if the agent store has not hydrated yet. */
const CLI_COMMANDS: Record<BuiltinCliAgent, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  packetcode: "packetcode",
};

/** Bypass-permissions flags for autonomous execution.
 * OpenCode is intentionally omitted — it has no equivalent launch flag and
 * passing one makes it print `--help` and exit. PacketCode uses `--trust`. */
const BYPASS_FLAGS: Partial<Record<BuiltinCliAgent, string>> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  gemini: "--yolo",
  packetcode: "--trust",
};

function isBuiltinCliAgent(agent: AgentCli): agent is BuiltinCliAgent {
  return Object.prototype.hasOwnProperty.call(CLI_COMMANDS, agent);
}

function resolveCliLaunch(
  agent: AgentCli,
  options: { includeAutonomyFlag?: boolean } = {},
): { command: string; args: string[]; displayName: string } | null {
  if (isApiAgent(agent)) return null;

  const config = useAgentStore.getState().getAgent(agent);
  if (config && config.id !== "terminal") {
    const args = [...config.defaultArgs];
    if (options.includeAutonomyFlag && isBuiltinCliAgent(agent)) {
      const flag = BYPASS_FLAGS[agent];
      if (flag && !args.includes(flag)) args.unshift(flag);
    }
    return { command: config.command, args, displayName: config.name };
  }

  if (!isBuiltinCliAgent(agent)) return null;
  const args: string[] = [];
  const flag = options.includeAutonomyFlag ? BYPASS_FLAGS[agent] : undefined;
  if (flag) args.push(flag);
  return { command: CLI_COMMANDS[agent], args, displayName: agent };
}

export type AgentInputMode = "build" | "plan";

/** Cleanup functions for API conversation event listeners. */
const apiConversationCleanup = new Map<string, () => void>();

/** Per-conversation guard so auto-failover never loops. Cleared whenever
 * the user sends a fresh user turn; replenished on a successful turn.
 * Exported so the listener module (apiAgentListeners.ts) can flip the
 * guard inside the rate-limit error handler without re-importing the
 * whole store surface. */
export const failoverGuard = new Set<string>();

const PROJECT_LABELS_STORAGE_KEY = storageKey("project-labels");
const LEGACY_PROJECT_LABELS_STORAGE_KEY = `${LEGACY_STORAGE_PREFIX}project-labels`;

function loadProjectLabels(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const currentRaw = localStorage.getItem(PROJECT_LABELS_STORAGE_KEY);
    if (currentRaw) return JSON.parse(currentRaw) as Record<string, string>;

    const legacyRaw = localStorage.getItem(LEGACY_PROJECT_LABELS_STORAGE_KEY);
    if (!legacyRaw) return {};

    const migrated = JSON.parse(legacyRaw) as Record<string, string>;
    localStorage.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return {};
  }
}

/** Derive a display name for a projectPath (e.g. "owner/repo" or last two segments). */
export function repoDisplayName(projectPath: string, githubRepos: GitHubRepo[]): string {
  const segments = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folderName = segments[segments.length - 1] ?? projectPath;
  const match = githubRepos.find((r) => r.name === folderName);
  if (match) return match.full_name;
  if (segments.length >= 2)
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return folderName;
}

/** Max conversation raw output buffer (256 KB) */
const MAX_RAW_OUTPUT_SIZE = 256 * 1024;
const MAX_RESUME_MESSAGES = 80;
const MAX_RESUME_CHARS = 120_000;
const MAX_TOOL_RESUME_CHARS = 4_000;

function truncateResumeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated]`;
}

function toolCallsResumeText(toolCalls: AgentToolCall[] | undefined): string {
  if (!toolCalls || toolCalls.length === 0) return "";
  const lines = toolCalls.map((tc) => {
    const parts = [`- ${tc.name} (${tc.status})`];
    if (tc.input) parts.push(`input: ${truncateResumeText(tc.input, 800)}`);
    const output = tc.fullContent ?? tc.summary ?? "";
    if (output) parts.push(`result: ${truncateResumeText(output, MAX_TOOL_RESUME_CHARS)}`);
    return parts.join("\n  ");
  });
  return `Tool calls:\n${lines.join("\n")}`;
}

function messageResumeContent(message: AgentMessage): string {
  const parts = [message.content.trim()];
  if (message.role === "assistant") {
    const toolText = toolCallsResumeText(message.toolCalls);
    if (toolText) parts.push(toolText);
  }
  return parts.filter(Boolean).join("\n\n");
}

export function buildConversationResumeMessages(messages: AgentMessage[]): ResumeMessage[] {
  const normalized = messages
    .filter((m) => !m.isStreaming && !m.queued)
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) => ({
      role: m.role,
      content: messageResumeContent(m),
    }))
    .filter((m) => m.content.length > 0);

  const kept: ResumeMessage[] = [];
  let totalChars = 0;
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const message = normalized[i];
    const nextChars = totalChars + message.content.length;
    if (kept.length >= MAX_RESUME_MESSAGES || nextChars > MAX_RESUME_CHARS) {
      break;
    }
    kept.unshift(message);
    totalChars = nextChars;
  }
  return kept;
}

interface AgentTaskStore {
  // --- Existing task state (used by Flight orchestration and legacy task launches) ---
  tasks: AgentTask[];
  selectedTaskId: string | null;
  selectedRepo: string | null;
  inputMode: AgentInputMode;
  agentInputText: string;
  selectedServerId: string | null;

  // --- Conversation state ---
  conversations: AgentConversation[];
  selectedConversationId: string | null;

  // --- Existing task actions ---
  launchTask: (
    title: string,
    description: string,
    agent: AgentCli,
    projectPath: string,
  ) => Promise<string>;
  cancelTask: (id: string) => void;
  deleteTask: (id: string) => void;
  selectTask: (id: string | null) => void;
  appendOutput: (id: string, text: string) => void;
  completeTask: (id: string, exitCode: number | null) => void;
  setSelectedRepo: (repo: string | null) => void;
  setInputMode: (mode: AgentInputMode) => void;
  setAgentInputText: (text: string) => void;
  setSelectedServerId: (id: string | null) => void;

  // --- Conversation actions ---
  createConversation: (agent: AgentCli, projectPath: string) => Promise<string>;
  createApiConversation: (
    agent: AgentCli,
    projectPath: string,
    model: string,
    initialMessage: string,
    systemPromptOverride?: string | null,
    thinkingEnabled?: boolean,
    planMode?: boolean,
    sshTarget?: AgentSshConfigInput | null,
    /** When set, use this id instead of generating a new one. Used by Flight
     * Deck attempts so the conversation id matches the backend session id. */
    explicitId?: string,
    /** When true, skip the start_api_agent_session backend call (the caller
     * has already started it). Used by Flight Deck attempts. */
    skipBackendStart?: boolean,
    /** Restrict the agent to this tool subset (e.g. Scout profile uses
     * read_file/list_directory/grep/web_fetch). Undefined = all tools. */
    allowedTools?: string[] | null,
    /** Inject the memory layer's project context into the system prompt.
     * Default false to preserve existing behavior. */
    memoryContextEnabled?: boolean,
    /** Image attachments inlined with the initial user message. Currently only
     * applied to the in-process LlmProvider path; sidecar Anthropic + Codex
     * ignore them until the protocol bump that wires them through. */
    attachments?: ImageAttachment[] | null,
    /** F9: per-conversation MCP server filter passed to the sidecar at
     * session start. null = all enabled servers. */
    enabledMcpServerIds?: string[] | null,
    /** Initial permission posture for the backend session. Must be supplied
     * before startApiAgentSession so the first turn doesn't race with a
     * post-create permission update. */
    permissionMode?: PermissionMode,
    approveWrites?: boolean,
  ) => Promise<string>;
  sendMessage: (
    conversationId: string,
    content: string,
    attachments?: ImageAttachment[] | null,
  ) => void;
  addAssistantMessage: (
    conversationId: string,
    content: string,
    toolCalls?: AgentToolCall[],
  ) => void;
  updateAssistantMessage: (conversationId: string, messageId: string, content: string) => void;
  selectConversation: (id: string | null) => void;
  deleteConversation: (id: string) => void;
  archiveConversation: (id: string) => void;
  unarchiveConversation: (id: string) => void;
  /** User-customizable display labels per projectPath (drives sidebar group headers).
   * Falls back to derived basename when unset. */
  projectLabels: Record<string, string>;
  setProjectLabel: (projectPath: string, label: string) => void;
  appendRawOutput: (conversationId: string, text: string) => void;
  cancelActiveConversation: (id: string) => Promise<void>;
  changeModel: (id: string, newModel: string) => Promise<void>;
  setPlanMode: (id: string, enabled: boolean) => Promise<void>;
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<void>;
  setApproveWrites: (id: string, enabled: boolean) => Promise<void>;
  /** B3: append a derived allowlist pattern to the conversation's
   * `allowedTools` (deduped). Read by the next turn's startApiAgentSession
   * via the resume path — no immediate backend call needed. Stays in
   * agentTaskStore because `allowedTools` is part of the persisted
   * conversation config (not approval state); the approval store's smart-
   * approval row delegates here AFTER respondPermission resolves so
   * subsequent same-pattern tool calls skip the prompt entirely. */
  appendAllowedToolPattern: (id: string, pattern: string) => void;
  /** B8: tag a child conversation with its parent's id so the chat
   * header can show a "← back to plan" link. Idempotent — calling
   * twice with the same parent is a no-op. */
  setParentConversation: (childId: string, parentId: string) => void;
  /** B1: queue a hover-`+` diff comment. Folded into the NEXT user
   * sendMessage as a "File comments:" preamble, then cleared. */
  addDiffComment: (id: string, comment: Omit<DiffComment, "id" | "createdAt">) => void;
  removeDiffComment: (id: string, commentId: string) => void;
  clearDiffComments: (id: string) => void;
  /** F9: set the per-conversation MCP server filter. null = all enabled
   * (back-compat). [] = explicitly none. Applies on next session start —
   * the sidecar protocol has no mid-session MCP swap. */
  setEnabledMcpServerIds: (id: string, ids: string[] | null) => void;
  retryLastTurn: (id: string, newModel?: string) => Promise<void>;
  /** M2.7 — Cursor-style "edit a prior user message and re-run from there."
   * Truncates the transcript to before the target user message, cancels any
   * active turn, and dispatches the new content as a fresh user turn. The
   * model receives the truncated history on the next send and the agent runs
   * forward from that fork point. File-state rewind isn't part of this v1
   * pass — only the transcript forks. */
  forkAndResend: (
    id: string,
    messageId: string,
    newContent: string,
  ) => Promise<void>;
  saveCheckpoint: (id: string) => Promise<string | null>;
  listCheckpoints: (
    id: string,
  ) => Promise<
    Array<{ id: string; createdAt: string; messageCount: number; messages: AgentMessage[] }>
  >;
  restoreCheckpoint: (id: string, rawJson: string) => void;
  exportConversation: (id: string) => Promise<string>;
  /** F1: re-establish a hydrated conversation that lost its live session
   * across an app restart. Re-attaches `api-agent:*` listeners and calls
   * `start_api_agent_session` with the conversation's `resumeToken` (when
   * present) plus `content` as the initial message. No-op when the
   * conversation already has live listeners or isn't an API conversation. */
  resumeApiConversation: (
    conversationId: string,
    content: string,
    attachments?: ImageAttachment[] | null,
  ) => Promise<void>;
}

/**
 * Idempotency wrapper for the api-agent listener block. The handler logic
 * lives in `./apiAgentListeners.ts`; this wrapper enforces
 * "one listener set per conversation id" via the `apiConversationCleanup`
 * map (the source of truth for which conversations have live listeners).
 * Callers that need to detach early (delete / forkAndResend) read directly
 * from `apiConversationCleanup`.
 */
async function ensureApiAgentListeners(id: string): Promise<void> {
  if (apiConversationCleanup.has(id)) return;
  const cleanup = await installApiAgentListeners(id);
  apiConversationCleanup.set(id, cleanup);
}

export const useAgentTaskStore = create<AgentTaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  selectedRepo: null,
  inputMode: "build",
  agentInputText: "",
  selectedServerId: null,

  // --- Conversation state ---
  conversations: [],
  selectedConversationId: null,

  launchTask: async (title, description, agent, projectPath) => {
    const id = generateId("agt");
    const launch = resolveCliLaunch(agent, { includeAutonomyFlag: true });
    if (!launch) return id; // API agents don't use PTY tasks

    const task: AgentTask = {
      id,
      title,
      description,
      agent,
      projectPath,
      status: "running",
      sessionId: null,
      output: "",
      startedAt: Date.now(),
      completedAt: null,
      exitCode: null,
    };

    set((s) => ({
      tasks: [task, ...s.tasks],
      selectedTaskId: id,
    }));

    try {
      const sessionId = await createPtySession(
        projectPath,
        120,
        40,
        launch.command,
        launch.args.length > 0 ? launch.args : null,
      );

      // Store the session ID
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, sessionId } : t)),
      }));

      await installPtyListenersWithReplay(
        sessionId,
        (chunk) => get().appendOutput(id, chunk),
        () => get().completeTask(id, 0),
      );

      // Send the task description as the initial prompt after a brief delay
      // (Claude is ready immediately; other CLIs need time to init)
      const delay = agent === "claude-code" ? 500 : 3000;
      setTimeout(() => {
        void writePty(sessionId, description + "\r");
      }, delay);
    } catch (err) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id
            ? {
                ...t,
                status: "failed",
                completedAt: Date.now(),
                output: t.output + `\nFailed to start: ${err}`,
              }
            : t,
        ),
      }));
    }

    return id;
  },

  cancelTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || task.status !== "running" || !task.sessionId) return;

    // Cancel kills the task's PTY — swallow if already exited.
    void killPty(task.sessionId).catch(() => {});
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, status: "cancelled", completedAt: Date.now() } : t,
      ),
    }));
  },

  deleteTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (task?.status === "running" && task.sessionId) {
      // Delete tears down any live PTY — swallow if already exited.
      void killPty(task.sessionId).catch(() => {});
    }
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      selectedTaskId: s.selectedTaskId === id ? null : s.selectedTaskId,
    }));
  },

  selectTask: (id) => set({ selectedTaskId: id }),
  setSelectedRepo: (repo) => set({ selectedRepo: repo }),
  setInputMode: (mode) => set({ inputMode: mode }),
  setAgentInputText: (text) => set({ agentInputText: text }),
  setSelectedServerId: (id) => set({ selectedServerId: id }),

  appendOutput: (id, text) => {
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== id) return t;
        const newOutput = t.output + text;
        return {
          ...t,
          output:
            newOutput.length > MAX_OUTPUT_SIZE ? newOutput.slice(-MAX_OUTPUT_SIZE) : newOutput,
        };
      }),
    }));
  },

  completeTask: (id, exitCode) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === "running"
          ? { ...t, status: exitCode === 0 ? "done" : "failed", completedAt: Date.now(), exitCode }
          : t,
      ),
    }));
  },

  // ─── Conversation actions ────────────────────────────────────────────

  createConversation: async (agent, projectPath) => {
    const id = generateId("conv");
    const launch = resolveCliLaunch(agent);
    if (!launch) return id; // API agents should use createApiConversation

    const now = Date.now();
    const segments = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
    const folderName = segments[segments.length - 1] ?? projectPath;

    const conversation: AgentConversation = {
      id,
      title: `${folderName} — ${agent}`,
      agent,
      projectPath,
      status: "active",
      messages: [],
      sessionId: null,
      rawOutput: "",
      createdAt: now,
      updatedAt: now,
      mode: "pty",
    };

    set((s) => ({
      conversations: [conversation, ...s.conversations],
      selectedConversationId: id,
    }));

    try {
      const sessionId = await createPtySession(
        projectPath,
      120,
      40,
      launch.command,
      launch.args.length > 0 ? launch.args : null,
    );

      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, sessionId } : c)),
      }));

      await installPtyListenersWithReplay(
        sessionId,
        (chunk) => get().appendRawOutput(id, chunk),
        () => {
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === id ? { ...c, status: "done", updatedAt: Date.now() } : c,
            ),
          }));
        },
      );
    } catch (err) {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id
            ? {
                ...c,
                status: "failed",
                updatedAt: Date.now(),
                rawOutput: c.rawOutput + `\nFailed to start: ${err}`,
              }
            : c,
        ),
      }));
    }

    return id;
  },

  createApiConversation: async (
    agent,
    projectPath,
    model,
    initialMessage,
    systemPromptOverride,
    thinkingEnabled,
    planMode,
    sshTarget,
    explicitId,
    skipBackendStart,
    allowedTools,
    memoryContextEnabled,
    attachments,
    enabledMcpServerIds,
    permissionMode,
    approveWrites,
  ) => {
    const id = explicitId ?? generateId("conv");
    const provider = apiAgentProvider(agent);

    // System-prompt assembly. Order (lowest in the prompt → highest):
    //   1. AGENTS.md / CLAUDE.md from the project root (the de-facto standard
    //      cross-tool instructions file).
    //   2. PacketADE memory layer (learned patterns + recent summaries),
    //      gated on the per-conversation `memoryContextEnabled` flag.
    //   3. Profile / explicit `systemPromptOverride` (lives last so it wins
    //      conflicts of intent — the user picked this profile deliberately).
    let effectiveSystemPrompt: string | null = systemPromptOverride ?? null;

    if (memoryContextEnabled) {
      const memoryContext = useMemoryStore.getState().getContextForSession(projectPath);
      if (memoryContext.trim().length > 0) {
        const base = effectiveSystemPrompt ?? "";
        effectiveSystemPrompt = `## Project memory (auto-injected from PacketADE memory layer)\n\n${memoryContext}\n\n---\n\n${base}`;
      }
    }

    // AGENTS.md prepend — async fetch, best-effort; failures are silent so a
    // missing file never blocks a launch.
    try {
      const agentsMd = await loadAgentsMd(projectPath);
      if (agentsMd) {
        const base = effectiveSystemPrompt ?? "";
        effectiveSystemPrompt = `## Project guidance (from AGENTS.md cascade)\n\n${agentsMd}\n\n---\n\n${base}`;
      }
    } catch {
      // Best-effort; absent file is the common case.
    }

    const now = Date.now();
    const displayBase = sshTarget
      ? sshTarget.name
      : (projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? projectPath);
    const modelShort = model.split("-").slice(0, 2).join("-");

    const userMsg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content: initialMessage,
      timestamp: now,
    };

    const conversation: AgentConversation = {
      id,
      title: `${displayBase} — ${modelShort}`,
      agent,
      projectPath,
      status: "active",
      messages: [userMsg],
      sessionId: id, // For API mode, sessionId == conversationId (used as event key)
      rawOutput: "",
      createdAt: now,
      updatedAt: now,
      mode: "api",
      provider,
      model,
      systemPromptOverride: effectiveSystemPrompt,
      queuedMessages: [],
      planMode: planMode ?? false,
      permissionMode: permissionMode ?? "auto",
      approveWrites: approveWrites ?? false,
      thinkingEnabled: thinkingEnabled ?? false,
      sshTarget: sshTarget
        ? {
            // Phase 2: `id` carries the ServerConfig id from serverStore.
            // Persisted conversations keep the field named `id` to preserve
            // back-compat with hydrated records from before the rename.
            id: sshTarget.serverId,
            name: sshTarget.name,
            host: sshTarget.host,
            user: sshTarget.user,
            remotePath: sshTarget.remotePath,
          }
        : undefined,
      allowedTools: allowedTools ?? undefined,
      memoryContextEnabled: memoryContextEnabled ?? false,
      enabledMcpServerIds: enabledMcpServerIds ?? undefined,
    };

    set((s) => ({
      conversations: [conversation, ...s.conversations],
      selectedConversationId: id,
    }));

    try {
      // Create a streaming assistant message
      const assistantMsgId = generateId("msg");
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: assistantMsgId,
                    role: "assistant" as const,
                    content: "",
                    timestamp: Date.now(),
                    isStreaming: true,
                  },
                ],
              }
            : c,
        ),
      }));

      await ensureApiAgentListeners(id);

      // Start the API agent session unless the caller already did so.
      if (!skipBackendStart) {
        const sshConfig = sshTarget
          ? {
              host: sshTarget.host,
              port: sshTarget.port,
              user: sshTarget.user,
              remote_path: sshTarget.remotePath,
              key_path: sshTarget.keyPath ?? null,
              // Phase 2: backend still calls this `target_id` for now. It
              // accepts the unified `ServerConfig.id`; the parallel backend
              // PR is unifying naming.
              target_id: sshTarget.serverId,
              host_fingerprint: sshTarget.hostFingerprint ?? null,
            }
          : null;
        await startApiAgentSession(
          id,
          provider,
          model,
          projectPath,
          initialMessage,
          effectiveSystemPrompt,
          thinkingEnabled ?? false,
          attachments ?? undefined,
          planMode ?? false,
          sshConfig,
          allowedTools ?? null,
          null, // resumeToken — fresh start
          enabledMcpServerIds ?? null,
          null,
          permissionMode ?? "auto",
          approveWrites ?? false,
          apiAgentCommandPath(agent),
        );
      }
    } catch {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, status: "failed", updatedAt: Date.now() } : c,
        ),
      }));
    }

    return id;
  },

  sendMessage: (conversationId, content, attachments) => {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    // Fresh user turn — re-arm auto-failover for this conversation.
    failoverGuard.delete(conversationId);

    // B1: fold queued hover-`+` diff comments into the prompt, then clear.
    // Format mirrors the Codex-App "File comments:" preamble — file:line
    // anchors give the model precise context without us having to re-send
    // the full diff (it's already in the conversation history).
    const queuedComments = conv.pendingDiffComments ?? [];
    let effectiveContent = content;
    if (queuedComments.length > 0) {
      const block = queuedComments.map((c) => `- ${c.path}:${c.line} — ${c.text}`).join("\n");
      effectiveContent = `File comments:\n${block}\n\n${content}`;
      // Clear immediately so the chip strip empties on click; if the send
      // ultimately fails, the comments are gone (acceptable — they're now
      // in the conversation history as part of the user message).
      get().clearDiffComments(conversationId);
    }

    // F1: hydrated API conversations have no live listeners — route the
    // first send-after-restart through the resume path so the Rust side
    // re-creates the session before the message arrives.
    if (conv.mode === "api" && !apiConversationCleanup.has(conversationId)) {
      void get().resumeApiConversation(conversationId, effectiveContent, attachments);
      return;
    }
    // Continue with the comment-augmented content from here on.
    content = effectiveContent;

    // If the agent is still running (API mode), queue the message and show a queued bubble.
    const isRunning =
      conv.mode === "api" && conv.status === "active" && conv.messages.some((m) => m.isStreaming);

    if (isRunning) {
      const queuedMsg: AgentMessage = {
        id: generateId("msg"),
        role: "user",
        content,
        timestamp: Date.now(),
        queued: true,
      };
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const next: AgentConversation = {
            ...c,
            messages: [...c.messages, queuedMsg],
            queuedMessages: [...(c.queuedMessages ?? []), content],
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
      return;
    }

    const msg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    let updatedAfterUser: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const next: AgentConversation = {
          ...c,
          messages: [...c.messages, msg],
          updatedAt: Date.now(),
          status: "active",
        };
        updatedAfterUser = next;
        return next;
      }),
    }));
    if (updatedAfterUser) scheduleSave(updatedAfterUser);

    if (conv.mode === "api") {
      // For API mode, create a new streaming assistant message and call the backend
      const assistantMsgId = generateId("msg");

      // Add streaming assistant message
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: assistantMsgId,
                    role: "assistant" as const,
                    content: "",
                    timestamp: Date.now(),
                    isStreaming: true,
                  },
                ],
              }
            : c,
        ),
      }));

      void sendApiAgentMessage(conversationId, content, attachments ?? undefined).catch(() => {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, status: "failed", updatedAt: Date.now() } : c,
          ),
        }));
      });
    } else {
      // PTY mode
      if (!conv.sessionId) return;
      void writePty(conv.sessionId, content + "\r");
    }
  },

  addAssistantMessage: (conversationId, content, toolCalls) => {
    const msg: AgentMessage = {
      id: generateId("msg"),
      role: "assistant",
      content,
      timestamp: Date.now(),
      toolCalls,
    };

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() }
          : c,
      ),
    }));
  },

  updateAssistantMessage: (conversationId, messageId, content) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
            }
          : c,
      ),
    }));
  },

  selectConversation: (id) => {
    set({ selectedConversationId: id });
  },

  deleteConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (conv && (conv.status === "active" || conv.status === "idle")) {
      if (conv.mode === "api") {
        // Failure here orphans an API session in the backend (and
        // potentially keeps billing tokens) — log so it's diagnosable.
        void cancelApiAgentSession(id).catch(
          logSwallowed("agentTaskStore.cancelApiSession"),
        );
        void closeApiAgentSession(id).catch(
          logSwallowed("agentTaskStore.closeApiSession"),
        );
        const cleanup = apiConversationCleanup.get(id);
        if (cleanup) {
          cleanup();
          apiConversationCleanup.delete(id);
        }
      } else if (conv.sessionId) {
        // Best-effort kill — swallow if PTY already exited.
        void killPty(conv.sessionId).catch(() => {});
      }
    }
    // GC the substores. Approval-store `clearConversation` also routes
    // through maybeResolveTaskApproval so the Review queue isn't stuck on
    // a conversation that no longer exists.
    useAgentApprovalStore.getState().clearConversation(id);
    useAgentPlanStore.getState().clearConversation(id);
    useAgentStreamingStore.getState().clearConversation(id);
    // Best-effort remove persisted file (API mode only)
    if (conv?.mode === "api") {
      deleteConversationFile(id).catch((e) =>
        console.warn("Failed to delete conversation file:", e),
      );
    }
    // Cancel any pending debounced save
    const timer = saveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(id);
    }
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
    }));
  },

  archiveConversation: (id) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = { ...c, archived: true, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  unarchiveConversation: (id) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = { ...c, archived: false, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  projectLabels: loadProjectLabels(),

  setProjectLabel: (projectPath, label) => {
    set((s) => {
      const next = { ...s.projectLabels };
      const trimmed = label.trim();
      if (trimmed) next[projectPath] = trimmed;
      else delete next[projectPath];
      try {
        localStorage.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Best effort.
      }
      return { projectLabels: next };
    });
  },

  cancelActiveConversation: async (id) => {
    try {
      await invoke("cancel_api_agent_session", { sessionId: id });
    } catch (e) {
      console.warn("cancel_api_agent_session failed:", e);
    }
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
        const next: AgentConversation = {
          ...c,
          messages,
          status: "idle",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  changeModel: async (id, newModel) => {
    await changeAgentModel(id, newModel);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = { ...c, model: newModel, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setPlanMode: async (id, enabled) => {
    await tauriSetPlanMode(id, enabled);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, planMode: enabled, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setPermissionMode: async (id, mode) => {
    await tauriSetPermissionMode(id, mode);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, permissionMode: mode, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setApproveWrites: async (id, enabled) => {
    await tauriSetApproveWrites(id, enabled);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, approveWrites: enabled, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setEnabledMcpServerIds: (id, ids) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          enabledMcpServerIds: ids ?? undefined,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  setParentConversation: (childId, parentId) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== childId) return c;
        if (c.parentConversationId === parentId) return c;
        const next: AgentConversation = {
          ...c,
          parentConversationId: parentId,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  addDiffComment: (id, comment) => {
    if (!comment.text.trim()) return;
    const entry: DiffComment = {
      id: generateId("dc"),
      createdAt: Date.now(),
      ...comment,
    };
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          pendingDiffComments: [...(c.pendingDiffComments ?? []), entry],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  removeDiffComment: (id, commentId) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          pendingDiffComments: (c.pendingDiffComments ?? []).filter((d) => d.id !== commentId),
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  clearDiffComments: (id) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        if (!c.pendingDiffComments || c.pendingDiffComments.length === 0) return c;
        const next: AgentConversation = {
          ...c,
          pendingDiffComments: [],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  appendAllowedToolPattern: (id, pattern) => {
    if (!pattern) return;
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const current = c.allowedTools ?? [];
        if (current.includes(pattern)) return c; // dedupe — no-op
        const next: AgentConversation = {
          ...c,
          allowedTools: [...current, pattern],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  forkAndResend: async (id, messageId, newContent) => {
    const text = newContent.trim();
    if (!text) return;
    const state = get();
    const conv = state.conversations.find((c) => c.id === id);
    if (!conv) return;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    // Cancel any in-flight turn before truncating — leftover streams would
    // append to a transcript that no longer matches the model's history.
    if (conv.status === "active") {
      try {
        await state.cancelActiveConversation(id);
      } catch {
        // Best-effort; proceed even if cancel failed.
      }
    }
    if (conv.mode === "api") {
      try {
        await closeApiAgentSession(id);
      } catch {
        // Best-effort; the next send will start a fresh session locally.
      }
      const cleanup = apiConversationCleanup.get(id);
      if (cleanup) {
        cleanup();
        apiConversationCleanup.delete(id);
      }
    }

    // Truncate locally to before the edited user message and detach any
    // live session so sendMessage will spin up a fresh one with the
    // truncated history as resume context.
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          messages: c.messages.slice(0, idx),
          sessionId: null,
          resumeToken: undefined,
          status: "idle",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
    // Fork wipes parked prompts and transient stream state — also wipes any
    // linked task approval since the Review queue would otherwise hang on a
    // turn we just truncated away from. clearConversation on the approval
    // store handles maybeResolveTaskApproval internally.
    useAgentApprovalStore.getState().clearConversation(id);
    useAgentStreamingStore.getState().clearThinking(id);

    // Send the edited content as the next user turn — sendMessage handles
    // session re-establishment for api-mode conversations that lost their
    // live session.
    await get().sendMessage(id, text);
  },

  retryLastTurn: async (id, newModel) => {
    // Truncate messages locally: drop the last assistant message (and any trailing tool outputs).
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const msgs = c.messages.slice();
        // Find last assistant index (from end) and truncate.
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            msgs.length = i;
            break;
          }
        }
        // Append a fresh streaming assistant shell.
        msgs.push({
          id: generateId("msg"),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          isStreaming: true,
        });
        const next = {
          ...c,
          messages: msgs,
          status: "active" as const,
          model: newModel ?? c.model,
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    // Reset transient streaming state — a retry restarts the turn.
    useAgentStreamingStore.getState().clearThinking(id);
    await tauriRetryLastTurn(id, newModel);
    if (updated) scheduleSave(updated);
  },

  saveCheckpoint: async (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return null;
    const payload = JSON.stringify({
      createdAt: new Date().toISOString(),
      messageCount: conv.messages.length,
      messages: conv.messages,
    });
    try {
      return await tauriSaveCheckpoint(id, payload);
    } catch (e) {
      console.warn("Failed to save checkpoint:", e);
      return null;
    }
  },

  listCheckpoints: async (id) => {
    try {
      const raw = await tauriListCheckpoints(id);
      const parsed: Array<{
        id: string;
        createdAt: string;
        messageCount: number;
        messages: AgentMessage[];
      }> = [];
      for (let i = 0; i < raw.length; i++) {
        try {
          const obj = JSON.parse(raw[i]);
          parsed.push({
            id: `chk_${i}`,
            createdAt: obj.createdAt ?? "",
            messageCount:
              obj.messageCount ?? (Array.isArray(obj.messages) ? obj.messages.length : 0),
            messages: Array.isArray(obj.messages) ? obj.messages : Array.isArray(obj) ? obj : [],
          });
        } catch {
          continue;
        }
      }
      return parsed;
    } catch (e) {
      console.warn("Failed to list checkpoints:", e);
      return [];
    }
  },

  restoreCheckpoint: (id, rawJson) => {
    try {
      const obj = JSON.parse(rawJson);
      const messages: AgentMessage[] = Array.isArray(obj)
        ? obj
        : Array.isArray(obj.messages)
          ? obj.messages
          : [];
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const next = {
            ...c,
            messages: messages.map((m) => ({ ...m, isStreaming: false })),
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      }));
      // Snapshot only restores messages; substores hold post-snapshot
      // pending permissions / plan / thinking that would otherwise stick.
      useAgentApprovalStore.getState().clearConversation(id);
      useAgentPlanStore.getState().clearConversation(id);
      useAgentStreamingStore.getState().clearConversation(id);
      if (updated) scheduleSave(updated);
    } catch (e) {
      console.warn("Failed to restore checkpoint:", e);
    }
  },

  exportConversation: async (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return "";
    return await exportConversationMarkdown(
      conv.title,
      conv.model ?? "unknown",
      JSON.stringify(conv.messages),
    );
  },

  appendRawOutput: (conversationId, text) => {
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const newOutput = c.rawOutput + text;
        return {
          ...c,
          rawOutput:
            newOutput.length > MAX_RAW_OUTPUT_SIZE
              ? newOutput.slice(-MAX_RAW_OUTPUT_SIZE)
              : newOutput,
          updatedAt: Date.now(),
        };
      }),
    }));
  },

  /**
   * F1 — re-establish a hydrated conversation. Run when sendMessage is
   * called on an api-mode conversation that's been deserialized from disk
   * but has no live event listeners. Re-attaches the listener block then
   * calls `start_api_agent_session` with the conversation's resumeToken
   * (if any) and `content` as the initial message.
   *
   * Routes around `sendApiAgentMessage` because the Rust side has no
   * record of the session id — calling send before start would 404.
   */
  resumeApiConversation: async (conversationId, content, attachments) => {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv || conv.mode !== "api" || !conv.provider || !conv.model) return;

    failoverGuard.delete(conversationId);

    // Append the user message + a streaming assistant placeholder so the
    // chat UI doesn't go blank between resume click and first chunk.
    const userMsg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    const assistantMsgId = generateId("msg");
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const next: AgentConversation = {
          ...c,
          messages: [
            ...c.messages,
            userMsg,
            {
              id: assistantMsgId,
              role: "assistant",
              content: "",
              timestamp: Date.now(),
              isStreaming: true,
            },
          ],
          status: "active",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);

    try {
      await ensureApiAgentListeners(conversationId);
      const resumeMessages = buildConversationResumeMessages(conv.messages);

      // Phase 2: resolve the live ServerConfig from `serverStore` to pick
      // up the port, keyPath, and pinned host fingerprint — the persisted
      // conversation only stored the display subset (host/user/remotePath).
      // If the server was deleted since the conversation was created we
      // fall back to the stored values; the backend will fail-fast on bad
      // creds, which is the right failure mode.
      let sshConfig: {
        host: string;
        port: number;
        user: string;
        remote_path: string;
        key_path: string | null;
        target_id: string;
        host_fingerprint: string | null;
      } | null = null;
      if (conv.sshTarget) {
        const { useServerStore } = await import("@/stores/serverStore");
        const server = useServerStore.getState().getServer(conv.sshTarget.id);
        sshConfig = {
          host: conv.sshTarget.host,
          port: server?.port ?? 22,
          user: conv.sshTarget.user,
          remote_path: conv.sshTarget.remotePath,
          key_path: server?.keyPath ?? null,
          target_id: conv.sshTarget.id,
          host_fingerprint: server?.hostFingerprint ?? null,
        };
      }

      await startApiAgentSession(
        conversationId,
        conv.provider,
        conv.model,
        conv.projectPath,
        content,
        conv.systemPromptOverride ?? null,
        conv.thinkingEnabled ?? false,
        attachments ?? undefined,
        conv.planMode ?? false,
        sshConfig,
        conv.allowedTools ?? null,
        conv.resumeToken ?? null,
        conv.enabledMcpServerIds ?? null,
        resumeMessages,
        conv.permissionMode ?? "auto",
        conv.approveWrites ?? false,
        apiAgentCommandPath(conv.agent),
      );
    } catch (e) {
      console.warn("resumeApiConversation failed:", e);
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, status: "failed", updatedAt: Date.now() } : c,
        ),
      }));
    }
  },
}));

/** One-time pass over hydrated conversations: any conversation with
 * status === "done" that has been idle longer than the Agents settings
 * threshold and isn't already archived gets auto-archived. Mutates `conv` in
 * place and returns whether it changed (so callers can re-persist). */
function maybeAutoArchive(conv: AgentConversation): boolean {
  if (conv.archived) return false;
  if (conv.status !== "done") return false;
  const autoArchiveIdleMs = getAgentAutoArchiveIdleMs();
  if (autoArchiveIdleMs === null) return false;
  if (conv.updatedAt >= Date.now() - autoArchiveIdleMs) return false;
  conv.archived = true;
  return true;
}

// Hydrate persisted API conversations on module load.
// Reset runtime-only fields so we don't resume mid-stream after a cold start.
loadConversations()
  .then((rawList) => {
    const parsed: AgentConversation[] = [];
    for (const raw of rawList) {
      try {
        const conv = JSON.parse(raw) as AgentConversation;
        if (conv.mode !== "api") continue; // PTY sessions died with the app
        // Auto-archive long-idle done conversations BEFORE we coerce status to
        // "idle" below. Persist the change so the archive flag survives the
        // next cold start.
        if (maybeAutoArchive(conv)) {
          saveConversation(conv.id, JSON.stringify(conv)).catch((e) => {
            console.warn("Failed to persist auto-archive:", conv.id, e);
          });
        }
        conv.status = "idle";
        conv.messages = (conv.messages ?? []).map((m) => ({ ...m, isStreaming: false }));
        conv.queuedMessages = [];
        // Push persisted plan/spec state into the plan substore — it is the
        // runtime source of truth. The conversation's own copies are kept
        // for back-compat with code that hasn't migrated yet but the live
        // UI reads from the store.
        useAgentPlanStore.getState().hydrateConversation(conv.id, {
          spec: conv.spec,
          specStage: conv.specStage,
          plan: conv.plan,
          planApproved: conv.planApproved,
        });
        // Drop ephemeral fields so the in-memory record matches the new
        // substore-driven shape. These were already cleared pre-split.
        delete conv.pendingPermissions;
        delete conv.pendingEdits;
        delete conv.thinkingStream;
        delete conv.subAgentTokens;
        parsed.push(conv);
      } catch (e) {
        console.warn("Skipping malformed conversation:", e);
      }
    }
    if (parsed.length > 0) {
      useAgentTaskStore.setState((state) => ({
        conversations: [...parsed, ...state.conversations],
      }));
    }
  })
  .catch((e) => console.warn("Failed to hydrate conversations:", e));
