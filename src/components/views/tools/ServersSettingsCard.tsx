import { useState } from "react";
import { Server, Plus, Pencil, Trash2 } from "lucide-react";
import { useServerStore } from "@/stores/serverStore";
import { ServerFormModal } from "@/components/servers/ServerFormModal";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { summarizeServerUsage, serverUsageWarnings } from "@/lib/serverUsage";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { ServerConfig } from "@/types/server";

/**
 * The ONLY reachable remote-host manager. `ServersView.tsx` used to hold a
 * `window.confirm` here, but nothing ever routed to it (every "open servers"
 * handler navigates to Settings), so in practice a 10px hover trash icon
 * destroyed a live SSH host record with no confirmation at all. The confirm
 * now lives here, on the shared styled idiom, and names both the host and the
 * work currently riding on it.
 */
export function ServersSettingsCard() {
  const servers = useServerStore((s) => s.servers);
  const addServer = useServerStore((s) => s.addServer);
  const updateServer = useServerStore((s) => s.updateServer);
  const deleteServer = useServerStore((s) => s.deleteServer);

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null);
  // Usage is snapshotted when the confirm opens, so the warning text the user
  // agreed to is the text that was on screen.
  const [pendingDelete, setPendingDelete] = useState<{
    server: ServerConfig;
    warnings: string[];
  } | null>(null);

  function handleAdd(config: Omit<ServerConfig, "id" | "installedAgents">) {
    addServer(config);
    setShowForm(false);
  }

  function handleEdit(config: Omit<ServerConfig, "id" | "installedAgents">) {
    if (editingServer) {
      updateServer(editingServer.id, config);
      setEditingServer(null);
    }
  }

  function requestDelete(server: ServerConfig) {
    const usage = summarizeServerUsage(server.id, {
      connectionStates: useServerStore.getState().connectionStates,
      conversations: useAgentTaskStore.getState().conversations,
      flights: useFlightStore.getState().flights,
      workspaces: useWorkspaceStore.getState().workspaces,
    });
    setPendingDelete({ server, warnings: serverUsageWarnings(usage) });
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    deleteServer(pendingDelete.server.id);
    setPendingDelete(null);
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <Server size={12} className="text-accent-blue" />
          Remote Servers
        </h3>
        <button
          onClick={() => { setEditingServer(null); setShowForm(true); }}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
        >
          <Plus size={11} />
          Add Server
        </button>
      </div>

      {servers.length === 0 ? (
        <p className="text-[10px] text-text-muted text-center py-6">
          No servers configured. Add one to connect workspaces to remote machines.
        </p>
      ) : (
        <div className="border border-bg-border rounded-lg overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-bg-primary text-text-muted text-left">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Auth</th>
                <th className="px-3 py-2 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr
                  key={server.id}
                  className="border-t border-bg-border hover:bg-bg-hover transition-colors"
                >
                  <td className="px-3 py-2 text-text-primary font-medium">{server.name}</td>
                  <td className="px-3 py-2 text-text-secondary">
                    {server.host}{server.port !== 22 ? `:${server.port}` : ""}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{server.username}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                      server.authMethod === "agent"
                        ? "bg-accent-green/15 text-accent-green"
                        : server.authMethod === "key"
                          ? "bg-accent-blue/15 text-accent-blue"
                          : "bg-accent-amber/15 text-accent-amber"
                    }`}>
                      {server.authMethod === "agent" ? "SSH Agent" : server.authMethod === "key" ? "Key File" : "Password"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => { setEditingServer(server); setShowForm(true); }}
                        className="p-1 text-text-muted hover:text-accent-blue transition-colors"
                        title="Edit"
                      >
                        <Pencil size={10} />
                      </button>
                      <button
                        onClick={() => requestDelete(server)}
                        className="p-1 text-text-muted hover:text-accent-red transition-colors"
                        title={`Delete ${server.name}`}
                        aria-label={`Delete ${server.name}`}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit modal */}
      {showForm && (
        <ServerFormModal
          onClose={() => { setShowForm(false); setEditingServer(null); }}
          onSubmit={editingServer ? handleEdit : handleAdd}
          initial={editingServer ?? undefined}
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete remote host?"
          entityName={`${pendingDelete.server.name} (${pendingDelete.server.username}@${pendingDelete.server.host}:${pendingDelete.server.port})`}
          description="is removed from this app. Nothing on the remote machine is deleted, and its stored SSH password stays in the OS credential store."
          warnings={pendingDelete.warnings}
          confirmLabel="Delete host"
          onConfirm={confirmDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
