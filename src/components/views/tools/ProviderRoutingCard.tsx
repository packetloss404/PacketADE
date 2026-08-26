import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Route, RotateCcw } from "lucide-react";
import { useRoutingStore } from "@/stores/routingStore";
import { useAgentStore } from "@/stores/agentStore";
import {
  ALL_AUX_TASK_CLASSES,
  ALL_TASK_TYPES,
  AUX_TASK_CLASS_GROUPS,
  AUX_TASK_CLASS_LABELS,
  TASK_TYPE_LABELS,
} from "@/types/routing";
import type { AuxProviderOption, AuxRouteResolution, AuxTaskClass } from "@/types/routing";
import {
  getAuxProviderOptions,
  getAuxRouteResolutions,
  listOllamaModels,
  type OllamaModel,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { getModelsForAgent, type ModelOption } from "@/lib/models";
import { API_PROVIDERS } from "@/lib/api-models";
import { SUBSCRIPTION_OAUTH_AGENTS } from "@/lib/attemptRouting";
import type { TaskType } from "@/types/flight";

/**
 * API executors selectable as a workflow-role default.
 *
 * Subscription-OAuth rows are excluded on purpose (WI-1): a user may still pick
 * one by hand in a conversation, but nothing PacketADE routes automatically —
 * including "Draft patch" — may resolve to subscription credentials.
 */
const ROUTABLE_API_PROVIDERS = API_PROVIDERS.filter(
  (p) => !SUBSCRIPTION_OAUTH_AGENTS.has(p.agentCli),
);

/** Model choices for a role's selected agent, PTY or API. */
function modelOptionsForAgent(agentConfigId: string): ModelOption[] {
  const apiProvider = ROUTABLE_API_PROVIDERS.find((p) => p.agentCli === agentConfigId);
  if (apiProvider) {
    return apiProvider.models.map((m) => ({ label: m.label, value: m.value }));
  }
  return getModelsForAgent(agentConfigId);
}

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
        Assign a preferred AI agent and model for each workflow role. Tasks auto-fill from these
        defaults, and automatic Flight launches (such as GitHub → Draft patch) use the
        Implementation role. Only API executors can run a Flight attempt.
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
          const models = modelOptionsForAgent(agentId);
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
                <optgroup label="CLI agents">
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{!a.installed ? " (not installed)" : ""}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="API executors">
                  {ROUTABLE_API_PROVIDERS.map((p) => (
                    <option key={p.agentCli} value={p.agentCli}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
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

      <AuxRoutingSection />
    </div>
  );
}

/**
 * WI-1 — routing for the auxiliary AI tasks PacketADE runs on the user's
 * behalf (spec import, Code Quality explanations, PR prose).
 *
 * These used to be hardwired to the Claude subscription sidecar with no user
 * choice at all. They now resolve through `core::aux_llm`: whatever is pinned
 * here, else the cheapest provider the user has an API key for. There is no
 * subscription-login option and there is no silent fallback — with no API key
 * configured the features fail with a pointer to Settings → API Keys, which is
 * exactly what the "Resolves to" column shows.
 */
function AuxRoutingSection() {
  const auxMappings = useRoutingStore((s) => s.auxMappings);
  const setAuxMapping = useRoutingStore((s) => s.setAuxMapping);
  const resetAuxToDefaults = useRoutingStore((s) => s.resetAuxToDefaults);

  const [providers, setProviders] = useState<AuxProviderOption[]>([]);
  const [resolutions, setResolutions] = useState<AuxRouteResolution[]>([]);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[] | null>(null);

  const refreshResolutions = useCallback(() => {
    getAuxRouteResolutions()
      .then(setResolutions)
      .catch(logSwallowed("ProviderRoutingCard.getAuxRouteResolutions"));
  }, []);

  useEffect(() => {
    getAuxProviderOptions()
      .then(setProviders)
      .catch(logSwallowed("ProviderRoutingCard.getAuxProviderOptions"));
  }, []);

  // Fetch the installed Ollama models once any row pins (or could pin)
  // Ollama — the model column offers real installed models, not the static
  // catalog guesses. A dead daemon degrades to a free-text-less empty list;
  // the "Resolves to" column stays the honest signal.
  const anyOllama = auxMappings.some((m) => m.provider === "ollama");
  useEffect(() => {
    if (!anyOllama || ollamaModels !== null) return;
    listOllamaModels()
      .then((models) => setOllamaModels(models ?? []))
      .catch(() => setOllamaModels([]));
  }, [anyOllama, ollamaModels]);

  // Re-read after every settings change so the resolved route stays honest —
  // the backend, not this component, decides what "Auto" means.
  useEffect(() => {
    refreshResolutions();
  }, [auxMappings, refreshResolutions]);

  function handleProviderChange(taskClass: AuxTaskClass, value: string) {
    // Switching provider clears the pinned model; the backend then uses that
    // provider's cheap-tier default (and, for Ollama, requires an explicit
    // pick — surfaced by the "Resolves to" column until one is made).
    setAuxMapping(taskClass, value === "" ? null : value, null);
  }

  function handleModelChange(taskClass: AuxTaskClass, value: string) {
    const mapping = auxMappings.find((m) => m.taskClass === taskClass);
    if (!mapping?.provider) return;
    setAuxMapping(taskClass, mapping.provider, value === "" ? null : value);
  }

  /** Model choices for a pinned provider. Keyed cloud providers list their
   * catalog models; Ollama lists what is actually installed. Aux task
   * classes are tool-less single shots today, so no supportsTools filter is
   * applied — add one per-class if a tool-carrying aux class ever lands. */
  function modelOptionsFor(provider: string): { value: string; label: string }[] {
    if (provider === "ollama") {
      return (ollamaModels ?? []).map((m) => ({ value: m.name, label: m.name }));
    }
    const catalog = API_PROVIDERS.find((p) => p.id === provider);
    return (catalog?.models ?? []).map((m) => ({ value: m.value, label: m.label }));
  }

  function describeResolution(taskClass: AuxTaskClass): {
    text: string;
    error: boolean;
  } {
    const resolution = resolutions.find((r) => r.taskClass === taskClass);
    if (!resolution) return { text: "…", error: false };
    if (resolution.error) return { text: resolution.error, error: true };
    return {
      text: `${resolution.provider} · ${resolution.model}`,
      error: false,
    };
  }

  return (
    <div className="mt-5 pt-4 border-t border-bg-border">
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[11px] font-semibold text-text-primary">Auxiliary AI tasks</h4>
        <button
          onClick={resetAuxToDefaults}
          className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          title="Reset every auxiliary task to Auto"
        >
          <RotateCcw size={10} />
          Reset
        </button>
      </div>

      <p className="text-[10px] text-text-muted mb-3">
        Short generation tasks PacketADE runs for you. <span className="text-text-secondary">Auto</span>{" "}
        picks the cheapest provider you have an API key for. These never use a Claude or
        ChatGPT subscription login.
      </p>

      <div className="grid grid-cols-[1fr_0.9fr_0.9fr_1.1fr] gap-2 mb-1.5 px-3">
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Task</span>
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Provider</span>
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Model</span>
        <span className="text-[9px] text-text-muted uppercase tracking-wider font-medium">
          Resolves to
        </span>
      </div>

      {/* Grouped once the flat list outgrows one screenful; a short list
          reads better ungrouped. */}
      {(ALL_AUX_TASK_CLASSES.length > 8
        ? AUX_TASK_CLASS_GROUPS
        : [{ label: "", classes: ALL_AUX_TASK_CLASSES }]
      ).map((group) => (
        <div key={group.label || "all"} className="mb-2 last:mb-0">
          {group.label && (
            <h5 className="text-[9px] font-semibold uppercase tracking-wider text-text-muted mt-2.5 mb-1 px-1">
              {group.label}
            </h5>
          )}
          <div className="flex flex-col gap-1.5">
            {group.classes.map((taskClass) => {
              const mapping = auxMappings.find((m) => m.taskClass === taskClass);
              const meta = AUX_TASK_CLASS_LABELS[taskClass];
              const resolved = describeResolution(taskClass);
              const pinnedProvider = mapping?.provider ?? null;
              const models = pinnedProvider ? modelOptionsFor(pinnedProvider) : [];
              const isOllamaPin = pinnedProvider === "ollama";

              return (
                <div
                  key={taskClass}
                  className="grid grid-cols-[1fr_0.9fr_0.9fr_1.1fr] gap-2 items-center px-3 py-2 bg-bg-primary border border-bg-border rounded"
                >
                  <div className="min-w-0">
                    <div className="text-[11px] text-text-primary font-medium">{meta.label}</div>
                    <div className="text-[9px] text-text-muted">{meta.description}</div>
                  </div>

                  <select
                    aria-label={`${meta.label} provider`}
                    value={pinnedProvider ?? ""}
                    onChange={(e) => handleProviderChange(taskClass, e.target.value)}
                    className="bg-bg-elevated border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-green truncate"
                  >
                    <option value="">Auto (cheapest configured)</option>
                    {providers.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.provider}
                        {p.configured ? "" : " (no key)"}
                      </option>
                    ))}
                  </select>

                  {/* Model pin. Empty = provider default — except Ollama,
                      where the backend refuses a model-less pin and this
                      select is the fix-it affordance. */}
                  <select
                    aria-label={`${meta.label} model`}
                    value={mapping?.model ?? ""}
                    onChange={(e) => handleModelChange(taskClass, e.target.value)}
                    disabled={!pinnedProvider}
                    className={`bg-bg-elevated border rounded px-2 py-1 text-[11px] focus:outline-none focus:border-accent-green truncate disabled:opacity-40 ${
                      isOllamaPin && !mapping?.model
                        ? "border-accent-red/60 text-accent-red"
                        : "border-bg-border text-text-primary"
                    }`}
                  >
                    <option value="">
                      {!pinnedProvider
                        ? "—"
                        : isOllamaPin
                          ? "Pick a model…"
                          : "Provider default"}
                    </option>
                    {models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>

                  <div
                    className={`text-[10px] min-w-0 flex items-start gap-1 ${
                      resolved.error ? "text-accent-red" : "text-text-secondary"
                    }`}
                  >
                    {resolved.error && <AlertTriangle size={10} className="mt-0.5 shrink-0" />}
                    <span className="break-words">{resolved.text}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
