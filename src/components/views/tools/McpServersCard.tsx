import { useEffect, useMemo, useState } from "react";
import { Plug, Plus, Pencil, Trash2, Globe, FolderOpen, RefreshCw } from "lucide-react";
import { useMcpStore } from "@/stores/mcpStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { McpServerModal } from "../McpServerModal";
import { Checkbox } from "@/components/ui/Checkbox";
import type { McpServerEntry } from "@/types/mcp";

export function McpServersCard() {
  const { servers, loading, error, fetchServers, addServer, updateServer, removeServer } =
    useMcpStore();
  const defaultEnabledMcpServerIds = useAgentSettingsStore(
    (s) => s.defaultEnabledMcpServerIds,
  );
  const setDefaultEnabledMcpServerIds = useAgentSettingsStore(
    (s) => s.setDefaultEnabledMcpServerIds,
  );
  const [showModal, setShowModal] = useState(false);
  const [editEntry, setEditEntry] = useState<McpServerEntry | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const globalServers = servers.filter((s) => s.scope === "global");
  const projectServers = servers.filter((s) => s.scope === "project");

  // Default MCP set for newly started agent sessions. null = every
  // non-disabled server (mirrors the old header popover's semantics).
  const eligibleServers = useMemo(
    () => servers.filter((s) => !s.disabled),
    [servers],
  );
  const activeNames = useMemo(
    () =>
      defaultEnabledMcpServerIds === null
        ? new Set(eligibleServers.map((s) => s.name))
        : new Set(defaultEnabledMcpServerIds),
    [defaultEnabledMcpServerIds, eligibleServers],
  );

  function toggleDefaultServer(name: string) {
    const current =
      defaultEnabledMcpServerIds ?? eligibleServers.map((s) => s.name);
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    setDefaultEnabledMcpServerIds(next);
  }

  function resetDefaultToAll() {
    setDefaultEnabledMcpServerIds(null);
  }

  function handleEdit(entry: McpServerEntry) {
    setEditEntry(entry);
    setShowModal(true);
  }

  function handleAdd() {
    setEditEntry(null);
    setShowModal(true);
  }

  async function handleSave(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    scope: "global" | "project"
  ) {
    if (editEntry) {
      await updateServer(name, command, args, env, scope);
    } else {
      await addServer(name, command, args, env, scope);
    }
  }

  async function handleDelete(name: string, scope: "global" | "project") {
    await removeServer(name, scope);
    setDeleteConfirm(null);
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <Plug size={12} className="text-accent-blue" />
          MCP Servers
          <span className="text-[10px] text-text-muted font-normal px-1.5 py-0.5 bg-bg-elevated rounded">
            {servers.length} server{servers.length !== 1 ? "s" : ""}
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchServers()}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={handleAdd}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
          >
            <Plus size={11} />
            Add
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 mb-3 bg-red-500/10 border border-red-500/20 rounded text-[11px] text-red-400">
          {error}
        </div>
      )}

      {eligibleServers.length > 0 && (
        <div className="flex items-center justify-between mb-3 px-3 py-1.5 bg-bg-primary border border-bg-border rounded">
          <span className="text-[10px] text-text-muted">
            "On for agent sessions" sets which MCP servers new agent
            conversations start with. Applies to newly started agent
            conversations.
          </span>
          <button
            onClick={resetDefaultToAll}
            className="text-[10px] text-text-muted hover:text-text-primary transition-colors shrink-0 ml-2"
            title="Reset to default — every non-disabled server is enabled"
          >
            Reset to all
          </button>
        </div>
      )}

      <div className="space-y-3">
        <ServerGroup
          title="Global"
          icon={<Globe size={11} className="text-accent-green" />}
          servers={globalServers}
          onEdit={handleEdit}
          onDelete={handleDelete}
          deleteConfirm={deleteConfirm}
          setDeleteConfirm={setDeleteConfirm}
          activeNames={activeNames}
          onToggleDefault={toggleDefaultServer}
        />
        <ServerGroup
          title="Project"
          icon={<FolderOpen size={11} className="text-accent-blue" />}
          servers={projectServers}
          onEdit={handleEdit}
          onDelete={handleDelete}
          deleteConfirm={deleteConfirm}
          setDeleteConfirm={setDeleteConfirm}
          activeNames={activeNames}
          onToggleDefault={toggleDefaultServer}
        />
      </div>

      {servers.length === 0 && !loading && (
        <div className="text-center py-8 text-text-muted text-[11px]">
          <Plug size={20} className="mx-auto mb-2 opacity-30" />
          <p>No MCP servers configured</p>
          <p className="mt-1 text-[10px]">Add servers to extend Claude Code with custom tools</p>
        </div>
      )}

      {showModal && (
        <McpServerModal
          onClose={() => {
            setShowModal(false);
            setEditEntry(null);
          }}
          onSave={handleSave}
          initial={
            editEntry
              ? {
                  name: editEntry.name,
                  command: editEntry.config.command,
                  args: editEntry.config.args ?? [],
                  env: editEntry.config.env ?? {},
                  scope: editEntry.scope as "global" | "project",
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function ServerGroup({
  title,
  icon,
  servers,
  onEdit,
  onDelete,
  deleteConfirm,
  setDeleteConfirm,
  activeNames,
  onToggleDefault,
}: {
  title: string;
  icon: React.ReactNode;
  servers: McpServerEntry[];
  onEdit: (entry: McpServerEntry) => void;
  onDelete: (name: string, scope: "global" | "project") => void;
  deleteConfirm: string | null;
  setDeleteConfirm: (key: string | null) => void;
  activeNames: Set<string>;
  onToggleDefault: (name: string) => void;
}) {
  if (servers.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        {icon}
        <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">
          {title}
        </span>
        <span className="text-[10px] text-text-muted">({servers.length})</span>
      </div>
      <div className="space-y-1">
        {servers.map((entry) => {
          const key = `${entry.scope}:${entry.name}`;
          return (
            <div
              key={key}
              className="flex items-center gap-3 px-3 py-2 bg-bg-primary border border-bg-border rounded-lg group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-text-primary">{entry.name}</span>
                  {entry.disabled && (
                    <span className="text-[9px] px-1 py-0.5 bg-bg-elevated text-text-muted rounded">
                      disabled
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-muted mt-0.5 truncate">
                  {entry.config.command}
                  {entry.config.args?.length ? ` ${entry.config.args.join(" ")}` : ""}
                </div>
                {!entry.disabled && (
                  <Checkbox
                    checked={activeNames.has(entry.name)}
                    onChange={() => onToggleDefault(entry.name)}
                    label="On for agent sessions"
                    className="mt-1 text-[10px]"
                  />
                )}
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onEdit(entry)}
                  className="p-1 text-text-muted hover:text-accent-blue transition-colors"
                  title="Edit"
                >
                  <Pencil size={11} />
                </button>
                {deleteConfirm === key ? (
                  <button
                    onClick={() => onDelete(entry.name, entry.scope as "global" | "project")}
                    className="px-2 py-0.5 text-[10px] bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(key)}
                    className="p-1 text-text-muted hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
