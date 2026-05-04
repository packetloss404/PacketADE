import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  createPtySession,
  writePty,
  killPty,
  startApiAgentSession,
  sendApiAgentMessage,
  cancelApiAgentSession,
  cancelPendingTools as tauriCancelPendingTools,
  closeApiAgentSession,
  saveConversation,
  loadConversations,
  deleteConversationFile,
  changeAgentModel,
  setPlanMode as tauriSetPlanMode,
  setPermissionMode as tauriSetPermissionMode,
  respondPermission as tauriRespondPermission,
  setApproveWrites as tauriSetApproveWrites,
  respondEdit as tauriRespondEdit,
  retryLastTurn as tauriRetryLastTurn,
  saveCheckpoint as tauriSaveCheckpoint,
  listCheckpoints as tauriListCheckpoints,
  exportConversationMarkdown,
  type ImageAttachment,
} from "@/lib/tauri";
import type { SshTarget } from "@/types/ssh";
import {
  ptyOutputEvent,
  ptyExitEvent,
  apiAgentChunkEvent,
  apiAgentToolStartEvent,
  apiAgentToolResultEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
  apiAgentThinkingEvent,
  apiAgentThinkingStopEvent,
  apiAgentPermissionRequestEvent,
  apiAgentPendingEditEvent,
  apiAgentPlanBlockEvent,
  apiAgentToolOutputExtendedEvent,
  apiAgentTurnSummaryEvent,
} from "@/lib/events";
import { generateId } from "@/lib/storage";
import { useMemoryStore } from "@/stores/memoryStore";
import { loadAgentsMd } from "@/lib/agentsMd";
import { looksLikeRateLimit, pickFailoverModel } from "@/lib/autoFailover";
import type { GitHubRepo } from "@/types/github";
import type {
  AgentConversation,
  AgentMessage,
  AgentPlanItem,
  AgentToolCall,
  PermissionMode,
  PendingPermission,
  PendingEdit,
} from "@/types/agent-conversation";

/** Debounced save: per-conversation timers so rapid streaming events coalesce. */
const SAVE_DEBOUNCE_MS = 500;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(conv: AgentConversation): void {
  if (conv.mode !== "api") return; // only persist API conversations
  const existing = saveTimers.get(conv.id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    saveTimers.delete(conv.id);
    saveConversation(conv.id, JSON.stringify(conv)).catch((e) => {
      console.warn("Failed to save conversation:", conv.id, e);
    });
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(conv.id, handle);
}

export type AgentCli =
  | "claude-code"
  | "codex"
  | "gemini"
  | "opencode"
  | "api-claude-oauth"
  | "api-claude"
  | "api-openai-codex"
  | "api-openai"
  | "api-minimax"
  | "api-openrouter"
  | "api-ollama";

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
    "api-openai": "openai",
    "api-minimax": "minimax",
    "api-openrouter": "openrouter",
    "api-ollama": "ollama",
  };
  return map[agent] ?? "anthropic";
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

/** CLI command names for PTY-based agents (API agents don't use CLI commands) */
const CLI_COMMANDS: Partial<Record<AgentCli, string>> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

/** Bypass-permissions flags for autonomous execution.
 * OpenCode is intentionally omitted — it has no equivalent launch flag and
 * passing one makes it print `--help` and exit. */
const BYPASS_FLAGS: Partial<Record<AgentCli, string>> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  gemini: "--yolo",
};

export type AgentInputMode = "build" | "plan";

/** Cleanup functions for API conversation event listeners. */
const apiConversationCleanup = new Map<string, () => void>();

/** Per-conversation guard so auto-failover never loops. Cleared whenever
 * the user sends a fresh user turn; replenished on a successful turn. */
const failoverGuard = new Set<string>();

/** Derive a display name for a projectPath (e.g. "owner/repo" or last two segments). */
export function repoDisplayName(projectPath: string, githubRepos: GitHubRepo[]): string {
  const segments = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folderName = segments[segments.length - 1] ?? projectPath;
  const match = githubRepos.find((r) => r.name === folderName);
  if (match) return match.full_name;
  if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return folderName;
}

