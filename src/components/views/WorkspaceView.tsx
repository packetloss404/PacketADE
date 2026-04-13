import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { isOnboardingComplete } from "@/lib/onboarding";
import { useState } from "react";
import { LayoutGrid } from "lucide-react";

export function WorkspaceView() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");

  const showOnboarding =
    initialized && !onboardingDone && activeNonArchived.length === 0 && !projectPath;

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden relative">
        {/* All active workspaces stay mounted so PTY sessions persist */}
        {initialized && activeNonArchived.map((ws) => (
          <div
            key={ws.id}
            className="flex flex-col flex-1 overflow-hidden"
            style={{ display: ws.id === activeWorkspaceId ? "flex" : "none" }}
          >
            <WorkspaceMosaicContainer workspace={ws} />
          </div>
        ))}

        {/* No workspace selected */}
        {initialized && !activeWorkspace && (
          showOnboarding ? (
            <OnboardingPane onComplete={() => setOnboardingDone(true)} />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 select-none text-text-muted">
              <LayoutGrid size={28} className="mb-3 opacity-30" />
              <p className="text-xs">Select a workspace from the sidebar or create a new one</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
