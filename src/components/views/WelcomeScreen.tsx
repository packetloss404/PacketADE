import { useState } from "react";
import { Plus, LayoutGrid, Clock, ChevronRight } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { relativeTime } from "@/lib/time";
import { getAgentColor } from "@/lib/agentColors";
import { ROUTE_REGISTRY } from "@/lib/routeRegistry";
import { APP_NAME } from "@/lib/brand";

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
    <div className="flex flex-col items-center justify-center h-full bg-bg-primary select-none" style={{ animation: 'welcomeFadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both' }}>
      <img src="/favicon.png" alt={APP_NAME} className="w-20 h-20 mb-6" />
      <h1 className="text-xl font-semibold text-text-primary mb-1">
        {APP_NAME}
      </h1>
      <p className="text-xs text-text-muted mb-8">
        Multiple coding agents. Shared context. You stay in control.
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
              {activeWorkspaces.slice(0, 5).map((ws, idx) => (
                <button
                  key={ws.id}
                  onClick={() => openWorkspace(ws.id)}
                  className={`relative flex items-center gap-3 w-full px-4 py-2.5 ${idx === 0 ? "bg-bg-tertiary" : "bg-bg-secondary"} border border-bg-border rounded-lg hover:border-bg-hover hover:bg-bg-hover/50 transition-colors group text-left`}
                >
                  {idx === 0 && (
                    <span
                      className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r"
                      style={{ background: "var(--color-accent-green)" }}
                    />
                  )}
                  <div className="w-7 h-7 rounded-md bg-bg-elevated flex items-center justify-center flex-shrink-0">
                    <LayoutGrid size={12} className="text-text-secondary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-text-primary truncate">
                      {ws.name}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-text-muted mt-0.5 min-w-0">
                      <span className="font-mono truncate min-w-0">
                        {shortenPath(ws.projectPath)}
                      </span>
                      {ws.panes.length > 0 && (
                        <>
                          <span className="text-text-faint flex-shrink-0">·</span>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            {ws.panes.slice(0, 4).map((pane) => (
                              <span
                                key={pane.id}
                                className={`w-1.5 h-1.5 rounded-full inline-block ${getAgentColor(pane.agentId).text} bg-current`}
                                title={pane.agentId}
                              />
                            ))}
                            {ws.panes.length > 4 && (
                              <span className="text-[9px] text-text-faint ml-0.5">
                                +{ws.panes.length - 4}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                      <span className="text-text-faint flex-shrink-0">·</span>
                      <span className="flex items-center gap-0.5 flex-shrink-0">
                        <Clock size={8} />
                        {relativeTime(ws.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <ChevronRight size={12} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
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
          {/* D4: chord label comes from the one route registry. */}
          <kbd className="px-1.5 py-0.5 bg-bg-elevated border border-bg-border rounded text-[9px]">
            {ROUTE_REGISTRY.workspace.hotkey?.display}
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

function shortenPath(p: string): string {
  const segments = p.split(/[/\\]/).filter(Boolean);
  if (segments.length <= 2) return segments.join("/");
  return "…/" + segments.slice(-2).join("/");
}
