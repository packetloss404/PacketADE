import { useEffect, useState } from "react";
import { Lightbulb, RefreshCw, Loader2, ChevronDown, ChevronRight, Eye, EyeOff, LayoutGrid } from "lucide-react";
import { useIdeationStore } from "@/stores/ideationStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { API_PROVIDERS, type ApiProviderInfo } from "@/lib/api-models";
import { storageKey } from "@/lib/brand";
import type { Idea, IdeationType } from "@/types/ideation";
import { TYPE_CONFIG, ALL_TYPES } from "./ideation/ideationConfig";
import { IdeaCard } from "./ideation/IdeaCard";
import { IdeaDetail } from "./ideation/IdeaDetail";

/** Map API_PROVIDERS row id → backend `LlmProvider` name. Sidecar/OAuth
 *  rows (anthropic-oauth, openai-codex, openai-agents) are excluded —
 *  Ideation runs through the in-process `LlmProvider` trait only. */
const PROVIDER_ID_TO_BACKEND: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  minimax: "minimax",
  openrouter: "openrouter",
  ollama: "ollama",
};

const LLM_PROVIDERS: ApiProviderInfo[] = API_PROVIDERS.filter(
  (p) => p.id in PROVIDER_ID_TO_BACKEND,
);

const DEFAULT_PROVIDER_ID = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6-20250414";
const PROVIDER_STORAGE_KEY = storageKey("ideation-provider");
const MODEL_STORAGE_KEY = storageKey("ideation-model");

function loadInitialProvider(): { providerId: string; model: string } {
  try {
    if (typeof localStorage === "undefined") return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL };
    const providerId = localStorage.getItem(PROVIDER_STORAGE_KEY) || DEFAULT_PROVIDER_ID;
    const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
    const exists = LLM_PROVIDERS.find((p) => p.id === providerId);
    if (!exists) return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL };
    const modelExists = exists.models.find((m) => m.value === model);
    return { providerId, model: modelExists ? model : exists.models[0]?.value ?? DEFAULT_MODEL };
  } catch {
    return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL };
  }
}

