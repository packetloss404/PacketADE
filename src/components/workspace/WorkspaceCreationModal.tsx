import { useState, useMemo } from "react";
import { LayoutGrid, Check, User, FileText, ShieldOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useProfileStore } from "@/stores/profileStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import { computeGridLayout } from "@/lib/gridLayout";
import { CLAUDE_MODELS, CODEX_MODELS, GEMINI_MODELS, OPENCODE_MODELS, EFFORT_LEVELS, type EffortLevel } from "@/lib/models";
import type { WorkspaceAgentSlot } from "@/types/workspace";

type AgentChoice = "claude-code" | "codex" | "gemini" | "opencode";

/** Agents that support the --effort flag */
const EFFORT_SUPPORTED = new Set<string>(["claude-code"]);

const AGENT_SLOTS: { id: WorkspaceAgentSlot; cliId: AgentChoice | null; label: string; cliCommand: string }[] = [
  { id: "terminal", cliId: null, label: "Terminal", cliCommand: "bash" },
  { id: "claude-code", cliId: "claude-code", label: "Claude Code", cliCommand: "claude" },
  { id: "codex", cliId: "codex", label: "Codex CLI", cliCommand: "codex" },
  { id: "gemini", cliId: "gemini", label: "Gemini CLI", cliCommand: "gemini" },
  { id: "opencode", cliId: "opencode", label: "OpenCode", cliCommand: "opencode" },
];

const CLI_MODEL_MAP: Record<AgentChoice, typeof CLAUDE_MODELS> = {
  "claude-code": CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
  opencode: OPENCODE_MODELS,
};

interface WorkspaceCreationModalProps {
  onClose: () => void;
}

