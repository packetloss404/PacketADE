import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { createPtySession, writePty, killPty } from "@/lib/tauri";
import { ptyOutputEvent, ptyExitEvent } from "@/lib/events";
import { generateId } from "@/lib/storage";
import type { GitHubRepo } from "@/types/github";
import type { AgentConversation, AgentMessage, AgentToolCall } from "@/types/agent-conversation";

export type AgentCli = "claude-code" | "codex" | "gemini" | "opencode";
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

/** CLI command names for each agent */
const CLI_COMMANDS: Record<AgentCli, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

/** Bypass-permissions flags for autonomous execution */
const BYPASS_FLAGS: Record<AgentCli, string | null> = {
  "claude-code": "--dangerously-skip-permissions",
  codex: "--full-auto",
  gemini: "--yolo",
  opencode: "--dangerously-skip-permissions",
};

export type AgentInputMode = "build" | "plan";

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

/** Maximum number of conversations visible in panes simultaneously */
const MAX_ACTIVE_CONVERSATIONS = 4;

interface AgentTaskStore {
  // --- Existing task state ---
  tasks: AgentTask[];
  selectedTaskId: string | null;
  selectedRepo: string | null;
  inputMode: AgentInputMode;
  agentInputText: string;
  selectedServerId: string | null;

  // --- Conversation state ---
  conversations: AgentConversation[];
  activeConversationIds: string[];
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
  sendMessage: (conversationId: string, content: string) => void;
  addAssistantMessage: (conversationId: string, content: string, toolCalls?: AgentToolCall[]) => void;
  updateAssistantMessage: (conversationId: string, messageId: string, content: string) => void;
  setActiveConversations: (ids: string[]) => void;
  addToActiveConversations: (id: string) => void;
  removeFromActiveConversations: (id: string) => void;
  deleteConversation: (id: string) => void;
  appendRawOutput: (conversationId: string, text: string) => void;
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
  activeConversationIds: [],
  selectedConversationId: null,

  launchTask: async (title, description, agent, projectPath) => {
    const id = generateId("agt");
    const command = CLI_COMMANDS[agent];
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
    const command = CLI_COMMANDS[agent];
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
    };

    set((s) => ({
      conversations: [conversation, ...s.conversations],
      selectedConversationId: id,
      activeConversationIds: [id, ...s.activeConversationIds].slice(0, MAX_ACTIVE_CONVERSATIONS),
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

  sendMessage: (conversationId, content) => {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv || !conv.sessionId) return;

    const msg: AgentMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now(), status: "active" }
          : c
      ),
    }));

    void writePty(conv.sessionId, content + "\r");
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

  setActiveConversations: (ids) => {
    set({ activeConversationIds: ids.slice(0, MAX_ACTIVE_CONVERSATIONS) });
  },

  addToActiveConversations: (id) => {
    set((s) => {
      if (s.activeConversationIds.includes(id)) return s;
      return {
        activeConversationIds: [...s.activeConversationIds, id].slice(0, MAX_ACTIVE_CONVERSATIONS),
        selectedConversationId: id,
      };
    });
  },

  removeFromActiveConversations: (id) => {
    set((s) => ({
      activeConversationIds: s.activeConversationIds.filter((cid) => cid !== id),
      selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
    }));
  },

  deleteConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (conv?.sessionId && (conv.status === "active" || conv.status === "idle")) {
      void killPty(conv.sessionId).catch(() => {});
    }
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeConversationIds: s.activeConversationIds.filter((cid) => cid !== id),
      selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
    }));
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
}));
