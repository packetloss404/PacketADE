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
  deleteConversationFile,
  changeAgentModel,
  setPlanMode as tauriSetPlanMode,
  setPermissionMode as tauriSetPermissionMode,
  setApproveWrites as tauriSetApproveWrites,
  retryLastTurn as tauriRetryLastTurn,
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
  /** ServerConfig auth method. Remote sidecar sessions need this so stale
   *  saved passwords do not force password-auth when the server now uses key
   *  or SSH-agent auth. */
  authMethod?: "agent" | "key" | "password" | null;
  /** Pinned SHA256 host-key fingerprint, copied from
   *  `ServerConfig.hostFingerprint`. Forwarded to the backend so strict
   *  host-key checking applies. */
  hostFingerprint?: string | null;
}
import { ptyOutputEvent, ptyExitEvent } from "@/lib/events";
import { generateId } from "@/lib/storage";
import { LEGACY_STORAGE_PREFIX, storageKey } from "@/lib/brand";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAgentStore } from "@/stores/agentStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useAgentStreamingStore } from "@/stores/agentStreamingStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useAgentDraftStore } from "@/stores/agentDraftStore";
import { useCliOverrideStore } from "@/stores/cliOverrideStore";
import { assertCostGuardrailsAllowLaunch } from "@/stores/costGuardrailStore";
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
import {
  scheduleSave,
  requestConversationSave,
  cancelPendingSave,
  hydrateConversations,
} from "@/stores/agentConversationPersistence";

// `requestConversationSave` was historically defined here; re-export it so
// external importers (apiAgentListeners, agentPlanStore, slashCommandHandlers,
// …) keep importing it from `@/stores/agentTaskStore` unchanged after the
// persistence helpers moved to their sibling module.
export { requestConversationSave };

/** Centralized turn-failure unwind. Marks the conversation `failed`, and —
 * when a streaming placeholder id is given — flips that message's
 * `isStreaming` off and appends the error text so the assistant bubble can't
 * spin forever. Shared by createApiConversation / retryLastTurn /
 * resumeApiConversation catches and the promoted-queued send failure path,
 * which previously hand-rolled this (and sometimes forgot to clear the
 * placeholder, leaving a stuck spinner). */
export function failTurn(
  conversationId: string,
  streamingMessageId: string | null,
  error: unknown,
): void {
  let failed: AgentConversation | undefined;
  useAgentTaskStore.setState((s) => ({
    conversations: s.conversations.map((c) => {
      if (c.id !== conversationId) return c;
      const messages =
        streamingMessageId !== null
          ? c.messages.map((m) =>
              m.id === streamingMessageId
                ? { ...m, isStreaming: false, content: m.content + `\n\nError: ${error}` }
                : m,
            )
          : c.messages;
      const next: AgentConversation = {
        ...c,
        messages,
        status: "failed",
        updatedAt: Date.now(),
      };
      failed = next;
      return next;
    }),
  }));
  if (failed) scheduleSave(failed);
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
  | "api-minimax-api"
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
  | "api-minimax-api"
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
    "api-minimax-api": "minimax-api",
    "api-openrouter": "openrouter",
    "api-ollama": "ollama",
  };
  const provider = map[agent];
  if (!provider) {
    // A missing entry means a new ApiAgentCli was added without updating this
    // map, or a malformed/legacy `api-*` agent was hydrated from disk. Silently
    // defaulting to Anthropic mis-bills against the wrong credentials, so log
    // it so the misconfiguration is diagnosable.
    logSwallowed("agentTaskStore.apiAgentProvider")(
      new Error(`Unknown API agent provider for "${agent}" — defaulting to anthropic`),
    );
    return "anthropic";
  }
  return provider;
}

function apiAgentCommandPath(agent: AgentCli): string | null {
  if (agent !== "api-openai-codex") return null;
  const manualPath = useCliOverrideStore.getState().overrides.codex?.manualPath.trim();
  return manualPath || null;
}
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
  // codex >= 0.x dropped `--full-auto`; the full-bypass equivalent is this.
  codex: "--dangerously-bypass-approvals-and-sandbox",
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

/** Named-field options for `createApiConversation`. Replaces the former
 * ~18-positional-arg signature, which was a latent-bug magnet: callers passed
 * unreadable positional sequences and inserting one arg silently shifted every
 * caller. Only `agent`/`projectPath`/`model`/`initialMessage` are required; the
 * rest preserve their previous per-arg defaults when omitted. */