export function IdeationView() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );

  const session = useIdeationStore((s) =>
    activeWorkspaceId ? s.getSession(activeWorkspaceId) : null,
  );
  const isGenerating = useIdeationStore((s) => s.isGenerating);
  const selectedIdeaId = useIdeationStore((s) => s.selectedIdeaId);
  const generate = useIdeationStore((s) => s.generate);
  const selectIdea = useIdeationStore((s) => s.selectIdea);
  const clearSession = useIdeationStore((s) => s.clearSession);

  const [enabledTypes, setEnabledTypes] = useState<IdeationType[]>(ALL_TYPES);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const initial = loadInitialProvider();
  const [providerId, setProviderId] = useState<string>(initial.providerId);
  const [model, setModel] = useState<string>(initial.model);
  const currentProvider = LLM_PROVIDERS.find((p) => p.id === providerId) ?? LLM_PROVIDERS[0];

  useEffect(() => {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(PROVIDER_STORAGE_KEY, providerId);
      localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      // localStorage unavailable — silently ignore.
    }
  }, [providerId, model]);

  function handleProviderChange(nextId: string) {
    const next = LLM_PROVIDERS.find((p) => p.id === nextId);
    if (!next) return;
    setProviderId(nextId);
    setModel(next.models[0]?.value ?? "");
  }

  function toggleType(t: IdeationType) {
    setEnabledTypes((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  }

  function toggleGroup(type: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function handleGenerate() {
    if (enabledTypes.length === 0 || !activeWorkspaceId || !workspace) return;
    // Remote workspaces aren't scannable locally — Phase 3.2/3.3 will
    // wire up a remote-aware scan path. For now, surface a clear message
    // instead of running the local scan against a remote path that
    // doesn't exist on this machine.
    if (workspace.serverId) {
      setError("Ideation scanning isn't supported for remote workspaces yet.");
      return;
    }
    if (!currentProvider || !model) {
      setError("Pick a provider and model first.");
      return;
    }
    const backendProvider = PROVIDER_ID_TO_BACKEND[currentProvider.id];
    if (!backendProvider) {
      setError(`Provider '${currentProvider.id}' is not supported by Ideation yet.`);
      return;
    }
    setError(null);
    try {
      await generate(activeWorkspaceId, workspace.projectPath, enabledTypes, backendProvider, model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // No workspace selected
  if (!activeWorkspaceId || !workspace) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 bg-bg-primary text-text-muted">
        <LayoutGrid size={28} className="mb-3 opacity-30" />
        <p className="text-xs">Select a workspace to scan for ideas</p>
      </div>
    );
  }

  const ideas = session?.ideas || [];
  const visibleIdeas = ideas.filter(
    (i) => enabledTypes.includes(i.type) && (showDismissed || i.status !== "dismissed")
  );

  const grouped = new Map<IdeationType, Idea[]>();
  for (const idea of visibleIdeas) {
    const list = grouped.get(idea.type) || [];
    list.push(idea);
    grouped.set(idea.type, list);
  }

  const activeCount = ideas.filter((i) => i.status === "active").length;
  const convertedCount = ideas.filter((i) => i.status === "converted").length;
  const dismissedCount = ideas.filter((i) => i.status === "dismissed").length;
  const selectedIdea = ideas.find((i) => i.id === selectedIdeaId);

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-bg-primary">
      {/* Header */}
      <div className="px-4 py-3 border-b border-bg-border bg-bg-secondary">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Lightbulb size={16} className="text-accent-amber" />
            <h2 className="text-sm font-medium text-text-primary">Ideation Scanner</h2>
            <span className="text-[10px] text-text-muted px-1.5 py-0.5 bg-bg-elevated rounded">
              {workspace.name}
            </span>
            {ideas.length > 0 && (
              <span className="text-[11px] text-text-muted">
                {ideas.length} ideas ({activeCount} active
                {convertedCount > 0 ? `, ${convertedCount} converted` : ""}
                {dismissedCount > 0 ? `, ${dismissedCount} dismissed` : ""})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={providerId}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={isGenerating}
              className="px-2 py-1 text-[11px] bg-bg-elevated border border-bg-border rounded text-text-secondary focus:outline-none focus:border-accent-green/50 disabled:opacity-40"
              title="LLM provider used to scan the codebase"
            >
              {LLM_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isGenerating || !currentProvider}
              className="px-2 py-1 text-[11px] bg-bg-elevated border border-bg-border rounded text-text-secondary focus:outline-none focus:border-accent-green/50 disabled:opacity-40"
              title="Model used by the selected provider"
            >
              {(currentProvider?.models ?? []).map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {session && (
              <button onClick={() => clearSession(activeWorkspaceId)} className="px-2.5 py-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors">
                Clear
              </button>
            )}
            <button
              onClick={handleGenerate}
              disabled={isGenerating || enabledTypes.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-green/10 text-accent-green border border-accent-green/20 rounded-lg hover:bg-accent-green/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {session ? "Refresh" : "Generate Ideas"}
            </button>
          </div>
        </div>

        {/* Type filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {ALL_TYPES.map((t) => {
            const cfg = TYPE_CONFIG[t];
            const Icon = cfg.icon;
            const active = enabledTypes.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg border transition-colors ${
                  active
                    ? "bg-bg-elevated border-bg-border text-text-primary"
                    : "border-transparent text-text-muted hover:text-text-secondary"
                }`}
              >
                <Icon size={10} className={active ? cfg.color : ""} />
                {cfg.label}
              </button>
            );
          })}
          <div className="w-px h-4 bg-bg-border mx-1" />
          <button
            onClick={() => setShowDismissed(!showDismissed)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
          >
            {showDismissed ? <EyeOff size={10} /> : <Eye size={10} />}
            {showDismissed ? "Hide" : "Show"} dismissed
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isGenerating && (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-accent-green mb-3" />
              <p className="text-sm text-text-secondary">Analyzing {workspace.name}...</p>
              <p className="text-[11px] text-text-muted mt-1">This may take a minute</p>
            </div>
          )}

          {!isGenerating && ideas.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16">
              <Lightbulb size={32} className="text-text-muted mb-3" />
              <p className="text-sm text-text-secondary mb-1">No ideas generated yet</p>
              <p className="text-[11px] text-text-muted mb-4">Select categories and click Generate to scan your codebase</p>
            </div>
          )}

          {!isGenerating &&
            Array.from(grouped.entries()).map(([type, typeIdeas]) => {
              const cfg = TYPE_CONFIG[type];
              const Icon = cfg?.icon || Lightbulb;
              const collapsed = collapsedGroups.has(type);
              return (
                <div key={type}>
                  <button
                    onClick={() => toggleGroup(type)}
                    className="flex items-center gap-2 mb-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <Icon size={12} className={cfg?.color || "text-text-muted"} />
                    <span className="font-medium">{cfg?.label || type}</span>
                    <span className="text-text-muted">({typeIdeas.length})</span>
                  </button>
                  {!collapsed && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 ml-5">
                      {typeIdeas.map((idea) => (
                        <IdeaCard
                          key={idea.id}
                          idea={idea}
                          isSelected={idea.id === selectedIdeaId}
                          onSelect={() => selectIdea(idea.id === selectedIdeaId ? null : idea.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {selectedIdea && (
          <div className="w-80 flex-shrink-0 border-l border-bg-border overflow-y-auto p-4">
            <IdeaDetail idea={selectedIdea} />
          </div>
        )}
      </div>
    </div>
  );
}
