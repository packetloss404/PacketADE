import { useState } from "react";
import { LayoutGrid, Plus, Archive, Trash2, Play, FolderPlus } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore, moduleViewId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
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
  const keepTerminalsAlive = useWorkspaceStore((s) => s.keepTerminalsAlive);
  const [showCreate, setShowCreate] = useState(false);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");

  // Cleanup PTY sessions when closing a workspace (unless keepTerminalsAlive)
  async function handleCloseWorkspace(id: string) {
    if (!keepTerminalsAlive) {
      const ws = workspaces.find((w) => w.id === id);
      if (ws) {
        await Promise.all(
          ws.panes
            .filter((p) => p.sessionId)
            .map((p) => killPty(p.sessionId!).catch(() => {}))
        );
      }
    }
    setActiveWorkspace(null);
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {activeWorkspace ? (
          <>
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
                title="Archive workspace"
              >
                <Archive size={10} />
              </button>
            </div>

            <BroadcastBar workspace={activeWorkspace} />
            <WorkspaceMosaicContainer workspace={activeWorkspace} />
          </>
        ) : (
          // Empty / list view
          <div className="flex flex-col flex-1 overflow-y-auto p-6">

            {activeNonArchived.length === 0 ? (
              <WelcomePane onCreateWorkspace={() => setShowCreate(true)} />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {activeNonArchived.map((ws) => (
                  <div
                    key={ws.id}
                    className="bg-bg-secondary border border-bg-border rounded-lg p-4 hover:border-accent-green/30 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="text-xs font-medium text-text-primary">{ws.name}</h3>
                      <button
                        onClick={() => deleteWorkspace(ws.id)}
                        className="p-1 text-text-muted hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
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
        )}
      </div>

    </div>
  );
}

function WelcomePane({ onCreateWorkspace }: { onCreateWorkspace: () => void }) {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const scaffoldEnabled = useModuleStore((s) => s.isEnabled("scaffold"));

  return (
    <div className="flex flex-col items-center justify-center flex-1 select-none">
      <img src="/favicon.png" alt="PacketCode" className="w-16 h-16 mb-4" />
      <h1 className="text-2xl font-semibold text-text-primary mb-1">PacketCode</h1>
      <p className="text-[11px] text-text-muted mb-1">Isolated multi-agent grids</p>
      <p className="text-sm text-text-secondary mb-6">
        Create a <span className="text-text-primary font-medium">Workspace</span> to start coding with AI agents
      </p>

      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onCreateWorkspace}
          className="flex items-center gap-2 px-4 py-2 bg-accent-green/20 text-accent-green text-xs font-medium rounded-lg hover:bg-accent-green/30 transition-colors"
        >
          <Plus size={14} />
          New Workspace
        </button>

        {scaffoldEnabled && (
          <button
            onClick={() => setActiveView(moduleViewId("scaffold"))}
            className="flex items-center gap-2 px-4 py-2 bg-accent-amber/20 text-accent-amber text-xs font-medium rounded-lg hover:bg-accent-amber/30 transition-colors"
          >
            <FolderPlus size={14} />
            New Project
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-[11px] text-text-muted">
        <div className="flex items-center gap-3">
          <kbd className="px-1.5 py-0.5 bg-bg-elevated border border-bg-border rounded text-[10px]">Ctrl+Shift+1</kbd>
          <span>Workspaces</span>
        </div>
        <div className="flex items-center gap-3">
          <kbd className="px-1.5 py-0.5 bg-bg-elevated border border-bg-border rounded text-[10px]">Ctrl+Shift+3</kbd>
          <span>Issues</span>
        </div>
        <div className="flex items-center gap-3">
          <kbd className="px-1.5 py-0.5 bg-bg-elevated border border-bg-border rounded text-[10px]">Ctrl+Shift+5</kbd>
          <span>Tools</span>
        </div>
      </div>
    </div>
  );
}
