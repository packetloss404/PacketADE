import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import type { AgentCli } from "@/stores/agentTaskStore";
import {
  API_PROVIDERS,
  getModelSpeed,
  MODEL_SPEED_LABEL,
} from "@/lib/api-models";
import type { OllamaModelsState } from "../hooks/useOllamaModels";

/** Compact context-window label, e.g. 200_000 -> "200K ctx", 1_000_000 -> "1M ctx". */
function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M ctx`;
  }
  return `${Math.round(tokens / 1000)}K ctx`;
}

/** Compact per-1M-token price label, e.g. { input: 3, output: 15 } -> "$3/$15". */
function formatPricing(
  pricing: { input: number; output: number } | undefined,
): string | null {
  if (!pricing) return null;
  return `$${pricing.input}/$${pricing.output}`;
}

interface ModelSelectorProps {
  selectedAgent: AgentCli;
  selectedModel: string;
  onModelChange: (model: string) => void;
  ollamaModels: OllamaModelsState;
  refreshOllamaModels: () => void;
  /** Imperative "open now" channel threaded to the underlying Dropdown, e.g.
   * so the `/model` slash command can open the header's picker. */
  openSignal?: number;
}

export function ModelSelector({
  selectedAgent,
  selectedModel,
  onModelChange,
  ollamaModels,
  refreshOllamaModels,
  openSignal,
}: ModelSelectorProps) {
  const provider = API_PROVIDERS.find((p) => p.agentCli === selectedAgent);
  if (!provider) return null;

  const isOllama = selectedAgent === "api-ollama";

  // Trigger label. In Ollama mode the label is the live-fetched model name
  // (just the `name` string; Ollama installs have no separate display label).
  let triggerLabel: string;
  if (isOllama) {
    if (Array.isArray(ollamaModels)) {
      const match = ollamaModels.find((m) => m.name === selectedModel);
      triggerLabel =
        match?.name ??
        selectedModel ??
        ollamaModels[0]?.name ??
        "Select model";
    } else if (ollamaModels === "loading") {
      triggerLabel = selectedModel || "Loading models…";
    } else {
      triggerLabel = selectedModel || "Ollama unreachable";
    }
  } else {
    const currentModel =
      provider.models.find((m) => m.value === selectedModel) ??
      provider.models[0];
    triggerLabel = currentModel?.label ?? "Select model";
  }

  const speed = getModelSpeed(selectedModel);
  const speedClass =
    speed === "fast"
      ? "text-accent-green bg-accent-green/10"
      : speed === "thorough"
        ? "text-accent-purple bg-accent-purple/10"
        : "text-accent-blue bg-accent-blue/10";

  return (
    <Dropdown
      searchable
      searchPlaceholder="Search models…"
      openSignal={openSignal}
      trigger={
        <span className="flex items-center gap-1.5 text-text-muted text-ui">
          <span>{triggerLabel}</span>
          <span
            className={`px-1 py-px rounded text-meta font-medium ${speedClass}`}
            title={`${MODEL_SPEED_LABEL[speed]} mode (heuristic)`}
          >
            {MODEL_SPEED_LABEL[speed]}
          </span>
        </span>
      }
    >
      {isOllama ? (
        <>
          <div className="flex items-center justify-between px-3 py-1 text-meta uppercase tracking-wide text-text-muted">
            <span>Installed models</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                refreshOllamaModels();
              }}
              className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
              title="Refresh installed Ollama models"
            >
              <RefreshCw size={10} />
            </button>
          </div>
          {ollamaModels === "loading" ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-text-muted">
              <Loader2 size={10} className="animate-spin" />
              Loading models…
            </div>
          ) : !Array.isArray(ollamaModels) ? (
            <>
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-accent-red">
                <AlertCircle size={10} />
                {ollamaModels.error}
              </div>
              <DropdownItem onClick={() => refreshOllamaModels()}>
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <RefreshCw size={10} />
                  Retry
                </span>
              </DropdownItem>
            </>
          ) : ollamaModels.length === 0 ? (
            <div className="px-3 py-1.5 text-text-muted text-meta">
              No models installed. Run{" "}
              <code className="text-text-secondary">
                ollama pull &lt;model&gt;
              </code>{" "}
              in a terminal.
            </div>
          ) : (
            ollamaModels.map((m) => (
              <DropdownItem
                key={m.name}
                onClick={() => onModelChange(m.name)}
              >
                <span className="flex items-center justify-between gap-2 w-full">
                  <span className="truncate">{m.name}</span>
                  {typeof m.size === "number" && (
                    <span className="text-text-muted text-meta shrink-0">
                      {(m.size / 1e9).toFixed(1)} GB
                    </span>
                  )}
                </span>
              </DropdownItem>
            ))
          )}
        </>
      ) : (
        provider.models.map((m) => {
          const ctx = formatContextWindow(m.contextWindow);
          const price = formatPricing(m.pricing);
          return (
            <DropdownItem
              key={m.value}
              onClick={() => onModelChange(m.value)}
            >
              <span className="flex items-center justify-between gap-3 w-full">
                <span className="truncate">{m.label}</span>
                {(ctx || price) && (
                  <span className="flex items-center gap-2 shrink-0 text-text-muted text-meta tabular-nums">
                    {ctx && <span>{ctx}</span>}
                    {price && <span>{price}</span>}
                  </span>
                )}
              </span>
            </DropdownItem>
          );
        })
      )}
    </Dropdown>
  );
}
