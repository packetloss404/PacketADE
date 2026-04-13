import { useState } from "react";
import { Plus, LayoutGrid, Clock, ChevronRight } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { relativeTime } from "@/lib/time";

export function WelcomeScreen() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const [showCreate, setShowCreate] = useState(false);

  const activeWorkspaces = workspaces.filter((w) => w.status === "active");

  function openWorkspace(id: string) {
    setActiveWorkspace(id);
    setActiveView("workspace");
  }

  function goToWorkspaceList() {
    setActiveView("workspace");
  }

  return (
    <div className="flex flex-col items-center justify-center h-full bg-bg-primary select-none">
      <img src="/favicon.png" alt="PacketCode" className="w-14 h-14 mb-5" />
      <h1 className="text-xl font-semibold text-text-primary mb-1">
        PacketCode
      </h1>
      <p className="text-xs text-text-muted mb-8">
        Multi-agent development environment
      </p>

      <div className="flex flex-col gap-4 w-full max-w-sm">
        {/* +New Workspace — always shown */}
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-3 w-full px-4 py-3 bg-bg-secondary border border-accent-green/30 rounded-lg hover:bg-accent-green/5 hover:border-accent-green/50 transition-colors group"
        >
          <div className="w-8 h-8 rounded-lg bg-accent-green/15 flex items-center justify-center">
            <Plus size={16} className="text-accent-green" />
          </div>
          <div className="flex-1 text-left">
            <div className="text-xs font-medium text-accent-green">New Workspace</div>
            <div className="text-[10px] text-text-muted">Configure agents, model, and prompt</div>
          </div>
          <ChevronRight size={14} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>

        {/* Current Workspaces — only if workspaces exist */}
        {activeWorkspaces.length > 0 && (
          <div className="flex flex-col">
            <button
              onClick={goToWorkspaceList}
              className="flex items-center gap-2 mb-2 px-1 group"
            >
              <LayoutGrid size={11} className="text-text-muted" />
              <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">
                Current Workspaces
              </span>
              <span className="text-[10px] text-text-muted">
                ({activeWorkspaces.length})
              </span>
              <div className="flex-1" />
              <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                View all
              </span>
            </button>

            <div className="flex flex-col gap-1.5">
              {activeWorkspaces.slice(0, 5).map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => openWorkspace(ws.id)}
                  className="flex items-center gap-3 w-full px-4 py-2.5 bg-bg-secondary border border-bg-border rounded-lg hover:border-bg-hover hover:bg-bg-hover/50 transition-colors group text-left"
                >
                  <div className="w-7 h-7 rounded-md bg-bg-elevated flex items-center justify-center">
                    <LayoutGrid size={12} className="text-text-secondary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-text-primary truncate">
                      {ws.name}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-text-muted">
                      <span>{ws.agents.length} agent{ws.agents.length !== 1 ? "s" : ""}</span>
                      <span className="flex items-center gap-0.5">
                        <Clock size={8} />
                        {relativeTime(ws.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <ChevronRight size={12} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}

              {activeWorkspaces.length > 5 && (
                <button
                  onClick={goToWorkspaceList}
                  className="text-[10px] text-text-muted hover:text-text-secondary py-1 transition-colors"
                >
                  +{activeWorkspaces.length - 5} more workspace{activeWorkspaces.length - 5 !== 1 ? "s" : ""}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Keyboard shortcuts */}
      <div className="flex gap-4 mt-8 text-[10px] text-text-muted">
        <div className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 bg-bg-elevated border border-bg-border rounded text-[9px]">
            Ctrl+K
          </kbd>
          <span>Command palette</span>
        </div>
        <div className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 bg-bg-elevated border border-bg-border rounded text-[9px]">
            Ctrl+Shift+W
          </kbd>
          <span>Workspaces</span>
        </div>
      </div>

      {showCreate && (
        <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
