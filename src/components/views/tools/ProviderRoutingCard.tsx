import { Route, RotateCcw } from "lucide-react";
import { useRoutingStore } from "@/stores/routingStore";
import { useAgentStore } from "@/stores/agentStore";
import { ALL_TASK_TYPES, TASK_TYPE_LABELS } from "@/types/routing";
import { getModelsForAgent } from "@/lib/models";
import type { TaskType } from "@/types/flight";

export function ProviderRoutingCard() {
  const mappings = useRoutingStore((s) => s.mappings);
  const setMapping = useRoutingStore((s) => s.setMapping);
  const resetToDefaults = useRoutingStore((s) => s.resetToDefaults);
  const agents = useAgentStore((s) => s.agents);

  function handleAgentChange(taskType: TaskType, agentConfigId: string) {
    setMapping(taskType, agentConfigId, null); // reset model when switching agent
  }

  function handleModelChange(taskType: TaskType, model: string | null) {
    const mapping = mappings.find((m) => m.taskType === taskType);
    if (mapping) {
      setMapping(taskType, mapping.agentConfigId, model);
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4 col-span-2">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <Route size={12} className="text-accent-blue" />
          AI Provider Routing
        </h3>
        <button
          onClick={resetToDefaults}
          className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          title="Reset all to defaults"
        >
          <RotateCcw size={10} />
          Reset All
        </button>
      </div>

      <p className="text-[10px] text-text-muted mb-3">
        Assign a preferred AI agent and model for each workflow role. Tasks auto-fill from these defaults.
      </p>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 mb-1.5 px-3">
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Role</span>
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Agent</span>
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Model</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {ALL_TASK_TYPES.map((taskType) => {
          const mapping = mappings.find((m) => m.taskType === taskType);
          const agentId = mapping?.agentConfigId ?? "claude-code";
          const modelValue = mapping?.model ?? null;
          const models = getModelsForAgent(agentId);
          const meta = TASK_TYPE_LABELS[taskType];
          const agent = agents.find((a) => a.id === agentId);

          return (
            <div
              key={taskType}
              className="grid grid-cols-[1fr_1fr_1fr] gap-2 items-center px-3 py-2 bg-bg-primary border border-bg-border rounded"
            >
              {/* Role label */}
              <div className="min-w-0">
                <div className="text-[11px] text-text-primary font-medium">{meta.label}</div>
                <div className="text-[9px] text-text-muted">{meta.description}</div>
              </div>

              {/* Agent selector */}
              <select
                value={agentId}
                onChange={(e) => handleAgentChange(taskType, e.target.value)}
                className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-green truncate"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{!a.installed ? " (not installed)" : ""}
                  </option>
                ))}
              </select>

              {/* Model selector */}
              <select
                value={modelValue ?? ""}
                onChange={(e) => handleModelChange(taskType, e.target.value || null)}
                className={`bg-bg-elevated border border-bg-border rounded px-2 py-1 text-[11px] focus:outline-none focus:border-accent-green truncate ${
                  agent && !agent.installed ? "text-text-muted" : "text-text-primary"
                }`}
              >
                {models.map((m) => (
                  <option key={m.value ?? "__default"} value={m.value ?? ""}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