export interface CreateApiConversationOptions {
  agent: AgentCli;
  projectPath: string;
  model: string;
  initialMessage: string;
  systemPromptOverride?: string | null;
  thinkingEnabled?: boolean;
  planMode?: boolean;
  sshTarget?: AgentSshConfigInput | null;
  /** When set, use this id instead of generating a new one. Used by Flight
   * Deck attempts so the conversation id matches the backend session id. */
  explicitId?: string;
  /** When true, skip the start_api_agent_session backend call (the caller
   * has already started it). Used by Flight Deck attempts. */
  skipBackendStart?: boolean;
  /** Restrict the agent to this tool subset (e.g. Scout profile uses
   * read_file/list_directory/grep/web_fetch). Undefined = all tools. */
  allowedTools?: string[] | null;
  /** Inject the memory layer's project context into the system prompt.
   * Default false to preserve existing behavior. */
  memoryContextEnabled?: boolean;
  /** Image attachments inlined with the initial user message. Currently only
   * applied to the in-process LlmProvider path; sidecar Anthropic + Codex
   * ignore them until the protocol bump that wires them through. */
  attachments?: ImageAttachment[] | null;
  /** F9: per-conversation MCP server filter passed to the sidecar at
   * session start. null = all enabled servers. */
  enabledMcpServerIds?: string[] | null;
  /** Initial permission posture for the backend session. Must be supplied
   * before startApiAgentSession so the first turn doesn't race with a
   * post-create permission update. */
  permissionMode?: PermissionMode;
  approveWrites?: boolean;
}

interface AgentTaskStore {
  // --- Composer state ---
  // (Composer draft text lives in agentDraftStore — keyed per conversation,
  // plus a launch slot — so no draft can bleed across composers.)
  selectedRepo: string | null;
  inputMode: AgentInputMode;

  // --- Conversation state ---
  conversations: AgentConversation[];
  selectedConversationId: string | null;

  setSelectedRepo: (repo: string | null) => void;
  setInputMode: (mode: AgentInputMode) => void;

  // --- Conversation actions ---
  createConversation: (agent: AgentCli, projectPath: string) => Promise<string>;
  createApiConversation: (options: CreateApiConversationOptions) => Promise<string>;
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
  retryLastTurn: (id: string, newModel?: string) => Promise<void>;
  /** M2.7 — Cursor-style "edit a prior user message and re-run from there."
   * Truncates the transcript to before the target user message, cancels any
   * active turn, and dispatches the new content as a fresh user turn. The
   * model receives the truncated history on the next send and the agent runs
   * forward from that fork point. File-state rewind isn't part of this v1
   * pass — only the transcript forks. */
  forkAndResend: (id: string, messageId: string, newContent: string) => Promise<void>;
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
  selectedRepo: null,
  inputMode: "build",

  // --- Conversation state ---
  conversations: [],
  selectedConversationId: null,

  setSelectedRepo: (repo) => set({ selectedRepo: repo }),
  setInputMode: (mode) => set({ inputMode: mode }),

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

