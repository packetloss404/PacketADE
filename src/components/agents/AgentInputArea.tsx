import { useState, useRef, useEffect } from "react";
import { Plus, Monitor, Mic, File, Folder, Link, Square, Trash2, Clock, Loader2, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { useAgentTaskStore, repoDisplayName } from "@/stores/agentTaskStore";
import { useAgentStore } from "@/stores/agentStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { ServerSelectorPopover } from "./ServerSelectorPopover";
import type { AgentCli, AgentTaskStatus } from "@/stores/agentTaskStore";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const COMMAND_ITEMS = ["/plan", "/build", "/review", "/test", "/explain"];
const CONTEXT_ITEMS = ["@file", "@folder", "@repo", "@issue", "@url"];

const STATUS_CONFIG: Record<AgentTaskStatus, { dot: string; label: string; icon: typeof CheckCircle }> = {
  running: { dot: "bg-accent-green animate-pulse", label: "Running", icon: Loader2 },
  done: { dot: "bg-accent-green", label: "Done", icon: CheckCircle },
  failed: { dot: "bg-accent-red", label: "Failed", icon: XCircle },
  cancelled: { dot: "bg-text-muted", label: "Cancelled", icon: AlertCircle },
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

interface AutocompleteState {
  type: "command" | "context";
  items: string[];
}

interface AgentInputAreaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  onLaunch: () => void;
}

export function AgentInputArea({ textareaRef, selectedAgent, onAgentChange, onLaunch }: AgentInputAreaProps) {
  const inputMode = useAgentTaskStore((s) => s.inputMode);
  const setInputMode = useAgentTaskStore((s) => s.setInputMode);
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const selectedTaskId = useAgentTaskStore((s) => s.selectedTaskId);
  const tasks = useAgentTaskStore((s) => s.tasks);
  const cancelTask = useAgentTaskStore((s) => s.cancelTask);
  const deleteTask = useAgentTaskStore((s) => s.deleteTask);
  const repos = useGitHubStore((s) => s.repos);
  const agents = useAgentStore((s) => s.agents);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const { isListening, transcript, startListening, stopListening, isSupported } = useVoiceInput();
  const prevTranscriptRef = useRef("");
  const outputRef = useRef<HTMLPreElement>(null);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(null);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  // Append voice transcript to input
  useEffect(() => {
    if (transcript && transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = transcript;
      const current = useAgentTaskStore.getState().agentInputText;
      setAgentInputText(current + transcript);
    }
  }, [transcript, setAgentInputText]);

  // Auto-scroll output for running tasks
  useEffect(() => {
    if (selectedTask?.status === "running" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [selectedTask?.output, selectedTask?.status]);

  // Collect unique project paths for the repo selector
  const repoPaths = Array.from(
    new Set([projectPath, ...tasks.map((t) => t.projectPath)].filter(Boolean))
  );

  const currentRepoPath = selectedRepo ?? projectPath;
  const currentDisplayName = repoDisplayName(currentRepoPath, repos);
  const installedAgents = agents.filter((a) => a.installed);

  const placeholder = inputMode === "plan"
    ? "Describe your idea to plan..."
    : "Plan, Build, / for commands, @ for context";

  function handleInputChange(value: string) {
    setAgentInputText(value);

    // Check for / command trigger (start of string or after newline)
    const lines = value.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    if (lastLine === "/" || (lastLine.startsWith("/") && !lastLine.includes(" "))) {
      const filtered = COMMAND_ITEMS.filter((c) => c.startsWith(lastLine));
      if (filtered.length > 0) {
        setAutocomplete({ type: "command", items: filtered });
        return;
      }
    }

    // Check for @ context trigger
    const words = value.split(/\s/);
    const lastWord = words[words.length - 1] ?? "";
    if (lastWord.startsWith("@") && lastWord.length >= 1) {
      const filtered = CONTEXT_ITEMS.filter((c) => c.startsWith(lastWord));
      if (filtered.length > 0) {
        setAutocomplete({ type: "context", items: filtered });
        return;
      }
    }

    setAutocomplete(null);
  }

  function handleAutocompleteSelect(item: string) {
    const text = agentInputText;
    if (autocomplete?.type === "command") {
      const lines = text.split("\n");
      lines[lines.length - 1] = item + " ";
      setAgentInputText(lines.join("\n"));
    } else {
      const words = text.split(/(\s+)/);
      words[words.length - 1] = item + " ";
      setAgentInputText(words.join(""));
    }
    setAutocomplete(null);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && autocomplete) {
      e.preventDefault();
      setAutocomplete(null);
      return;
    }
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      onLaunch();
    }
  }

  function handleOpenWorkspace() {
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
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[600px]">
        {/* Repo selector */}
        <div className="mb-4">
          <Dropdown
            trigger={
              <span className="flex items-center gap-1.5 text-text-primary">
                {currentDisplayName}
                <Monitor size={12} className="text-text-muted ml-1" />
              </span>
            }
          >
            {repoPaths.map((path) => (
              <DropdownItem key={path} onClick={() => setSelectedRepo(path)}>
                {repoDisplayName(path, repos)}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>

        {/* Input box */}
        <div className="relative border border-bg-border rounded-lg bg-bg-primary overflow-hidden">
          <textarea
            ref={textareaRef}
            value={agentInputText}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={4}
            className="w-full bg-transparent px-4 py-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
          />

          {/* Autocomplete popup */}
          {autocomplete && (
            <div className="absolute left-3 bottom-12 bg-bg-elevated border border-bg-border rounded shadow-xl text-xs z-50 py-1 min-w-[140px]">
              {autocomplete.items.map((item) => (
                <button
                  key={item}
                  className="block w-full text-left px-3 py-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                  onMouseDown={(e) => { e.preventDefault(); handleAutocompleteSelect(item); }}
                >
                  {item}
                </button>
              ))}
            </div>
          )}

          {/* Action row inside the input box */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-bg-border/50">
            <div className="flex items-center gap-2">
              {/* + context menu */}
              <Dropdown
                trigger={
                  <span className="text-text-muted hover:text-text-secondary" title="Attach context">
                    <Plus size={14} />
                  </span>
                }
              >
                <DropdownItem onClick={() => {}}>
                  <span className="flex items-center gap-2"><File size={12} /> Add File...</span>
                </DropdownItem>
                <DropdownItem onClick={() => {}}>
                  <span className="flex items-center gap-2"><Folder size={12} /> Add Folder...</span>
                </DropdownItem>
                <DropdownItem onClick={() => {}}>
                  <span className="flex items-center gap-2"><Link size={12} /> Add URL...</span>
                </DropdownItem>
              </Dropdown>

              {/* Agent selector */}
              <Dropdown
                trigger={
                  <span className="text-text-secondary">
                    {AGENT_LABELS[selectedAgent] ?? selectedAgent}
                  </span>
                }
              >
                {installedAgents.map((a) => (
                  <DropdownItem key={a.id} onClick={() => onAgentChange(a.id as AgentCli)}>
                    {a.name}
                  </DropdownItem>
                ))}
              </Dropdown>
            </div>

            {/* Mic button */}
            {isSupported && (
              <button
                onClick={isListening ? stopListening : startListening}
                className={`p-1.5 rounded-full transition-colors ${
                  isListening
                    ? "bg-accent-green/20 text-accent-green animate-pulse"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                title={isListening ? "Stop listening" : "Voice input"}
              >
                <Mic size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Bottom button row */}
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={() => setInputMode(inputMode === "plan" ? "build" : "plan")}
            className={`px-4 py-2 text-xs rounded border transition-colors ${
              inputMode === "plan"
                ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                : "border-bg-border text-text-secondary hover:text-text-primary hover:border-text-muted"
            }`}
          >
            Plan New Idea
            <span className="ml-2 text-[9px] text-text-muted">&#8677;Tab</span>
          </button>

          <button
            onClick={handleOpenWorkspace}
            className="px-4 py-2 text-xs rounded border border-bg-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
          >
            Open in Workspace
          </button>

          <ServerSelectorPopover />
        </div>

        {/* Task output panel */}
        {selectedTask && <TaskOutputPanel task={selectedTask} onCancel={cancelTask} onDelete={deleteTask} outputRef={outputRef} />}
      </div>
    </div>
  );
}

function TaskOutputPanel({
  task,
  onCancel,
  onDelete,
  outputRef,
}: {
  task: { id: string; title: string; agent: string; status: AgentTaskStatus; startedAt: number; completedAt: number | null; output: string };
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  outputRef: React.RefObject<HTMLPreElement | null>;
}) {
  const cfg = STATUS_CONFIG[task.status];
  const StatusIcon = cfg.icon;

  return (
    <div className="mt-4 border border-bg-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-bg-border">
        <StatusIcon
          size={12}
          className={task.status === "running" ? "text-accent-green animate-spin" : cfg.dot.includes("green") ? "text-accent-green" : cfg.dot.includes("red") ? "text-accent-red" : "text-text-muted"}
        />
        <span className="text-[11px] font-medium text-text-primary truncate flex-1">{task.title}</span>
        <span className="text-[9px] text-text-muted">{AGENT_LABELS[task.agent] ?? task.agent}</span>
        <span className="text-[9px] text-text-muted">{cfg.label}</span>
        <span className="flex items-center gap-0.5 text-[9px] text-text-muted">
          <Clock size={9} />
          {formatDuration(task.startedAt, task.completedAt)}
        </span>
        {task.status === "running" && (
          <button
            onClick={() => onCancel(task.id)}
            className="p-0.5 text-accent-amber hover:bg-accent-amber/10 rounded transition-colors"
            title="Cancel"
          >
            <Square size={10} />
          </button>
        )}
        <button
          onClick={() => onDelete(task.id)}
          className="p-0.5 text-text-muted hover:text-accent-red transition-colors"
          title="Delete"
        >
          <Trash2 size={10} />
        </button>
      </div>

      {/* Output */}
      <pre
        ref={outputRef}
        className="max-h-[300px] overflow-auto px-3 py-2 text-[11px] font-mono text-text-primary leading-relaxed whitespace-pre-wrap break-words bg-bg-primary"
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
