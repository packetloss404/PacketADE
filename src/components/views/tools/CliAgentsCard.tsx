import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Atom,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Diamond,
  Github,
  Hexagon,
  type LucideIcon,
  MousePointer2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  Wand2,
  Wind,
  X,
} from "lucide-react";
import { createGenericConfig } from "@/agents/generic";
import { useAgentStore } from "@/stores/agentStore";
import {
  brandClasses,
  CLI_CATALOG,
  type CliCatalogEntry,
  getCliBinaries,
} from "@/lib/cli-catalog";
import { detectCliCatalog, type DetectCatalogResult } from "@/lib/tauri";
import type { AgentConfig } from "@/types/agent";
import { CliCatalogHeader } from "./CliCatalogHeader";

// Static map from catalog iconName -> lucide component. Catalog uses string
// names so backend/test code can stay framework-agnostic; resolve here.
const ICON_MAP: Record<string, LucideIcon> = {
  Bot,
  Atom,
  Cpu,
  Sparkles,
  Hexagon,
  Terminal,
  Github,
  Wand2,
  MousePointer2,
  BrainCircuit,
  Wind,
  Diamond,
};

function renderCatalogIcon(
  name: string,
  className: string,
): React.ReactElement {
  const Resolved: LucideIcon = ICON_MAP[name] ?? Terminal;
  return <Resolved size={16} className={className} />;
}

// === Custom CLI drawer state (preserved from previous implementation) ===

interface DraftState {
  id: string | null;
  name: string;
  command: string;
  defaultArgsText: string;
  description: string;
  isBuiltin: boolean;
}

function agentToDraft(agent: AgentConfig): DraftState {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    defaultArgsText: agent.defaultArgs.join("\n"),
    description: agent.description,
    isBuiltin: agent.isBuiltin,
  };
}

function emptyDraft(): DraftState {
  return {
    id: null,
    name: "",
    command: "",
    defaultArgsText: "",
    description: "",
    isBuiltin: false,
  };
}

function parseArgs(value: string): string[] {
  return value
    .split("\n")
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function makeCustomAgentId(name: string, command: string): string {
  const seed = `${name || command}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `custom-${seed || "cli"}-${Date.now().toString(36)}`;
}

function commandSummary(agent: AgentConfig): string {
  return [agent.command, ...agent.defaultArgs].filter(Boolean).join(" ");
}

// === Per-card grid component ===

interface CliCatalogCardProps {
  entry: CliCatalogEntry;
  result: DetectCatalogResult | undefined;
  selected: boolean;
  detecting: boolean;
  onSelect: (id: string) => void;
}

function CliCatalogCard({
  entry,
  result,
  selected,
  detecting,
  onSelect,
}: CliCatalogCardProps) {
  const installed = !!result?.installed;
  const brand = brandClasses(entry.color);

  const outerClass = selected
    ? "border-accent-amber/40 bg-accent-amber/5"
    : installed
      ? "border-bg-border bg-bg-secondary hover:bg-bg-elevated"
      : "border-bg-border bg-bg-secondary opacity-70";

  // Per the screenshot reference: selected = filled accent-amber (the
  // "active CLI" highlight), installed-but-unselected = accent-green
  // (passive "ready" indicator), not-installed = faint gray.
  const dotClass = !installed
    ? "bg-text-faint"
    : selected
      ? "bg-accent-amber"
      : "bg-accent-green";

  let versionText: React.ReactNode;
  if (detecting && !result) {
    versionText = <span className="text-text-faint">checking…</span>;
  } else if (!installed) {
    versionText = <span className="italic">not installed</span>;
  } else if (result?.version) {
    versionText = <span className="font-mono">{result.version}</span>;
  } else {
    versionText = <span className="text-text-muted">installed</span>;
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      aria-pressed={selected}
      className={`relative flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors text-left ${outerClass}`}
    >
      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${dotClass}`}
      />

      {/* Icon block */}
      <div
        className={`w-8 h-8 rounded flex items-center justify-center flex-shrink-0 ${
          installed ? brand.iconBg : "bg-bg-elevated"
        }`}
      >
        {installed ? (
          renderCatalogIcon(entry.iconName, brand.iconColor)
        ) : (
          <span className="w-2 h-2 rounded-full bg-text-faint" />
        )}
      </div>

      {/* Name + version */}
      <div className="flex-1 min-w-0 pr-4">
        <div
          className={`text-xs font-medium truncate ${
            installed ? "text-text-primary" : "text-text-secondary"
          }`}
        >
          {entry.name}
        </div>
        <div className="text-[10px] text-text-muted truncate mt-0.5">
          {versionText}
        </div>
      </div>
    </button>
  );
}

// === Main card ===

