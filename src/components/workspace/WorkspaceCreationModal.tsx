import { useState, useMemo } from "react";
import { LayoutGrid, Check } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { computeGridLayout } from "@/lib/gridLayout";
import type { WorkspaceAgentSlot } from "@/types/workspace";

const AGENT_SLOTS: { id: WorkspaceAgentSlot; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex CLI" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "opencode", label: "OpenCode" },
];

interface WorkspaceCreationModalProps {
  onClose: () => void;
}

export function WorkspaceCreationModal({ onClose }: WorkspaceCreationModalProps) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<WorkspaceAgentSlot>>(new Set());
  const agents = useAgentStore((s) => s.agents);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const preview = useMemo(() => {
    if (selected.size === 0) return null;
    return computeGridLayout(selected.size);
  }, [selected.size]);

  function toggleAgent(id: WorkspaceAgentSlot) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCreate() {
    if (!name.trim() || selected.size === 0) return;
    const orderedAgents = AGENT_SLOTS
      .filter((s) => selected.has(s.id))
      .map((s) => s.id);
    createWorkspace(name.trim(), orderedAgents, projectPath);
    onClose();
  }

  return (
    <Modal
      onClose={onClose}
      title="New Workspace"
      icon={<LayoutGrid size={16} className="text-accent-green" />}
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || selected.size === 0}
            className="px-3 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors disabled:opacity-40"
          >
            Create Workspace
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-[11px] text-text-secondary block mb-1">Workspace Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Workspace"
            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            autoFocus
          />
        </div>

        {/* Agent Selection */}
        <div>
          <label className="text-[11px] text-text-secondary block mb-2">Select Agents</label>
          <div className="space-y-1">
            {AGENT_SLOTS.map((slot) => {
              const agentConfig = agents.find((a) => a.id === slot.id);
              const installed = slot.id === "terminal" || agentConfig?.installed;
              const isSelected = selected.has(slot.id);

              return (
                <button
                  key={slot.id}
                  onClick={() => toggleAgent(slot.id)}
                  className={`flex items-center gap-2 w-full px-3 py-2 rounded text-xs transition-colors ${
                    isSelected
                      ? "bg-accent-green/10 text-accent-green border border-accent-green/30"
                      : "bg-bg-primary border border-bg-border text-text-secondary hover:border-bg-hover"
                  }`}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                    isSelected ? "bg-accent-green border-accent-green" : "border-bg-border"
                  }`}>
                    {isSelected && <Check size={10} className="text-bg-primary" />}
                  </div>
                  <span className="flex-1 text-left">{slot.label}</span>
                  {!installed && (
                    <span className="text-[9px] text-text-muted">not installed</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Grid Preview */}
        {preview && (
          <div>
            <label className="text-[11px] text-text-secondary block mb-2">Grid Preview</label>
            <div
              className="gap-1 max-w-[200px]"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${preview.cols}, 1fr)`,
                gridTemplateRows: `repeat(${preview.rows}, 1fr)`,
              }}
            >
              {preview.cells.map((cell) => {
                const selectedArr = AGENT_SLOTS.filter((s) => selected.has(s.id));
                const agent = cell.agentIndex !== null ? selectedArr[cell.agentIndex] : null;
                return (
                  <div
                    key={`${cell.row}-${cell.col}`}
                    className={`h-10 rounded flex items-center justify-center text-[9px] ${
                      agent
                        ? "bg-accent-green/10 text-accent-green border border-accent-green/20"
                        : "border border-dashed border-bg-border text-text-muted"
                    }`}
                  >
                    {agent?.label ?? ""}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
