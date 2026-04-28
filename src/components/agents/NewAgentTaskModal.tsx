import { useState } from "react";
import { Bot, Check } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAgentStore } from "@/stores/agentStore";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";

const AGENT_OPTIONS: { id: AgentCli; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex CLI" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "opencode", label: "OpenCode" },
];

interface NewAgentTaskModalProps {
  onClose: () => void;
}

export function NewAgentTaskModal({ onClose }: NewAgentTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState<AgentCli>("claude-code");

  const agents = useAgentStore((s) => s.agents);
  const launchTask = useAgentTaskStore((s) => s.launchTask);
  const projectPath = useLayoutStore((s) => s.projectPath);

  async function handleLaunch() {
    if (!description.trim()) return;
    const taskTitle = title.trim() || description.trim().slice(0, 60);
    await launchTask(taskTitle, description.trim(), agent, projectPath);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      void handleLaunch();
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="New Agent Task"
      icon={<Bot size={14} className="text-accent-green" />}
      width="w-[480px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleLaunch()}
            disabled={!description.trim()}
            className="px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40"
          >
            Launch Agent
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-4" onKeyDown={handleKeyDown}>
        {/* Title (optional) */}
        <div>
          <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">
            Title <span className="normal-case">(optional)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short name for this task"
            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
          />
        </div>

        {/* Agent picker */}
        <div>
          <label className="text-[10px] text-text-muted block mb-2 uppercase tracking-wider">Agent</label>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_OPTIONS.map((opt) => {
              const agentConfig = agents.find((a) => a.id === opt.id);
              const installed = !!agentConfig?.installed;
              const selected = agent === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => installed && setAgent(opt.id)}
                  disabled={!installed}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border transition-colors ${
                    selected
                      ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                      : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary"
                  } ${!installed ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                    selected ? "bg-accent-green border-accent-green" : "border-bg-border"
                  }`}>
                    {selected && <Check size={8} className="text-bg-primary" />}
                  </div>
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Task description */}
        <div>
          <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">Task Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="Describe what the agent should do..."
            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green resize-none"
            autoFocus
          />
          <p className="text-[10px] text-text-muted mt-1">
            The agent will run autonomously with full edit access. Ctrl+Enter to launch.
          </p>
        </div>

        {/* Project path */}
        <div className="text-[10px] text-text-muted">
          Project: <span className="text-text-secondary font-mono">{projectPath}</span>
        </div>
      </div>
    </Modal>
  );
}