/** Max conversation raw output buffer (256 KB) */
const MAX_RAW_OUTPUT_SIZE = 256 * 1024;

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
  launchTask: (title: string, description: string, agent: AgentCli, projectPath: string) => Promise<string>;
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
    sshTarget?: SshTarget | null,
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
  ) => Promise<string>;
  sendMessage: (
    conversationId: string,
    content: string,
    attachments?: ImageAttachment[] | null,
  ) => void;
  addAssistantMessage: (conversationId: string, content: string, toolCalls?: AgentToolCall[]) => void;
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
  respondPermission: (id: string, toolId: string, decision: "allow_once" | "allow_always" | "deny") => Promise<void>;
  respondEdit: (
    id: string,
    toolId: string,
    decision: "apply" | "reject",
    mergedContent?: string,
  ) => Promise<void>;
  /** F8: drain every parked permission/edit prompt as denied without
   * killing the session. Optimistically clears the local pendingPermissions
   * and pendingEdits arrays — there is no echo event from the backend. */
  cancelPendingTools: (id: string) => Promise<void>;
  /** F9: set the per-conversation MCP server filter. null = all enabled
   * (back-compat). [] = explicitly none. Applies on next session start —
   * the sidecar protocol has no mid-session MCP swap. */
  setEnabledMcpServerIds: (id: string, ids: string[] | null) => void;
  /** F10: replace the conversation's spec criteria (draft state). */
  setSpec: (id: string, criteria: string[]) => void;
  /** F10: lock the spec and ask the agent for a Plan. Posts a synthetic
   * user turn telling the model to produce a TodoWrite covering each
   * criterion. */
  approveSpec: (id: string) => void;
  /** F10: approve the model's plan and start execution. Lifts plan mode
   * and posts a "Plan approved — execute" user turn. */
  approvePlan: (id: string) => void;
  retryLastTurn: (id: string, newModel?: string) => Promise<void>;
  saveCheckpoint: (id: string) => Promise<string | null>;
  listCheckpoints: (id: string) => Promise<Array<{ id: string; createdAt: string; messageCount: number; messages: AgentMessage[] }>>;
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
 * Type alias for zustand's `set` so the listener installer can read the
 * same arg as the store actions. Avoids exporting the store internals
 * just to give the helper a type.
 */
type StoreSet = typeof useAgentTaskStore.setState;

/**
 * Install the full set of `api-agent:*` event listeners for a session and
 * register a cleanup fn in `apiConversationCleanup`. Idempotent — if a
 * cleanup is already registered, this is a no-op (returns immediately).
 *
 * Pulled out of the inline createApiConversation block (F1) so the resume
 * path can reuse the exact same wiring instead of forking it.
 */
