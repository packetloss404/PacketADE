import { useState } from "react";
import { Plug, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";

interface McpServerModalProps {
  onClose: () => void;
  onSave: (
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    scope: "global" | "project",
  ) => void;
  initial?: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    scope: "global" | "project";
  };
}

export function McpServerModal({ onClose, onSave, initial }: McpServerModalProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(initial?.args?.join(" ") ?? "");
  const [scope, setScope] = useState<"global" | "project">(initial?.scope ?? "global");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>(
    initial?.env ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );
  const [saving, setSaving] = useState(false);

  const isEdit = !!initial;

  async function handleSave() {
    if (!name.trim() || !command.trim()) return;
    setSaving(true);
    try {
      const env: Record<string, string> = {};
      for (const pair of envPairs) {
        if (pair.key.trim()) env[pair.key.trim()] = pair.value;
      }
      const argList = args
        .trim()
        .split(/\s+/)
        .filter((a) => a.length > 0);
      await onSave(name.trim(), command.trim(), argList, env, scope);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={isEdit ? "Edit MCP Server" : "Add MCP Server"}
      icon={<Plug size={14} className="text-accent-blue" />}
      width="w-[480px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded bg-bg-primary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || !command.trim()}
            className="hover:bg-accent-green/80 rounded bg-accent-green px-3 py-1.5 text-xs text-bg-primary transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : isEdit ? "Update" : "Add Server"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <div>
          <label className="mb-1 block text-[11px] text-text-secondary">Server Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="e.g. my-mcp-server"
            className="w-full rounded border border-bg-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary focus:border-accent-green focus:outline-none disabled:opacity-50"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-text-secondary">Command</label>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="e.g. npx or node"
            className="w-full rounded border border-bg-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary focus:border-accent-green focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-text-secondary">
            Arguments (space-separated)
          </label>
          <input
            type="text"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
            className="w-full rounded border border-bg-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary focus:border-accent-green focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-text-secondary">Scope</label>
          <div className="flex gap-2">
            <button
              onClick={() => setScope("global")}
              className={`rounded px-3 py-1 text-xs transition-colors ${
                scope === "global"
                  ? "bg-accent-green/20 text-accent-green"
                  : "bg-bg-primary text-text-secondary hover:text-text-primary"
              }`}
            >
              Global
            </button>
            <button
              onClick={() => setScope("project")}
              className={`rounded px-3 py-1 text-xs transition-colors ${
                scope === "project"
                  ? "bg-accent-blue/20 text-accent-blue"
                  : "bg-bg-primary text-text-secondary hover:text-text-primary"
              }`}
            >
              Project
            </button>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[11px] text-text-secondary">Environment Variables</label>
            <button
              onClick={() => setEnvPairs([...envPairs, { key: "", value: "" }])}
              className="text-text-muted hover:text-accent-green"
            >
              <Plus size={12} />
            </button>
          </div>
          {envPairs.map((pair, i) => (
            <div key={i} className="mb-1.5 flex gap-2">
              <input
                type="text"
                value={pair.key}
                onChange={(e) => {
                  const next = [...envPairs];
                  next[i] = { ...next[i], key: e.target.value };
                  setEnvPairs(next);
                }}
                placeholder="KEY"
                className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-accent-green focus:outline-none"
              />
              <input
                type="text"
                value={pair.value}
                onChange={(e) => {
                  const next = [...envPairs];
                  next[i] = { ...next[i], value: e.target.value };
                  setEnvPairs(next);
                }}
                placeholder="value"
                className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-accent-green focus:outline-none"
              />
              <button
                onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))}
                className="text-text-muted hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
