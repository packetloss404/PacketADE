import { useState, useRef, useEffect } from "react";
import { Bot, Plus, Square, Trash2, Clock, CheckCircle, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { useAgentTaskStore, type AgentTask, type AgentTaskStatus } from "@/stores/agentTaskStore";
import { NewAgentTaskModal } from "@/components/agents/NewAgentTaskModal";
import { relativeTime } from "@/lib/time";

const STATUS_CONFIG: Record<AgentTaskStatus, { dot: string; label: string; icon: typeof CheckCircle }> = {
  running: { dot: "bg-accent-green animate-pulse", label: "Running", icon: Loader2 },
  done: { dot: "bg-accent-green", label: "Done", icon: CheckCircle },
  failed: { dot: "bg-accent-red", label: "Failed", icon: XCircle },
  cancelled: { dot: "bg-text-muted", label: "Cancelled", icon: AlertCircle },
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

export function AgentsView() {
  const tasks = useAgentTaskStore((s) => s.tasks);
  const selectedTaskId = useAgentTaskStore((s) => s.selectedTaskId);
  const selectTask = useAgentTaskStore((s) => s.selectTask);
  const cancelTask = useAgentTaskStore((s) => s.cancelTask);
  const deleteTask = useAgentTaskStore((s) => s.deleteTask);
  const [showCreate, setShowCreate] = useState(false);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId);

  const running = tasks.filter((t) => t.status === "running");
  const completed = tasks.filter((t) => t.status !== "running");

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      {/* Left panel — task list */}
      <div className="w-[280px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border">
          <div className="flex items-center gap-2">
            <Bot size={12} className="text-accent-green" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Agents
            </span>
            {running.length > 0 && (
              <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-accent-green/20 text-accent-green">
                {running.length}
              </span>
            )}
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 text-[10px] text-accent-green hover:text-accent-green/80 transition-colors"
          >
            <Plus size={11} />
            New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-muted">
              <Bot size={24} className="mb-2 opacity-30" />
              <p className="text-[11px]">No agent tasks yet</p>
              <p className="text-[10px] mt-1">Launch one to get started</p>
            </div>
          ) : (
            <>
              {running.length > 0 && (
                <TaskGroup label="Running" tasks={running} selectedId={selectedTaskId} onSelect={selectTask} />
              )}
              {completed.length > 0 && (
                <TaskGroup label="Completed" tasks={completed} selectedId={selectedTaskId} onSelect={selectTask} />
              )}
            </>
          )}
        </div>
      </div>

      {/* Right panel — task detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedTask ? (
          <TaskDetail task={selectedTask} onCancel={cancelTask} onDelete={deleteTask} />
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-text-muted">
            <Bot size={32} className="mb-3 opacity-20" />
            <p className="text-xs">Select a task to view its output</p>
          </div>
        )}
      </div>

      {showCreate && <NewAgentTaskModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function TaskGroup({
  label,
  tasks,
  selectedId,
  onSelect,
}: {
  label: string;
  tasks: AgentTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="border-b border-bg-border">
      <div className="px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-text-secondary">
          {label}
        </span>
        <span className="text-[10px] text-text-muted ml-1">({tasks.length})</span>
      </div>
      <div className="pb-1">
        {tasks.map((task) => {
          const cfg = STATUS_CONFIG[task.status];
          const selected = task.id === selectedId;
          return (
            <button
              key={task.id}
              onClick={() => onSelect(task.id)}
              className={`flex items-start gap-2 w-full px-3 py-1.5 text-left transition-colors border-l-2 ${
                selected
                  ? "bg-accent-green/10 border-accent-green"
                  : "hover:bg-bg-hover border-transparent"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${cfg.dot}`} />
              <div className="flex-1 min-w-0">
                <div className={`text-[11px] font-medium truncate ${selected ? "text-text-primary" : "text-text-secondary"}`}>
                  {task.title}
                </div>
                <div className="flex items-center gap-1.5 text-[9px] text-text-muted">
                  <span>{AGENT_LABELS[task.agent] ?? task.agent}</span>
                  <span>·</span>
                  <span>{formatDuration(task.startedAt, task.completedAt)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  onCancel,
  onDelete,
}: {
  task: AgentTask;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const cfg = STATUS_CONFIG[task.status];
  const StatusIcon = cfg.icon;
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom when output changes (only for running tasks)
  useEffect(() => {
    if (task.status === "running" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [task.output, task.status]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-bg-border bg-bg-secondary">
        <StatusIcon
          size={14}
          className={task.status === "running" ? "text-accent-green animate-spin" : cfg.dot.includes("green") ? "text-accent-green" : cfg.dot.includes("red") ? "text-accent-red" : "text-text-muted"}
        />
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-text-primary truncate">{task.title}</h3>
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <span>{AGENT_LABELS[task.agent] ?? task.agent}</span>
            <span>·</span>
            <span>{cfg.label}</span>
            <span>·</span>
            <span className="flex items-center gap-0.5">
              <Clock size={9} />
              {formatDuration(task.startedAt, task.completedAt)}
            </span>
            <span>·</span>
            <span>{relativeTime(task.startedAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {task.status === "running" && (
            <button
              onClick={() => onCancel(task.id)}
              className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-amber hover:bg-accent-amber/10 rounded transition-colors"
              title="Cancel"
            >
              <Square size={10} />
              Cancel
            </button>
          )}
          <button
            onClick={() => onDelete(task.id)}
            className="p-1 text-text-muted hover:text-accent-red transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Task description */}
      <div className="px-4 py-2 border-b border-bg-border bg-bg-secondary/50">
        <p className="text-[11px] text-text-secondary">{task.description}</p>
      </div>

      {/* Output */}
      <pre
        ref={outputRef}
        className="flex-1 overflow-auto px-4 py-3 text-[11px] font-mono text-text-primary leading-relaxed whitespace-pre-wrap break-words"
      >
        {task.output || (
          <span className="text-text-muted italic">
            {task.status === "running" ? "Waiting for output..." : "No output captured"}
          </span>
        )}
      </pre>
    </div>
  );
}