async function installApiAgentListeners(
  id: string,
  get: () => AgentTaskStore,
  set: StoreSet,
): Promise<void> {
  if (apiConversationCleanup.has(id)) return;

  const chunkUnlisten = await listen<string>(apiAgentChunkEvent(id), (event) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (m.isStreaming && m.role === "assistant") {
            return { ...m, content: m.content + event.payload };
          }
          return m;
        });
        const next = { ...c, messages, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  });

  const toolStartUnlisten = await listen<{ id: string; name: string }>(
    apiAgentToolStartEvent(id),
    (event) => {
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = c.messages.map((m) => {
            if (m.isStreaming && m.role === "assistant") {
              const toolCalls: AgentToolCall[] = [
                ...(m.toolCalls ?? []),
                {
                  id: event.payload.id,
                  name: event.payload.name,
                  status: "running" as const,
                },
              ];
              return { ...m, toolCalls };
            }
            return m;
          });
          const next = { ...c, messages, updatedAt: Date.now() };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
    },
  );

  const toolResultUnlisten = await listen<{
    id: string;
    name: string;
    content: string;
    is_error: boolean;
    input: string;
  }>(apiAgentToolResultEvent(id), (event) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (m.isStreaming && m.role === "assistant" && m.toolCalls) {
            const toolCalls = m.toolCalls.map((tc) =>
              tc.id === event.payload.id
                ? {
                    ...tc,
                    status: (event.payload.is_error
                      ? "error"
                      : "done") as AgentToolCall["status"],
                    summary: event.payload.content.slice(0, 200),
                    fullContent: event.payload.content,
                    input: event.payload.input,
                  }
                : tc,
            );
            return { ...m, toolCalls };
          }
          return m;
        });
        const next = { ...c, messages, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  });

  const doneUnlisten = await listen<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    resume_token?: string | null;
  }>(apiAgentDoneEvent(id), (event) => {
    let updated: AgentConversation | undefined;
    let nextQueued: string | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) =>
          m.isStreaming
            ? {
                ...m,
                isStreaming: false,
                inputTokens: event.payload.input_tokens,
                outputTokens: event.payload.output_tokens,
                cacheReadTokens: event.payload.cache_read_input_tokens,
                cacheWriteTokens: event.payload.cache_creation_input_tokens,
              }
            : m,
        );
        const queued = c.queuedMessages ?? [];
        let remainingQueued = queued;
        if (queued.length > 0) {
          nextQueued = queued[0];
          remainingQueued = queued.slice(1);
        }
        const newResume = event.payload.resume_token ?? c.resumeToken;
        const next: AgentConversation = {
          ...c,
          messages,
          status: "idle",
          updatedAt: Date.now(),
          queuedMessages: remainingQueued,
          resumeToken: newResume ?? undefined,
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
    if (nextQueued !== undefined) {
      const drained = nextQueued;
      setTimeout(() => {
        get().sendMessage(id, drained);
      }, 0);
    }
    if (updated && get().selectedConversationId !== id) {
      const finishedTitle = updated.title;
      void import("@/lib/notifications").then(({ notifyConversationDone }) => {
        void notifyConversationDone(finishedTitle);
      });
    }
  });

  const errorUnlisten = await listen<{ message: string }>(
    apiAgentErrorEvent(id),
    (event) => {
      const conv = get().conversations.find((c) => c.id === id);
      if (
        conv &&
        conv.mode === "api" &&
        conv.model &&
        !failoverGuard.has(id) &&
        looksLikeRateLimit(event.payload.message)
      ) {
        const fallback = pickFailoverModel(conv.model);
        if (fallback && fallback !== conv.model) {
          failoverGuard.add(id);
          const noticeMsg: AgentMessage = {
            id: generateId("msg"),
            role: "system",
            content: `(auto-failover: ${conv.model} hit "${event.payload.message.slice(0, 80)}" — retrying on ${fallback})`,
            timestamp: Date.now(),
          };
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === id
                ? {
                    ...c,
                    messages: [...c.messages, noticeMsg],
                    updatedAt: Date.now(),
                  }
                : c,
            ),
          }));
          void get().retryLastTurn(id, fallback);
          return;
        }
      }

      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const messages = c.messages.map((m) =>
            m.isStreaming
              ? {
                  ...m,
                  isStreaming: false,
                  content: m.content + `\n\nError: ${event.payload.message}`,
                }
              : m,
          );
          const next = {
            ...c,
            messages,
            status: "failed" as const,
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
      if (updated) {
        const failedTitle = `Failed: ${updated.title}`;
        void import("@/lib/notifications").then(({ notifyConversationDone }) => {
          void notifyConversationDone(failedTitle);
        });
      }
    },
  );

  const thinkingUnlisten = await listen<{ text: string }>(
    apiAgentThinkingEvent(id),
    (event) => {
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const nextStream = (c.thinkingStream ?? "") + event.payload.text;
          const messages = c.messages.map((m) =>
            m.isStreaming && m.role === "assistant"
              ? { ...m, thinking: (m.thinking ?? "") + event.payload.text }
              : m,
          );
          const next = {
            ...c,
            messages,
            thinkingStream: nextStream,
            updatedAt: Date.now(),
          };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
    },
  );

  const thinkingStopUnlisten = await listen<unknown>(
    apiAgentThinkingStopEvent(id),
    () => {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, thinkingStream: "" } : c,
        ),
      }));
    },
  );

  const permissionReqUnlisten = await listen<PendingPermission>(
    apiAgentPermissionRequestEvent(id),
    (event) => {
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const pending = [...(c.pendingPermissions ?? []), event.payload];
          const next = { ...c, pendingPermissions: pending, updatedAt: Date.now() };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
    },
  );

  const pendingEditUnlisten = await listen<PendingEdit>(
    apiAgentPendingEditEvent(id),
    (event) => {
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const pending = [...(c.pendingEdits ?? []), event.payload];
          const next = { ...c, pendingEdits: pending, updatedAt: Date.now() };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
    },
  );

  const planBlockUnlisten = await listen<{ items: AgentPlanItem[] }>(
    apiAgentPlanBlockEvent(id),
    (event) => {
      let updated: AgentConversation | undefined;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== id) return c;
          const next = { ...c, plan: event.payload.items, updatedAt: Date.now() };
          updated = next;
          return next;
        }),
      }));
      if (updated) scheduleSave(updated);
    },
  );

  // F6: live token totals between turns. Update the streaming assistant
  // message's tokens so SessionHealthBar / cost pills reflect mid-stream
  // usage instead of waiting for the final `done` payload.
  const turnSummaryUnlisten = await listen<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>(apiAgentTurnSummaryEvent(id), (event) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) =>
          m.isStreaming && m.role === "assistant"
            ? {
                ...m,
                inputTokens: event.payload.input_tokens,
                outputTokens: event.payload.output_tokens,
                cacheReadTokens: event.payload.cache_read_input_tokens,
                cacheWriteTokens: event.payload.cache_creation_input_tokens,
              }
            : m,
        );
        const next = { ...c, messages, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  });

  // F5: structured tool metadata — exit code / modified paths / stdout /
  // stderr — arrives after the matching tool_result. Merge into the
  // already-rendered tool call so the chat surface can show exit code etc.
  const toolOutputExtendedUnlisten = await listen<{
    id: string;
    exit_code?: number | null;
    modified_paths?: string[] | null;
    stdout?: string | null;
    stderr?: string | null;
  }>(apiAgentToolOutputExtendedEvent(id), (event) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const messages = c.messages.map((m) => {
          if (!m.toolCalls) return m;
          let touched = false;
          const toolCalls = m.toolCalls.map((tc) => {
            if (tc.id !== event.payload.id) return tc;
            touched = true;
            return {
              ...tc,
              exitCode: event.payload.exit_code ?? tc.exitCode,
              modifiedPaths:
                event.payload.modified_paths ?? tc.modifiedPaths,
              stdout: event.payload.stdout ?? tc.stdout,
              stderr: event.payload.stderr ?? tc.stderr,
            };
          });
          return touched ? { ...m, toolCalls } : m;
        });
        const next = { ...c, messages, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  });

  apiConversationCleanup.set(id, () => {
    chunkUnlisten();
    toolStartUnlisten();
    toolResultUnlisten();
    doneUnlisten();
    errorUnlisten();
    thinkingUnlisten();
    thinkingStopUnlisten();
    permissionReqUnlisten();
    pendingEditUnlisten();
    planBlockUnlisten();
    toolOutputExtendedUnlisten();
    turnSummaryUnlisten();
  });
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
    const command = CLI_COMMANDS[agent];
    if (!command) return id; // API agents don't use PTY tasks
    const args: string[] = [];

    const bypassFlag = BYPASS_FLAGS[agent];
    if (bypassFlag) args.push(bypassFlag);

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
      const sessionId = await createPtySession(projectPath, 120, 40, command, args.length > 0 ? args : null);

      // Store the session ID
      set((s) => ({
        tasks: s.tasks.map((t) => t.id === id ? { ...t, sessionId } : t),
      }));

      // Listen for output
      const outputUnlisten = await listen<string>(ptyOutputEvent(sessionId), (event) => {
        get().appendOutput(id, event.payload);
      });

      // Listen for exit
      listen<string>(ptyExitEvent(sessionId), () => {
        outputUnlisten();
        get().completeTask(id, 0);
      });

      // Send the task description as the initial prompt after a brief delay
      // (Claude is ready immediately; other CLIs need time to init)
      const delay = agent === "claude-code" ? 500 : 3000;
      setTimeout(() => {
        void writePty(sessionId, description + "\r");
      }, delay);
    } catch (err) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, status: "failed", completedAt: Date.now(), output: t.output + `\nFailed to start: ${err}` } : t
        ),
      }));
    }

    return id;
  },

  cancelTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || task.status !== "running" || !task.sessionId) return;

    void killPty(task.sessionId).catch(() => {});
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, status: "cancelled", completedAt: Date.now() } : t
      ),
    }));
  },

  deleteTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (task?.status === "running" && task.sessionId) {
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
          output: newOutput.length > MAX_OUTPUT_SIZE
            ? newOutput.slice(-MAX_OUTPUT_SIZE)
            : newOutput,
        };
      }),
    }));
  },

  completeTask: (id, exitCode) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === "running"
          ? { ...t, status: exitCode === 0 ? "done" : "failed", completedAt: Date.now(), exitCode }
          : t
      ),
    }));
  },

  // ─── Conversation actions ────────────────────────────────────────────

  createConversation: async (agent, projectPath) => {
    const id = generateId("conv");
    const command = CLI_COMMANDS[agent as keyof typeof CLI_COMMANDS];
    if (!command) return id; // API agents should use createApiConversation
    const args: string[] = [];

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
      const sessionId = await createPtySession(projectPath, 120, 40, command, args.length > 0 ? args : null);

      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, sessionId } : c
        ),
      }));

      // Listen for PTY output
      const outputUnlisten = await listen<string>(ptyOutputEvent(sessionId), (event) => {
        get().appendRawOutput(id, event.payload);
      });

      // Listen for PTY exit
      listen<string>(ptyExitEvent(sessionId), () => {
        outputUnlisten();
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, status: "done", updatedAt: Date.now() } : c
          ),
        }));
      });
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
            : c
        ),
      }));
    }

    return id;
  },

  createApiConversation: async (agent, projectPath, model, initialMessage, systemPromptOverride, thinkingEnabled, planMode, sshTarget, explicitId, skipBackendStart, allowedTools, memoryContextEnabled, attachments, enabledMcpServerIds) => {
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
      const memoryContext = useMemoryStore
        .getState()
        .getContextForSession(projectPath);
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
        effectiveSystemPrompt = `## Project guidance (from AGENTS.md / CLAUDE.md)\n\n${agentsMd}\n\n---\n\n${base}`;
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
      permissionMode: "auto",
      approveWrites: false,
      pendingPermissions: [],
      pendingEdits: [],
      thinkingEnabled: thinkingEnabled ?? false,
      thinkingStream: "",
      sshTarget: sshTarget
        ? {
            id: sshTarget.id,
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
            : c
        ),
      }));

      await installApiAgentListeners(id, get, set);


      // Start the API agent session unless the caller already did so.
      if (!skipBackendStart) {
        const sshConfig = sshTarget
          ? {
              host: sshTarget.host,
              port: sshTarget.port,
              user: sshTarget.user,
              remote_path: sshTarget.remotePath,
              key_path: sshTarget.keyPath ?? null,
              target_id: sshTarget.id,
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
        );
      }
    } catch {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id
            ? { ...c, status: "failed", updatedAt: Date.now() }
            : c
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

    // F1: hydrated API conversations have no live listeners — route the
    // first send-after-restart through the resume path so the Rust side
    // re-creates the session before the message arrives.
    if (
      conv.mode === "api" &&
      !apiConversationCleanup.has(conversationId)
    ) {
      void get().resumeApiConversation(conversationId, content, attachments);
      return;
    }

    // If the agent is still running (API mode), queue the message and show a queued bubble.
    const isRunning =
      conv.mode === "api" &&
      conv.status === "active" &&
      conv.messages.some((m) => m.isStreaming);

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
            : c
        ),
      }));

      void sendApiAgentMessage(
        conversationId,
        content,
        attachments ?? undefined,
      ).catch(() => {
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, status: "failed", updatedAt: Date.now() }
              : c
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
          : c
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
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, content } : m
              ),
            }
          : c
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
        void cancelApiAgentSession(id).catch(() => {});
        void closeApiAgentSession(id).catch(() => {});
        const cleanup = apiConversationCleanup.get(id);
        if (cleanup) {
          cleanup();
          apiConversationCleanup.delete(id);
        }
      } else if (conv.sessionId) {
        void killPty(conv.sessionId).catch(() => {});
      }
    }
    // Best-effort remove persisted file (API mode only)
    if (conv?.mode === "api") {
      deleteConversationFile(id).catch((e) => console.warn("Failed to delete conversation file:", e));
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

  projectLabels: ((): Record<string, string> => {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem("packetcode:project-labels");
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  })(),

  setProjectLabel: (projectPath, label) => {
    set((s) => {
      const next = { ...s.projectLabels };
      const trimmed = label.trim();
      if (trimmed) next[projectPath] = trimmed;
      else delete next[projectPath];
      try {
        localStorage.setItem("packetcode:project-labels", JSON.stringify(next));
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
        const messages = c.messages.map((m) =>
          m.isStreaming ? { ...m, isStreaming: false } : m
        );
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

  respondPermission: async (id, toolId, decision) => {
    await tauriRespondPermission(id, toolId, decision);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const pending = (c.pendingPermissions ?? []).filter((p) => p.id !== toolId);
        const next = { ...c, pendingPermissions: pending, updatedAt: Date.now() };
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

  setSpec: (id, criteria) => {
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          spec: { criteria, status: "draft", updatedAt: Date.now() },
          specStage: c.specStage ?? "spec",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
  },

  approveSpec: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || !conv.spec || conv.spec.criteria.length === 0) return;
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          spec: { ...c.spec!, status: "approved", updatedAt: Date.now() },
          specStage: "plan",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
    // Synthesize a user turn requesting the structured plan.
    const bullets = conv.spec.criteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
    const prompt =
      `Spec approved. Success criteria:\n${bullets}\n\n` +
      `Now produce a Plan via TodoWrite covering each criterion. ` +
      `Stop after the plan — wait for user approval before executing.`;
    get().sendMessage(id, prompt);
  },

  approvePlan: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          planApproved: true,
          specStage: "code",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
    // Lift plan mode if it was on (the launcher's Plan mode set it on
    // start) and tell the model to execute.
    if (conv.planMode) {
      void get().setPlanMode(id, false);
    }
    get().sendMessage(
      id,
      "Plan approved. Execute step-by-step, marking TodoWrite items as you complete them.",
    );
  },

  cancelPendingTools: async (id) => {
    // Optimistic UI clear — backend has no echo event.
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const next: AgentConversation = {
          ...c,
          pendingPermissions: [],
          pendingEdits: [],
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
    try {
      await tauriCancelPendingTools(id);
    } catch (e) {
      console.warn("cancelPendingTools failed:", e);
    }
  },

  respondEdit: async (id, toolId, decision, mergedContent) => {
    await tauriRespondEdit(id, toolId, decision, mergedContent);
    let updated: AgentConversation | undefined;
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        const pending = (c.pendingEdits ?? []).filter((p) => p.id !== toolId);
        const next = { ...c, pendingEdits: pending, updatedAt: Date.now() };
        updated = next;
        return next;
      }),
    }));
    if (updated) scheduleSave(updated);
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
          thinkingStream: "",
          updatedAt: Date.now(),
        };
        updated = next;
        return next;
      }),
    }));
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
      const parsed: Array<{ id: string; createdAt: string; messageCount: number; messages: AgentMessage[] }> = [];
      for (let i = 0; i < raw.length; i++) {
        try {
          const obj = JSON.parse(raw[i]);
          parsed.push({
            id: `chk_${i}`,
            createdAt: obj.createdAt ?? "",
            messageCount: obj.messageCount ?? (Array.isArray(obj.messages) ? obj.messages.length : 0),
            messages: Array.isArray(obj.messages) ? obj.messages : (Array.isArray(obj) ? obj : []),
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
      const messages: AgentMessage[] = Array.isArray(obj) ? obj : (Array.isArray(obj.messages) ? obj.messages : []);
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
          rawOutput: newOutput.length > MAX_RAW_OUTPUT_SIZE
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
      await installApiAgentListeners(conversationId, get, set);

      const sshConfig = conv.sshTarget
        ? {
            host: conv.sshTarget.host,
            port: 22,
            user: conv.sshTarget.user,
            remote_path: conv.sshTarget.remotePath,
            key_path: null,
            target_id: conv.sshTarget.id,
          }
        : null;

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
      );
    } catch (e) {
      console.warn("resumeApiConversation failed:", e);
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, status: "failed", updatedAt: Date.now() }
            : c,
        ),
      }));
    }
  },
}));

/** Idle threshold (14 days) for auto-archiving completed conversations. */
const AUTO_ARCHIVE_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/** One-time pass over hydrated conversations: any conversation with
 * status === "done" that has been idle longer than AUTO_ARCHIVE_IDLE_MS and
 * isn't already archived gets auto-archived. Mutates `conv` in place and
 * returns whether it changed (so callers can re-persist). */
function maybeAutoArchive(conv: AgentConversation): boolean {
  if (conv.archived) return false;
  if (conv.status !== "done") return false;
  if (conv.updatedAt >= Date.now() - AUTO_ARCHIVE_IDLE_MS) return false;
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
        conv.pendingPermissions = [];
        conv.pendingEdits = [];
        conv.thinkingStream = "";
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
