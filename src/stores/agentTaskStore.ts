import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { createPtySession, writePty, killPty } from "@/lib/tauri";
import { ptyOutputEvent, ptyExitEvent } from "@/lib/events";
import { generateId } from "@/lib/storage";

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

interface AgentTaskStore {
  tasks: AgentTask[];
  selectedTaskId: string | null;

  launchTask: (title: string, description: string, agent: AgentCli, projectPath: string) => Promise<string>;
  cancelTask: (id: string) => void;
  deleteTask: (id: string) => void;
  selectTask: (id: string | null) => void;
  appendOutput: (id: string, text: string) => void;
  completeTask: (id: string, exitCode: number | null) => void;
}

export const useAgentTaskStore = create<AgentTaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,

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
}));
