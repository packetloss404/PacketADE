import { useState } from "react";
import {
  AlertCircle,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { createGenericConfig } from "@/agents/generic";
import { useAgentStore } from "@/stores/agentStore";
import type { AgentConfig } from "@/types/agent";

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

export function CliAgentsCard() {
  const agents = useAgentStore((s) => s.agents);
  const detecting = useAgentStore((s) => s.detecting);
  const addAgent = useAgentStore((s) => s.addAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const detectInstalled = useAgentStore((s) => s.detectInstalled);
  const resetBuiltins = useAgentStore((s) => s.resetBuiltins);

  const [draft, setDraft] = useState<DraftState | null>(null);

  const installedCount = agents.filter((a) => a.installed).length;
  const customCount = agents.filter((a) => !a.isBuiltin).length;

  function startCreate() {
    setDraft(emptyDraft());
  }

  function startEdit(agent: AgentConfig) {
    setDraft(agentToDraft(agent));
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
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <Terminal size={12} className="text-accent-green" />
          CLI Agents
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void detectInstalled()}
            disabled={detecting}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
            title="Refresh installed CLI status"
          >
            <RefreshCw size={10} className={detecting ? "animate-spin" : ""} />
            Detect
          </button>
          <button
            type="button"
            onClick={handleResetBuiltins}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            title="Reset built-in command overrides"
          >
            <RotateCcw size={10} />
            Reset
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
      </div>

      <p className="text-[10px] text-text-muted mb-3">
        Configure PTY-backed CLI agents used by launches and routing. Built-ins
        can be retargeted to wrapper scripts or absolute paths; custom agents
        use the generic terminal adapter.
      </p>

      <div className="flex items-center gap-2 mb-3 text-[10px] text-text-faint">
        <span className="px-1.5 py-0.5 rounded bg-bg-primary border border-bg-border">
          {installedCount}/{agents.length} detected
        </span>
        <span className="px-1.5 py-0.5 rounded bg-bg-primary border border-bg-border">
          {customCount} custom
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-start gap-2.5 p-2.5 bg-bg-primary border border-bg-border rounded-md"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11.5px] font-semibold text-text-primary">
                  {agent.name}
                </span>
                {agent.isBuiltin ? (
                  <span className="text-[9px] px-1 py-px rounded bg-accent-blue/15 text-accent-blue">
                    built-in
                  </span>
                ) : (
                  <span className="text-[9px] px-1 py-px rounded bg-bg-elevated text-text-muted">
                    custom
                  </span>
                )}
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
              {!agent.isBuiltin && (
                <button
                  type="button"
                  onClick={() => confirmRemove(agent)}
                  className="p-1 text-text-faint hover:text-accent-red rounded"
                  title="Delete custom CLI agent"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

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
                disabled={!draft.command.trim() || (!draft.isBuiltin && !draft.name.trim())}
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
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="My CLI agent"
                className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary disabled:text-text-muted disabled:opacity-70 focus:outline-none focus:border-accent-blue/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">Command</span>
              <input
                type="text"
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder="claude, codex, C:\\tools\\agent.cmd"
                className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono"
              />
            </label>
          </div>

          {!draft.isBuiltin && (
            <label className="flex flex-col gap-1 mb-2">
              <span className="text-[10px] text-text-muted">Description</span>
              <input
                type="text"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
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
              onChange={(e) => setDraft({ ...draft, defaultArgsText: e.target.value })}
              rows={4}
              placeholder={"--model\nsonnet"}
              className="bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60 font-mono resize-y"
            />
            <span className="text-[9.5px] text-text-faint">
              Args are passed before the task prompt. Use a wrapper script for
              complex shell quoting.
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
