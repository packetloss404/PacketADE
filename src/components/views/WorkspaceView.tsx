import { useState } from "react";
import { Plus, Trash2, Play, FolderPlus } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore, moduleViewId } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useModuleStore } from "@/stores/moduleStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { isOnboardingComplete } from "@/lib/onboarding";
import { relativeTime } from "@/lib/time";

export function WorkspaceView() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [showCreate, setShowCreate] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");

  // Show onboarding only on a truly fresh state — no workspaces, no project,
  // and the user hasn't dismissed it before. Gated on `initialized` to avoid
  // a flash before bootstrap hydration completes.
  const showOnboarding =
    initialized && !onboardingDone && activeNonArchived.length === 0 && !projectPath;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {!initialized ? null : activeWorkspace ? (
          <WorkspaceMosaicContainer workspace={activeWorkspace} />
        ) : showOnboarding ? (
          <OnboardingPane onComplete={() => setOnboardingDone(true)} />
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
      <p className="text-xs text-text-muted mb-1 max-w-md text-center">
        A Workspace is a tiled set of agent terminals scoped to one project.
      </p>
      <p className="text-sm text-text-secondary mb-6">
        Create one to start coding with AI agents.
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
