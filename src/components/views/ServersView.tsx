import { useState } from "react";
import { Server, Plus, Trash2, Edit2, Plug, PlugZap } from "lucide-react";
import { useServerStore } from "@/stores/serverStore";
import { useServerConnection } from "@/hooks/useServerConnection";
import { ServerFormModal } from "@/components/servers/ServerFormModal";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { ConnectionProgress } from "@/components/servers/ConnectionProgress";
import { relativeTime } from "@/lib/time";
import type { ServerConfig } from "@/types/server";

const STATUS_DOTS: Record<string, string> = {
  disconnected: "bg-text-muted",
  connecting: "bg-accent-amber animate-pulse",
  connected: "bg-accent-green",
  error: "bg-accent-red",
};

export function ServersView() {
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const connectionStates = useServerStore((s) => s.connectionStates);
  const addServer = useServerStore((s) => s.addServer);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const { connect } = useServerConnection();

  const [showForm, setShowForm] = useState(false);
  const [showWorkspaceCreate, setShowWorkspaceCreate] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null);

  const activeServer = servers.find((s) => s.id === activeServerId);
  const activeConnection = activeServerId ? connectionStates[activeServerId] : undefined;

  function handleConnect(server: ServerConfig) {
    void connect(server);
  }

  function handleDelete(id: string) {
    if (!window.confirm("Delete this server? This cannot be undone.")) return;
    deleteServer(id);
  }

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      {/* Left: Server list */}
      <div className="w-[280px] min-w-[220px] border-r border-bg-border flex flex-col bg-bg-secondary">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bg-border">
          <Server size={13} className="text-accent-blue" />
          <span className="text-xs font-semibold text-text-primary">Servers</span>
          <span className="text-[10px] text-text-muted">({servers.length})</span>
          <div className="flex-1" />
          <button
            onClick={() => setShowForm(true)}
            className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors"
            title="Add server"
          >
            <Plus size={12} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {servers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-text-muted">
              <Server size={24} className="text-text-muted/30" />
              <p className="text-[11px] text-center px-4">
                No servers yet. Add one to start working on remote machines.
              </p>
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
              >
                <Plus size={11} />
                Add Server
              </button>
            </div>
          ) : (
            <div className="py-1">
              {servers.map((server) => {
                const conn = connectionStates[server.id];
                const status = conn?.status ?? "disconnected";
                const isActive = server.id === activeServerId;

                return (
                  <button
                    key={server.id}
                    onClick={() => setActiveServer(server.id)}
                    className={`flex items-start gap-2.5 w-full px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "bg-bg-primary border-l-2 border-accent-green"
                        : "hover:bg-bg-hover border-l-2 border-transparent"
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${STATUS_DOTS[status]}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium text-text-primary truncate">
                        {server.name}
                      </div>
                      <div className="text-[10px] text-text-muted truncate">
                        {server.username}@{server.host}:{server.port}
                      </div>
                      {server.lastConnectedAt && (
                        <div className="text-[9px] text-text-muted mt-0.5">
                          Last: {relativeTime(server.lastConnectedAt)}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Server detail */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!activeServer ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center max-w-sm">
              <Server size={32} className="mx-auto text-text-muted mb-3" />
              <p className="text-xs text-text-secondary">
                Select a server from the left to connect and manage it.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* Server header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-bg-border bg-bg-secondary">
              <Server size={16} className="text-accent-blue shrink-0" />
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">{activeServer.name}</h2>
                <p className="text-[10px] text-text-muted font-mono">
                  {activeServer.username}@{activeServer.host}:{activeServer.port}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {(!activeConnection || activeConnection.status === "disconnected" || activeConnection.status === "error") && (
                  <button
                    onClick={() => handleConnect(activeServer)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
                  >
                    <PlugZap size={11} />
                    Connect
                  </button>
                )}
                {activeConnection?.status === "connected" && (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-accent-green">
                    <Plug size={11} />
                    Connected
                  </span>
                )}
                <button
                  onClick={() => setEditingServer(activeServer)}
                  className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                  title="Edit server"
                >
                  <Edit2 size={11} />
                </button>
                <button
                  onClick={() => handleDelete(activeServer.id)}
                  className="p-1.5 text-text-muted hover:text-accent-red hover:bg-bg-hover rounded transition-colors"
                  title="Delete server"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>

            {/* Server info */}
            <div className="px-4 py-3 border-b border-bg-border">
              <div className="grid grid-cols-2 gap-3 text-[10px]">
                <div>
                  <span className="text-text-muted">Auth Method</span>
                  <p className="text-text-primary font-medium mt-0.5">
                    {activeServer.authMethod === "agent" ? "SSH Agent" : activeServer.authMethod === "key" ? "Key File" : "Password"}
                  </p>
                </div>
                {activeServer.keyPath && (
                  <div>
                    <span className="text-text-muted">Key</span>
                    <p className="text-text-primary font-mono mt-0.5 truncate">{activeServer.keyPath}</p>
                  </div>
                )}
                {activeServer.remotePath && (
                  <div>
                    <span className="text-text-muted">Remote Path</span>
                    <p className="text-text-primary font-mono mt-0.5 truncate">{activeServer.remotePath}</p>
                  </div>
                )}
                {activeServer.installedAgents.length > 0 && (
                  <div>
                    <span className="text-text-muted">Agents</span>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {activeServer.installedAgents.map((a) => (
                        <span key={a} className="text-[9px] px-1.5 py-0.5 bg-accent-green/10 text-accent-green rounded">
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Connection progress */}
            {activeConnection && activeConnection.steps.length > 0 && (
              <div className="px-4 py-3 border-b border-bg-border">
                <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide mb-2">
                  Connection Progress
                </h3>
                <ConnectionProgress
                  steps={activeConnection.steps}
                  onRetry={() => handleConnect(activeServer)}
                />
              </div>
            )}

            {/* Connected state — ready to create workspace */}
            {activeConnection?.status === "connected" && (
              <div className="flex-1 flex items-center justify-center py-8">
                <div className="text-center">
                  <Plug size={28} className="mx-auto text-accent-green mb-3" />
                  <p className="text-xs text-text-secondary mb-4">
                    Connected to {activeServer.name}. Create a workspace to start working.
                  </p>
                  <button
                    onClick={() => setShowWorkspaceCreate(true)}
                    className="flex items-center gap-2 mx-auto px-4 py-2 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded-lg font-medium hover:bg-accent-green/25 transition-colors"
                  >
                    <Plus size={14} />
                    Create Remote Workspace
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {showForm && (
        <ServerFormModal
          onClose={() => setShowForm(false)}
          onSubmit={(config) => addServer(config)}
        />
      )}
      {editingServer && (
        <ServerFormModal
          initial={editingServer}
          onClose={() => setEditingServer(null)}
          onSubmit={(config) => {
            useServerStore.getState().updateServer(editingServer.id, config);
            setEditingServer(null);
          }}
        />
      )}
      {showWorkspaceCreate && activeServer && (
        <WorkspaceCreationModal
          onClose={() => setShowWorkspaceCreate(false)}
          serverId={activeServer.id}
          remoteProjectPath={activeServer.remotePath}
        />
      )}
    </div>
  );
}
