import { useEffect, useMemo, useState } from "react";
import { Plug, Plus, Pencil, Trash2, Globe, FolderOpen, RefreshCw } from "lucide-react";
import { useMcpStore } from "@/stores/mcpStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { McpServerModal } from "../McpServerModal";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { mcpServerTransport, type McpServerEntry } from "@/types/mcp";

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
  // Was an in-place "Confirm" button swap with no cancel affordance and no
  // timeout — a mis-click armed it and the next click destroyed the server.
  const [pendingDelete, setPendingDelete] = useState<McpServerEntry | null>(null);

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
      // Hand over where the row currently lives so a scope change MOVES the
      // server. The modal's Scope buttons are live while editing and read as
      // "this server's scope"; without the old scope the write only upserted
      // into the other file and left the original behind, so switching Global
      // to Project silently produced two servers of the same name.
      await updateServer(
        name,
        command,
        args,
        env,
        scope,
        editEntry.scope as "global" | "project",
      );
    } else {
      await addServer(name, command, args, env, scope);
    }
  }

  async function handleDelete(entry: McpServerEntry) {
    setPendingDelete(null);
    await removeServer(entry.name, entry.scope as "global" | "project");
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
          onRequestDelete={setPendingDelete}
          activeNames={activeNames}
          onToggleDefault={toggleDefaultServer}
        />
        <ServerGroup
          title="Project"
          icon={<FolderOpen size={11} className="text-accent-blue" />}
          servers={projectServers}
          onEdit={handleEdit}
          onRequestDelete={setPendingDelete}
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

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete MCP server?"
          entityName={`${pendingDelete.name} (${pendingDelete.scope})`}
          description="is removed from the MCP config. Agent sessions lose the tools it provides."
          onConfirm={() => void handleDelete(pendingDelete)}
          onClose={() => setPendingDelete(null)}
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
  onRequestDelete,
  activeNames,
  onToggleDefault,
}: {
  title: string;
  icon: React.ReactNode;
  servers: McpServerEntry[];
  onEdit: (entry: McpServerEntry) => void;
  onRequestDelete: (entry: McpServerEntry) => void;
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
          // `McpServerModal` edits exactly one shape: command + args + env.
          // An http/sse server has no `command` — it has `type` and `url` —
          // so the form opened blank on the Command field and refused to save
          // until the user invented one, at which point `upsert_mcp_server`
          // grafted a `command` onto an object that still carried `type`/`url`.
          // The server the user was trying to edit came out neither one thing
          // nor the other. Non-stdio entries are labelled and their Edit button
          // is disabled with the reason, rather than offering a form that
          // cannot describe them.
          const transport = mcpServerTransport(entry);
          const editable = transport === "stdio";
          return (
            <div
              key={key}
              className="flex items-center gap-3 px-3 py-2 bg-bg-primary border border-bg-border rounded-lg group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-text-primary">{entry.name}</span>
                  {!editable && (
                    <span
                      className="text-[9px] px-1 py-0.5 bg-bg-elevated text-text-muted rounded"
                      title="Remote transport — configured by url, not by a command"
                    >
                      {transport}
                    </span>
                  )}
                  {entry.disabled && (
                    <span className="text-[9px] px-1 py-0.5 bg-bg-elevated text-text-muted rounded">
                      disabled
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-muted mt-0.5 truncate">
                  {editable ? (
                    <>
                      {entry.config.command}
                      {entry.config.args?.length ? ` ${entry.config.args.join(" ")}` : ""}
                    </>
                  ) : (
                    // The command line is empty for these; show the endpoint
                    // that actually defines them instead of a blank row.
                    String(entry.rawConfig?.url ?? `${transport} server`)
                  )}
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
                  disabled={!editable}
                  className="p-1 text-text-muted hover:text-accent-blue transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-muted"
                  title={
                    editable
                      ? "Edit"
                      : `This is a ${transport} server, defined by a url rather than a command. Edit it in the ${entry.scope === "global" ? "global settings" : ".mcp.json"} file; this form can only describe command-based servers.`
                  }
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => onRequestDelete(entry)}
                  className="p-1 text-text-muted hover:text-accent-red transition-colors"
                  title={`Delete ${entry.name}`}
                  aria-label={`Delete ${entry.name}`}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
