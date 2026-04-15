import { useMemo } from "react";
import { Zap, ExternalLink, Trash2 } from "lucide-react";
import { useAgentTaskStore, repoDisplayName, type AgentTask, type AgentTaskStatus } from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";

const STATUS_DOT: Record<AgentTaskStatus, string> = {
  running: "bg-accent-green animate-pulse",
  done: "bg-accent-green",
  failed: "bg-accent-red",
  cancelled: "bg-text-muted",
};

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

function formatDuration(startedAt: number, completedAt: number | null): string {
  const end = completedAt ?? Date.now();
  const ms = end - startedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

interface AgentSidebarProps {
  onNewAgent: () => void;
}

export function AgentSidebar({ onNewAgent }: AgentSidebarProps) {
  const tasks = useAgentTaskStore((s) => s.tasks);
  const selectedTaskId = useAgentTaskStore((s) => s.selectedTaskId);
  const selectTask = useAgentTaskStore((s) => s.selectTask);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const deleteTask = useAgentTaskStore((s) => s.deleteTask);
  const repos = useGitHubStore((s) => s.repos);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const tasksByRepo = useMemo(() => {
    const map = new Map<string, AgentTask[]>();
    for (const task of tasks) {
      const key = task.projectPath;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(task);
    }
    return map;
  }, [tasks]);

  function handleTaskClick(task: AgentTask) {
    selectTask(task.id);
    setSelectedRepo(task.projectPath);
  }

  function handleOpenWorkspace() {
    const selectedRepo = useAgentTaskStore.getState().selectedRepo;
    const path = selectedRepo ?? projectPath;
    const workspaces = useWorkspaceStore.getState().workspaces;
    const existing = workspaces.find((w) => w.projectPath === path && w.status === "active");
    if (existing) {
      useWorkspaceStore.getState().setActiveWorkspace(existing.id);
    } else {
      const name = repoDisplayName(path, repos);
      useWorkspaceStore.getState().createWorkspace(name, ["claude-code"], path);
    }
    setActiveView("workspace");
  }

  return (
    <div className="w-[220px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden">
      {/* New Agent button */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewAgent}
          className="flex items-center gap-2 w-full px-3 py-2 text-[11px] font-medium text-accent-green hover:bg-accent-green/10 rounded transition-colors"
        >
          <Zap size={12} />
          New Agent
          <span className="ml-auto text-[9px] text-text-muted">Ctrl+N</span>
        </button>
      </div>

      {/* Future features placeholder */}
      <div className="border-b border-bg-border mx-3 mb-1" />

      {/* Repo-grouped task list */}
      <div className="flex-1 overflow-y-auto px-1">
        {tasksByRepo.size === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <p className="text-[10px]">No agent tasks yet</p>
          </div>
        ) : (
          Array.from(tasksByRepo.entries()).map(([path, repoTasks]) => (
            <RepoGroup
              key={path}
              displayName={repoDisplayName(path, repos)}
              tasks={repoTasks}
              selectedTaskId={selectedTaskId}
              onTaskClick={handleTaskClick}
              onDeleteTask={deleteTask}
            />
          ))
        )}
      </div>

      {/* Open Workspace link */}
      <div className="px-3 py-2 border-t border-bg-border">
        <button
          onClick={handleOpenWorkspace}
          className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
        >
          <ExternalLink size={10} />
          Open Workspace
        </button>
      </div>
    </div>
  );
}

function RepoGroup({
  displayName,
  tasks,
  selectedTaskId,
  onTaskClick,
  onDeleteTask,
}: {
  displayName: string;
  tasks: AgentTask[];
  selectedTaskId: string | null;
  onTaskClick: (task: AgentTask) => void;
  onDeleteTask: (id: string) => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 py-1.5">
        <span className="text-[10px] font-medium text-text-muted">{displayName}</span>
      </div>
      {tasks.map((task) => {
        const selected = task.id === selectedTaskId;
        return (
          <div key={task.id} className="group relative">
            <button
              onClick={() => onTaskClick(task)}
              title={task.title}
              className={`flex items-start gap-2 w-full px-2 py-1.5 text-left rounded transition-colors ${
                selected ? "bg-accent-green/10" : "hover:bg-bg-hover"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${STATUS_DOT[task.status]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className={`text-[11px] truncate flex-1 ${selected ? "text-text-primary" : "text-text-secondary"}`}>
                    {task.title}
                  </span>
                  <span className="text-[9px] text-text-muted shrink-0">
                    {formatDuration(task.startedAt, task.completedAt)}
                  </span>
                </div>
                <span className="text-[9px] text-text-muted">
                  {AGENT_LABELS[task.agent] ?? task.agent}
                </span>
              </div>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
              className="absolute right-1 top-1.5 p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity rounded"
              title="Delete task"
            >
              <Trash2 size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