export function WorkspaceCreationModal({ onClose }: WorkspaceCreationModalProps) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<WorkspaceAgentSlot>>(new Set());
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    useProfileStore.getState().activeProfileId,
  );
  const [includeMemory, setIncludeMemory] = useState(true);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string | null>>({});
  const [effortOverrides, setEffortOverrides] = useState<Record<string, EffortLevel | null>>({ "claude-code": "medium" });
  const [bypassPermissions, setBypassPermissions] = useState(false);
  const [prompt, setPrompt] = useState("");

  const agents = useAgentStore((s) => s.agents);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const profiles = useProfileStore((s) => s.profiles);

  const preview = useMemo(() => {
    if (selected.size === 0) return null;
    return computeGridLayout(selected.size);
  }, [selected.size]);

  // Get the AI agents that are selected (not terminal)
  const selectedAiAgents = AGENT_SLOTS.filter((s) => selected.has(s.id) && s.cliId);

  function toggleAgent(id: WorkspaceAgentSlot) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleProfileChange(profileId: string | null) {
    setSelectedProfileId(profileId);
  }

  function setModelForAgent(agentId: string, model: string | null) {
    setModelOverrides((prev) => ({ ...prev, [agentId]: model }));
  }

  function handleCreate() {
    if (!name.trim() || selected.size === 0) return;

    const orderedAgents = AGENT_SLOTS
      .filter((s) => selected.has(s.id))
      .map((s) => s.id);

    // Build session config
    const selectedProfile = selectedProfileId
      ? profiles.find((p) => p.id === selectedProfileId)
      : null;

    let finalPrompt = "";
    if (selectedProfile?.systemPrompt) {
      finalPrompt += selectedProfile.systemPrompt + "\n\n";
    }
    if (includeMemory) {
      const memoryContext = useMemoryStore.getState().getContextForSession();
      if (memoryContext.trim()) {
        finalPrompt += memoryContext + "\n\n";
      }
    }
    if (prompt.trim()) {
      finalPrompt += prompt.trim();
    }

    if (selectedProfileId) {
      useProfileStore.getState().setActiveProfile(selectedProfileId);
    }

    createWorkspace(name.trim(), orderedAgents, projectPath, {
      prompt: finalPrompt.trim() || undefined,
      modelOverrides,
      effortOverrides,
      bypassPermissions,
    });

    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleCreate();
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="New Workspace"
      icon={<LayoutGrid size={16} className="text-accent-green" />}
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
            onClick={handleCreate}
            disabled={!name.trim() || selected.size === 0}
            className="px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40"
          >
            Create Workspace
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto" onKeyDown={handleKeyDown}>
        {/* Name */}
        <div>
          <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">Workspace Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Workspace"
            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            autoFocus
          />
        </div>

        {/* Agent Selection — multi-toggle buttons */}
        <div>
          <label className="text-[10px] text-text-muted block mb-2 uppercase tracking-wider">Agents</label>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_SLOTS.map((slot) => {
              const agentConfig = agents.find((a) => a.id === slot.id);
              const installed = slot.id === "terminal" || agentConfig?.installed;
              const isSelected = selected.has(slot.id);

              return (
                <button
                  key={slot.id}
                  onClick={() => toggleAgent(slot.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border transition-colors ${
                    isSelected
                      ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                      : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                  }`}
                >
                  <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                    isSelected ? "bg-accent-green border-accent-green" : "border-bg-border"
                  }`}>
                    {isSelected && <Check size={8} className="text-bg-primary" />}
                  </div>
                  {slot.label}
                  {!installed && (
                    <span className="text-[9px] text-text-muted ml-1">(missing)</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent Profile */}
        {selectedAiAgents.length > 0 && (
          <div>
            <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
              Agent Profile
            </label>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => handleProfileChange(null)}
                className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border transition-colors ${
                  !selectedProfileId
                    ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                    : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                }`}
              >
                None
              </button>
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleProfileChange(p.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border transition-colors ${
                    selectedProfileId === p.id
                      ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                      : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                  }`}
                  title={p.description}
                >
                  <User size={10} className={p.color} />
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Memory context toggle */}
        {selectedAiAgents.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeMemory}
                onChange={(e) => setIncludeMemory(e.target.checked)}
                className="w-3 h-3 rounded border-bg-border accent-accent-green"
              />
              <span className="text-[11px] text-text-secondary">
                Include memory context
              </span>
            </label>
          </div>
        )}

        {/* Bypass permissions toggle */}
        {selectedAiAgents.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bypassPermissions}
                onChange={(e) => setBypassPermissions(e.target.checked)}
                className="w-3 h-3 rounded border-bg-border accent-accent-amber"
              />
              <ShieldOff size={11} className={bypassPermissions ? "text-accent-amber" : "text-text-muted"} />
              <span className={`text-[11px] ${bypassPermissions ? "text-accent-amber" : "text-text-secondary"}`}>
                Bypass permissions
              </span>
            </label>
          </div>
        )}

        {/* Model selection per selected AI agent */}
        {selectedAiAgents.map((slot) => {
          const models = CLI_MODEL_MAP[slot.cliId!];

          // OpenCode manages its own models internally
          if (models.length === 0) {
            return (
              <div key={slot.id} className="opacity-50">
                <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
                  {slot.label} Model
                </label>
                <span className="text-[11px] text-text-muted italic">Configured inside {slot.label}</span>
              </div>
            );
          }

          const currentModel = modelOverrides[slot.id] ?? null;
          return (
            <div key={slot.id}>
              <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
                {slot.label} Model
              </label>
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m.label}
                    onClick={() => setModelForAgent(slot.id, m.value)}
                    className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                      currentModel === m.value
                        ? "bg-accent-amber/15 border-accent-amber/40 text-accent-amber font-medium"
                        : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* Effort level per selected AI agent */}
        {selectedAiAgents.map((slot) => {
          if (!EFFORT_SUPPORTED.has(slot.id)) {
            return null;
          }
          const currentEffort = effortOverrides[slot.id] ?? null;
          return (
            <div key={`effort-${slot.id}`}>
              <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
                {slot.label} Effort
              </label>
              <div className="flex flex-wrap gap-1.5">
                {EFFORT_LEVELS.map((e) => (
                  <button
                    key={e.value}
                    onClick={() => setEffortOverrides((prev) => ({ ...prev, [slot.id]: e.value }))}
                    className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                      currentEffort === e.value
                        ? "bg-accent-purple/15 border-accent-purple/40 text-accent-purple font-medium"
                        : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                    }`}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* Prompt Template Picker */}
        {selectedAiAgents.length > 0 && (
          <TemplatePicker onSelect={(content) => setPrompt(content)} />
        )}

        {/* Prompt */}
        {selectedAiAgents.length > 0 && (
          <div>
            <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
              Initial Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Describe the task for all agents..."
              className="w-full bg-bg-primary border border-bg-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-amber resize-none"
            />
            <p className="text-[10px] text-text-muted mt-1">
              Ctrl+Enter to create
            </p>
          </div>
        )}

        {/* Grid Preview */}
        {preview && (
          <div>
            <label className="text-[10px] text-text-muted block mb-2 uppercase tracking-wider">Layout Preview</label>
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

function TemplatePicker({ onSelect }: { onSelect: (content: string) => void }) {
  const templates = usePromptStore((s) => s.templates);
  const [open, setOpen] = useState(false);

  if (templates.length === 0) return null;

  return (
    <div>
      <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
        Prompt Template
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-bg-primary border border-bg-border rounded w-full text-left text-text-secondary hover:border-text-muted/30 transition-colors"
        >
          <FileText size={11} className="text-accent-amber flex-shrink-0" />
          <span className="flex-1 truncate">Select a template...</span>
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[200px] overflow-y-auto">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onSelect(t.content);
                  setOpen(false);
                }}
                className="flex flex-col w-full px-3 py-2 text-left hover:bg-bg-hover transition-colors"
              >
                <span className="text-[11px] text-text-primary">{t.name}</span>
                <span className="text-[10px] text-text-muted truncate">
                  {t.content.slice(0, 80)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
