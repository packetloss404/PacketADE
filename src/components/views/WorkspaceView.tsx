import { useState } from "react";
import { LayoutGrid, Plus, Archive, Trash2, Play } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { WorkspaceGrid } from "@/components/workspace/WorkspaceGrid";
import { BroadcastBar } from "@/components/workspace/BroadcastBar";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { killPty } from "@/lib/tauri";
import { relativeTime } from "@/lib/time";

export function WorkspaceView() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const archiveWorkspace = useWorkspaceStore((s) => s.archiveWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const [showCreate, setShowCreate] = useState(false);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");

  // Cleanup PTY sessions when closing a workspace
  async function handleCloseWorkspace(id: string) {
    const ws = workspaces.find((w) => w.id === id);
    if (ws) {
      await Promise.all(
        ws.panes
          .filter((p) => p.sessionId)
          .map((p) => killPty(p.sessionId!).catch(() => {}))
      );
    }
    setActiveWorkspace(null);
  }

  // If active workspace renders the grid + right sidebar
  if (activeWorkspace) {
    return (
      <div className="flex flex-1 overflow-hidden">
        {/* Main grid area */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Workspace toolbar */}
          <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-bg-border">
            <LayoutGrid size={12} className="text-accent-green" />
            <span className="text-xs font-medium text-text-primary">{activeWorkspace.name}</span>
            <span className="text-[10px] text-text-muted">
              {activeWorkspace.agents.length} agent{activeWorkspace.agents.length !== 1 ? "s" : ""}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => handleCloseWorkspace(activeWorkspace.id)}
              className="px-2 py-0.5 text-[10px] text-text-secondary hover:text-text-primary bg-bg-primary border border-bg-border rounded transition-colors"
            >
              Close
            </button>
            <button
              onClick={() => {
                handleCloseWorkspace(activeWorkspace.id);
                archiveWorkspace(activeWorkspace.id);
              }}
              className="px-2 py-0.5 text-[10px] text-text-muted hover:text-accent-amber bg-bg-primary border border-bg-border rounded transition-colors"
            >
              <Archive size={10} />
            </button>
          </div>

          {/* Broadcast bar */}
          <BroadcastBar workspace={activeWorkspace} />

          {/* Agent grid */}
          <WorkspaceGrid workspace={activeWorkspace} />
        </div>

        {/* Right sidebar — workspace list */}
        <div className="w-56 flex flex-col bg-bg-secondary border-l border-bg-border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border">
            <span className="text-[10px] uppercase tracking-wide text-text-muted font-semibold">Workspaces</span>
            <button
              onClick={() => setShowCreate(true)}
              className="p-1 text-text-muted hover:text-accent-green transition-colors"
              title="New workspace"
            >
              <Plus size={11} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {activeNonArchived.map((ws) => {
              const isActive = ws.id === activeWorkspace.id;
              return (
                <button
                  key={ws.id}
                  onClick={() => setActiveWorkspace(ws.id)}
                  className={`flex items-start gap-2 w-full px-3 py-2 text-left transition-colors ${
                    isActive
                      ? "bg-bg-elevated border-l-2 border-accent-green"
                      : "hover:bg-bg-hover border-l-2 border-transparent"
                  }`}
                >
                  <LayoutGrid size={11} className={`mt-0.5 ${isActive ? "text-accent-green" : "text-text-muted"}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[11px] font-medium truncate ${isActive ? "text-text-primary" : "text-text-secondary"}`}>
                      {ws.name}
                    </div>
                    <div className="text-[9px] text-text-muted truncate">
                      {ws.agents.join(" · ")}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {/* Project info footer */}
          <div className="border-t border-bg-border px-3 py-2">
            <div className="text-[9px] uppercase tracking-wide text-text-muted font-semibold mb-1">Project</div>
            <div className="text-[10px] text-text-secondary truncate" title={activeWorkspace.projectPath}>
              {activeWorkspace.projectPath.split(/[/\\]/).pop() || "—"}
            </div>
          </div>
        </div>

        {showCreate && (
          <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
        )}
      </div>
    );
  }

  // Workspace list view
  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <LayoutGrid size={16} className="text-accent-green" />
          <h1 className="text-sm font-semibold text-text-primary">Workspaces</h1>
          <span className="text-[10px] text-text-muted">
            Isolated multi-agent grids
          </span>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors"
        >
          <Plus size={12} />
          New Workspace
        </button>
      </div>

      {activeNonArchived.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-text-muted">
          <LayoutGrid size={32} className="mb-3 opacity-30" />
          <p className="text-xs mb-1">No workspaces yet</p>
          <p className="text-[10px]">Create a workspace to run multiple AI agents side by side</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {activeNonArchived.map((ws) => (
            <div
              key={ws.id}
              className="bg-bg-secondary border border-bg-border rounded-lg p-4 hover:border-accent-green/30 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-xs font-medium text-text-primary">{ws.name}</h3>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => deleteWorkspace(ws.id)}
                    className="p-1 text-text-muted hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1.5 mb-3">
                {ws.agents.map((agentId) => (
                  <span
                    key={agentId}
                    className="px-1.5 py-0.5 text-[9px] bg-bg-primary border border-bg-border rounded text-text-secondary"
                  >
                    {agentId}
                  </span>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-text-muted">
                  {relativeTime(ws.createdAt)}
                </span>
                <button
                  onClick={() => setActiveWorkspace(ws.id)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
                >
                  <Play size={10} />
                  Launch
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