  createApiConversation: async ({
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
  }) => {
    const id = explicitId ?? generateId("conv");
    const provider = apiAgentProvider(agent);
    const isRemoteConversation = Boolean(sshTarget);
    // Explicit callers (profiles, /new inheritance) always win; otherwise
    // fall back to the Settings-configured default MCP set (null = all
    // non-disabled servers, resolved sidecar-side).
    const resolvedMcpIds =
      enabledMcpServerIds ??
      useAgentSettingsStore.getState().defaultEnabledMcpServerIds ??
      null;

    if (!skipBackendStart) {
      await assertCostGuardrailsAllowLaunch(provider);
    }

    // System-prompt assembly. Order (lowest in the prompt → highest):
    //   1. AGENTS.md / CLAUDE.md from the project root (the de-facto standard
    //      cross-tool instructions file).
    //   2. PacketADE memory layer (learned patterns + recent summaries),
    //      gated on the per-conversation `memoryContextEnabled` flag.
    //   3. Profile / explicit `systemPromptOverride` (lives last so it wins
    //      conflicts of intent — the user picked this profile deliberately).
    let effectiveSystemPrompt: string | null = systemPromptOverride ?? null;

    if (memoryContextEnabled) {
      const memoryBrief = useMemoryStore.getState().composeMemoryBrief(
        sshTarget
          ? {
              kind: "ssh",
              projectPath,
              serverId: sshTarget.serverId,
              remotePath: sshTarget.remotePath,
            }
          : { kind: "local", projectPath },
      );
      if (memoryBrief.text.trim().length > 0) {
        const base = effectiveSystemPrompt ?? "";
        effectiveSystemPrompt = `${memoryBrief.text}\n\n---\n\n${base}`;
      }
    }

    // AGENTS.md prepend — async fetch, best-effort; failures are silent so a
    // missing file never blocks a launch.
    if (!isRemoteConversation) {
      try {
        const agentsMd = await loadAgentsMd(projectPath);
        if (agentsMd) {
          const base = effectiveSystemPrompt ?? "";
          effectiveSystemPrompt = `## Project guidance (from AGENTS.md cascade)\n\n${agentsMd}\n\n---\n\n${base}`;
        }
      } catch {
        // Best-effort; absent file is the common case.
      }
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
      enabledMcpServerIds: resolvedMcpIds ?? undefined,
    };

    set((s) => ({
      conversations: [conversation, ...s.conversations],
      selectedConversationId: id,
    }));

    // Hoisted above the try so the catch can clear streaming on this exact
    // placeholder by id (the backend start may reject before any event fires).
    const assistantMsgId = generateId("msg");
    try {
      // Create a streaming assistant message
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
              auth_method: sshTarget.authMethod ?? null,
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
          resolvedMcpIds,
          null,
          permissionMode ?? "auto",
          approveWrites ?? false,
          apiAgentCommandPath(agent),
        );
      }
    } catch (e) {
      // `startApiAgentSession` rejected before any `api-agent:*` event could
      // fire, so the streaming placeholder would otherwise spin forever.
      // failTurn fails the conversation and clears the specific placeholder.
      logSwallowed("agentTaskStore.createApiConversation")(e);
      failTurn(id, assistantMsgId, e);
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
        void cancelApiAgentSession(id).catch(logSwallowed("agentTaskStore.cancelApiSession"));
        void closeApiAgentSession(id).catch(logSwallowed("agentTaskStore.closeApiSession"));
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
    useEditBaselineStore.getState().clearConversation(id);
    // Drop persisted Viewed marks so the review store's map stays bounded.
    useReviewStore.getState().clearConversation(id);
    // Drop the persisted composer draft so the localStorage map stays bounded.
    useAgentDraftStore.getState().clearDraft(id);
    // Best-effort remove persisted file (API mode only)
    if (conv?.mode === "api") {
      deleteConversationFile(id).catch((e) =>
        console.warn("Failed to delete conversation file:", e),
      );
    }
    // Cancel any pending debounced save
    cancelPendingSave(id);
    // Drop the per-conversation auto-failover guard so the module-scope Set
    // doesn't accumulate a stale entry (and can't mis-fire if the id is reused).
    failoverGuard.delete(id);
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
    // Entering plan mode starts a fresh planning round — re-arm approval so
    // approvePlan's idempotency guard (which kills repeat-click double-sends
    // within a round) can't dead-end a conversation that approved an earlier
    // plan.
    if (enabled) useAgentPlanStore.getState().resetPlanApproval(id);
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
    // The plan substore holds post-restore-point state (TodoWrite checklist,
    // planApproved) that would otherwise survive the rewind as a stale
    // phantom over the truncated transcript. Clear it — PlanPanel falls back
    // to re-deriving any plan still present in the kept prefix from its
    // tool calls.
    useAgentPlanStore.getState().clearConversation(id);

    // Send the edited content as the next user turn — sendMessage handles
    // session re-establishment for api-mode conversations that lost their
    // live session.
    await get().sendMessage(id, text);
  },

  retryLastTurn: async (id, newModel) => {
    // Truncate messages locally: drop the last assistant message (and any trailing tool outputs).
    const retryMsgId = generateId("msg");
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const msgs = c.messages.slice();
        // Find last assistant index (from end) and truncate — but preserve any
        // trailing system messages (e.g. the auto-failover notice the error
        // listener appends after the failed assistant). `msgs.length = i` would
        // otherwise drop them along with the assistant.
        const trailingSystem: AgentMessage[] = [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            msgs.length = i;
            break;
          }
          if (msgs[i].role === "system") trailingSystem.unshift(msgs[i]);
        }
        // Re-append the preserved system notice(s) so the user still sees the
        // failover happened, then a fresh streaming assistant shell.
        for (const sys of trailingSystem) msgs.push(sys);
        msgs.push({
          id: retryMsgId,
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
    try {
      await tauriRetryLastTurn(id, newModel);
    } catch (e) {
      // The backend rejected the retry start (rate limit, session gone,
      // sidecar down) — so no `api-agent:done`/`error` event will ever
      // arrive to clear the streaming shell we just pushed. failTurn fails
      // the conversation and clears that specific shell.
      failTurn(id, retryMsgId, e);
      return;
    }
    if (updated) scheduleSave(updated);
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
        auth_method: "agent" | "key" | "password" | null;
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
          auth_method: server?.authMethod ?? null,
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
      // Clear the streaming placeholder we appended above — no `api-agent:*`
      // event will arrive, so without this the assistant bubble spins forever.
      failTurn(conversationId, assistantMsgId, e);
    }
  },
}));

// Hydrate persisted API conversations on module load. The pass itself lives in
// `agentConversationPersistence` alongside the save helpers; invoked here so the
// load-time trigger still runs after the store is created.
hydrateConversations();
