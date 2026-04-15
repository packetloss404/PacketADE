import { useMemo, useState } from "react";
import { Zap, ExternalLink, Trash2, Eye, ChevronDown, ChevronRight } from "lucide-react";
import { useAgentTaskStore, repoDisplayName, type AgentTask, type AgentTaskStatus } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";
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

const CONV_STATUS_DOT: Record<AgentConversation["status"], string> = {
  active: "bg-accent-green animate-pulse",
  idle: "bg-accent-green",
  done: "bg-text-muted",
  failed: "bg-accent-red",
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

function formatRelativeTime(timestamp: number): string {
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface AgentSidebarProps {
  onNewAgent: () => void;
}

export function AgentSidebar({ onNewAgent }: AgentSidebarProps) {
  const tasks = useAgentTaskStore((s) => s.tasks);
  const conversations = useAgentTaskStore((s) => s.conversations ?? []);
  const activeConversationIds = useAgentTaskStore((s) => s.activeConversationIds ?? []);
  const addToActiveConversations = useAgentTaskStore((s) => s.addToActiveConversations);
  const deleteConversation = useAgentTaskStore((s) => s.deleteConversation);
  const selectedTaskId = useAgentTaskStore((s) => s.selectedTaskId);
  const selectTask = useAgentTaskStore((s) => s.selectTask);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const deleteTask = useAgentTaskStore((s) => s.deleteTask);
  const repos = useGitHubStore((s) => s.repos);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const [tasksCollapsed, setTasksCollapsed] = useState(true);

  const convsByRepo = useMemo(() => {
    const map = new Map<string, AgentConversation[]>();
    for (const conv of conversations) {
      const key = conv.projectPath;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(conv);
    }
    // Sort each group by updatedAt descending
    for (const [, list] of map) {
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [conversations]);

  const tasksByRepo = useMemo(() => {
    const map = new Map<string, AgentTask[]>();
    for (const task of tasks) {
      const key = task.projectPath;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(task);
    }
    return map;
  }, [tasks]);

  function handleConversationClick(conv: AgentConversation) {
    if (addToActiveConversations) {
      addToActiveConversations(conv.id);
    }
    setSelectedRepo(conv.projectPath);
  }

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

  const hasConversations = convsByRepo.size > 0;
  const hasTasks = tasksByRepo.size > 0;

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

      <div className="border-b border-bg-border mx-3 mb-1" />

      {/* Main scrollable area */}
      <div className="flex-1 overflow-y-auto px-1">
        {!hasConversations && !hasTasks ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <p className="text-[10px]">No agent tasks yet</p>
          </div>
        ) : (
          <>
            {/* Conversations section */}
            {hasConversations && (
              <div className="mb-2">
                <div className="px-2 py-1">
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                    Conversations
                  </span>
                </div>
                {Array.from(convsByRepo.entries()).map(([path, convs]) => (
                  <ConversationRepoGroup
                    key={path}
                    displayName={repoDisplayName(path, repos)}
                    conversations={convs}
                    activeConversationIds={activeConversationIds}
                    onConversationClick={handleConversationClick}
                    onDeleteConversation={deleteConversation}
                  />
                ))}
              </div>
            )}

            {/* Tasks section (legacy) */}
            {hasTasks && (
              <div className="mb-1">
                <button
                  onClick={() => setTasksCollapsed(!tasksCollapsed)}
                  className="flex items-center gap-1 px-2 py-1 w-full text-left"
                >
                  {tasksCollapsed ? <ChevronRight size={10} className="text-text-muted" /> : <ChevronDown size={10} className="text-text-muted" />}
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                    Tasks
                  </span>
                  <span className="text-[9px] text-text-muted ml-auto">{tasks.length}</span>
                </button>
                {!tasksCollapsed &&
                  Array.from(tasksByRepo.entries()).map(([path, repoTasks]) => (
                    <TaskRepoGroup
                      key={path}
                      displayName={repoDisplayName(path, repos)}
                      tasks={repoTasks}
                      selectedTaskId={selectedTaskId}
                      onTaskClick={handleTaskClick}
                      onDeleteTask={deleteTask}
                    />
                  ))
                }
              </div>
            )}
          </>
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

/* ── Conversation repo group ── */

function ConversationRepoGroup({
  displayName,
  conversations,
  activeConversationIds,
  onConversationClick,
  onDeleteConversation,
}: {
  displayName: string;
  conversations: AgentConversation[];
  activeConversationIds: string[];
  onConversationClick: (conv: AgentConversation) => void;
  onDeleteConversation?: (id: string) => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 py-1">
        <span className="text-[10px] font-medium text-text-muted">{displayName}</span>
      </div>
      {conversations.map((conv) => {
        const isActive = activeConversationIds.includes(conv.id);
        const lastMessage = conv.messages?.[conv.messages.length - 1];
        const preview = lastMessage
          ? lastMessage.content.slice(0, 40) + (lastMessage.content.length > 40 ? "..." : "")
          : null;

        return (
          <div key={conv.id} className="group relative">
            <button
              onClick={() => onConversationClick(conv)}
              title={conv.title}
              className={`flex items-start gap-2 w-full px-2 py-1.5 text-left rounded transition-colors ${
                isActive ? "bg-blue-500/10 border-l-2 border-blue-400" : "hover:bg-bg-hover"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${CONV_STATUS_DOT[conv.status]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className={`text-[11px] truncate flex-1 ${isActive ? "text-text-primary" : "text-text-secondary"}`}>
                    {conv.title}
                  </span>
                  {isActive && <Eye size={10} className="text-blue-400 shrink-0" />}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[9px] text-text-muted">
                    {AGENT_LABELS[conv.agent] ?? conv.agent}
                  </span>
                  <span className="text-[9px] text-text-muted ml-auto shrink-0">
                    {formatRelativeTime(conv.updatedAt)}
                  </span>
                </div>
                {preview && (
                  <p className="text-[9px] text-text-muted truncate mt-0.5 opacity-70">
                    {preview}
                  </p>
                )}
              </div>
            </button>
            {onDeleteConversation && (
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                className="absolute right-1 top-1.5 p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity rounded"
                title="Delete conversation"
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Legacy task repo group ── */

function TaskRepoGroup({
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