export function CliAgentsCard() {
  const agents = useAgentStore((s) => s.agents);
  const storeDetecting = useAgentStore((s) => s.detecting);
  const addAgent = useAgentStore((s) => s.addAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const detectInstalled = useAgentStore((s) => s.detectInstalled);
  const resetBuiltins = useAgentStore((s) => s.resetBuiltins);

  const [results, setResults] = useState<Record<string, DetectCatalogResult>>({});
  const [scanning, setScanning] = useState(false);
  const [selectedCliId, setSelectedCliId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);

  const customAgents = useMemo(
    () => agents.filter((a) => !a.isBuiltin),
    [agents],
  );

  // Bulk-scan the catalog via detectCliCatalog (the legacy detectAgent
  // command now routes through the same backend, so a separate fallback
  // path would just duplicate work). On error, log + leave results so
  // the cards render as "not installed" rather than silently lying.
  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      const out = await detectCliCatalog(getCliBinaries());
      const merged: Record<string, DetectCatalogResult> = {};
      for (const r of out) merged[r.id] = r;
      setResults(merged);
      // Keep the legacy agent store in sync for consumers that still read
      // `agentStore.agents[].installed`.
      void detectInstalled();
    } catch (err) {
      console.warn("[cli-catalog] detection failed:", err);
    } finally {
      setScanning(false);
    }
  }, [detectInstalled]);

  // Mount: rescan once if results are empty.
  useEffect(() => {
    if (Object.keys(results).length === 0) {
      void rescan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedCount = useMemo(
    () => CLI_CATALOG.filter((e) => results[e.id]?.installed).length,
    [results],
  );

  const selectedEntry = useMemo(
    () => (selectedCliId ? CLI_CATALOG.find((e) => e.id === selectedCliId) : null) ?? null,
    [selectedCliId],
  );
  const detecting = scanning || storeDetecting;

  function toggleSelect(id: string) {
    setSelectedCliId((prev) => (prev === id ? null : id));
  }

  async function handleTest(): Promise<{ ok: boolean; output: string }> {
    if (!selectedEntry) {
      return { ok: false, output: "No CLI selected." };
    }
    try {
      // Re-probe the selected binary specifically so the user gets fresh
      // installed/version data for the one they care about. Reuses the same
      // detect_cli_catalog command the grid uses for the full sweep.
      const [result] = await detectCliCatalog([
        { id: selectedEntry.id, binary: selectedEntry.binary },
      ]);
      if (!result) {
        return { ok: false, output: "Detection returned no result." };
      }
      // Update the local results map so the card refreshes immediately.
      setResults((prev) => ({ ...prev, [selectedEntry.id]: result }));
      if (!result.installed) {
        return {
          ok: false,
          output: `${selectedEntry.binary} not found on PATH.`,
        };
      }
      const versionLine = result.version
        ? `${selectedEntry.binary} ${result.version}`
        : `${selectedEntry.binary} responds on PATH (no version string)`;
      const pathLine = result.path ? `\n${result.path}` : "";
      return { ok: true, output: `${versionLine}${pathLine}` };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // === Custom CLI drawer handlers (preserved) ===

  function startCreate() {
    setDraft(emptyDraft());
    setAdvancedOpen(true);
  }
  function startEdit(agent: AgentConfig) {
    setDraft(agentToDraft(agent));
    setAdvancedOpen(true);
  }
  function cancel() {
    setDraft(null);
  }
  function save() {
    if (!draft) return;
    const command = draft.command.trim();
    const name = draft.name.trim();
    if (!command || (!draft.isBuiltin && !name)) return;
    const defaultArgs = parseArgs(draft.defaultArgsText);
    if (draft.id) {
      updateAgent(draft.id, {
        command,
        defaultArgs,
        ...(!draft.isBuiltin
          ? { name, description: draft.description.trim() }
          : {}),
      });
    } else {
      const id = makeCustomAgentId(name, command);
      addAgent({
        ...createGenericConfig(id, name, command, draft.description.trim()),
        defaultArgs,
      });
    }
    setDraft(null);
  }
  function confirmRemove(agent: AgentConfig) {
    if (agent.isBuiltin) return;
    if (window.confirm(`Delete CLI agent "${agent.name}"? This cannot be undone.`)) {
      removeAgent(agent.id);
      if (draft?.id === agent.id) setDraft(null);
    }
  }
  function handleResetBuiltins() {
    if (
      window.confirm(
        "Reset built-in CLI agents to their default commands and args? Custom CLI agents will be kept.",
      )
    ) {
      resetBuiltins();
      void detectInstalled();
      if (draft?.isBuiltin) setDraft(null);
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <CliCatalogHeader
        installedCount={installedCount}
        selectedEntry={
          selectedEntry
            ? {
                id: selectedEntry.id,
                name: selectedEntry.name,
                binary: selectedEntry.binary,
              }
            : null
        }
        isRescanning={detecting}
        onRescan={rescan}
        onTest={handleTest}
      />


      {/* 2-column responsive grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {CLI_CATALOG.map((entry) => (
          <CliCatalogCard
            key={entry.id}
            entry={entry}
            result={results[entry.id]}
            selected={selectedCliId === entry.id}
            detecting={detecting}
            onSelect={toggleSelect}
          />
        ))}
      </div>

      {/* Advanced: custom CLI management + reset built-ins */}
      <div className="mt-4 border-t border-bg-border pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-primary transition-colors"
        >
          {advancedOpen ? (
            <ChevronDown size={10} />
          ) : (
            <ChevronRight size={10} />
          )}
          Advanced — custom CLI agents
          {customAgents.length > 0 && (
            <span className="text-[10px] text-text-faint">
              ({customAgents.length})
            </span>
          )}
        </button>

        {advancedOpen && (
          <div className="mt-3">
            <div className="flex items-center justify-end gap-1 mb-2">
              <button
                type="button"
                onClick={handleResetBuiltins}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                title="Reset built-in command overrides"
              >
                <RotateCcw size={10} />
                Reset built-ins
              </button>
              <button
                type="button"
                onClick={startCreate}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
              >
                <Plus size={10} />
                Custom
              </button>
            </div>

            {customAgents.length === 0 && !draft ? (
              <p className="text-[10px] text-text-faint italic">
                No custom CLI agents yet. Click Custom to add one.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {customAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-start gap-2.5 p-2.5 bg-bg-primary border border-bg-border rounded-md"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11.5px] font-semibold text-text-primary">
                          {agent.name}
                        </span>
                        <span className="text-[9px] px-1 py-px rounded bg-bg-elevated text-text-muted">
                          custom
                        </span>
                        {detecting ? (
                          <span className="inline-flex items-center gap-1 text-[9px] text-text-muted">
                            <RefreshCw size={9} className="animate-spin" />
                            checking
                          </span>
                        ) : agent.installed ? (
                          <span className="inline-flex items-center gap-1 text-[9px] text-accent-green">
                            <Check size={9} />
                            installed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[9px] text-accent-amber">
                            <AlertCircle size={9} />
                            not found
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5 line-clamp-1">
                        {agent.description || "No description"}
                      </div>
                      <div
                        className="text-[10px] text-text-faint mt-1 font-mono truncate"
                        title={commandSummary(agent) || "No command"}
                      >
                        {commandSummary(agent) || "No command"}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(agent)}
                        className="p-1 text-text-faint hover:text-accent-blue rounded"
                        title="Edit command and args"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => confirmRemove(agent)}
                        className="p-1 text-text-faint hover:text-accent-red rounded"
                        title="Delete custom CLI agent"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {draft && (
              <div className="mt-3 p-3 border border-accent-blue/40 rounded-md bg-bg-primary">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-text-primary">
                    {draft.id ? `Edit ${draft.name}` : "New custom CLI agent"}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={save}
                      disabled={
                        !draft.command.trim() ||
                        (!draft.isBuiltin && !draft.name.trim())
                      }
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
                    >
                      <Check size={11} />
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancel}
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
                    >
                      <X size={11} />
                      Cancel
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      disabled={draft.isBuiltin}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                      placeholder="My CLI agent"
                      className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary disabled:text-text-muted disabled:opacity-70 focus:outline-none focus:border-accent-blue/60"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] text-text-muted">Command</span>
                    <input
                      type="text"
                      value={draft.command}
                      onChange={(e) =>
                        setDraft({ ...draft, command: e.target.value })
                      }
                      placeholder="claude, codex, C:\\tools\\agent.cmd"
                      className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono"
                    />
                  </label>
                </div>

                {!draft.isBuiltin && (
                  <label className="flex flex-col gap-1 mb-2">
                    <span className="text-[10px] text-text-muted">
                      Description
                    </span>
                    <input
                      type="text"
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({ ...draft, description: e.target.value })
                      }
                      placeholder="What this CLI is used for"
                      className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60"
                    />
                  </label>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-text-muted">
                    Default args, one per line
                  </span>
                  <textarea
                    value={draft.defaultArgsText}
                    onChange={(e) =>
                      setDraft({ ...draft, defaultArgsText: e.target.value })
                    }
                    rows={4}
                    placeholder={"--model\nsonnet"}
                    className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono resize-y"
                  />
                  <span className="text-[9.5px] text-text-faint">
                    Args are passed before the task prompt. Use a wrapper script
                    for complex shell quoting.
                  </span>
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
