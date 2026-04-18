import { useState } from "react";
import { FolderOpen, Rocket, Target, RefreshCw, ArrowRight } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAgentStore } from "@/stores/agentStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { setOnboardingComplete } from "@/lib/onboarding";
import { AgentDetectionList } from "./AgentDetectionList";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import type { WorkspaceAgentSlot } from "@/types/workspace";

interface OnboardingPaneProps {
  /** Called once the user has finished or skipped onboarding. */
  onComplete: () => void;
}

export function OnboardingPane({ onComplete }: OnboardingPaneProps) {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const agents = useAgentStore((s) => s.agents);
  const detecting = useAgentStore((s) => s.detecting);

  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);

  function complete() {
    setOnboardingComplete();
    onComplete();
  }

  const step1Done = !!projectPath;
  // At least one selected agent must be installed.
  const step2Done = Array.from(selectedAgents).some((id) => {
    const agent = agents.find((a) => a.id === id);
    return !!agent?.installed;
  });

  async function handleOpenFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Project Folder",
    });
    if (selected) {
      useLayoutStore.getState().setProjectPath(selected as string);
    }
  }

  function handleToggleAgent(id: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRecheck() {
    void useAgentStore.getState().detectInstalled();
  }

  function handleOpenWorkspace() {
    setShowWorkspaceModal(true);
  }

  function handleWorkspaceClose() {
    setShowWorkspaceModal(false);
    // Mark complete and parent re-renders the live workspace UI in place of
    // the onboarding pane. If the user backed out of the modal without
    // creating, we still consider onboarding done — they've seen everything.
    complete();
  }

  function handleOpenMissions() {
    useAppStore.getState().setActiveView("missions");
    complete();
  }

  function handleSkip() {
    complete();
  }

  // Pre-select all installed agents that the user already chose, mapped to
  // workspace slot IDs (which happen to be identical).
  const initialWorkspaceSelection = new Set<WorkspaceAgentSlot>(
    Array.from(selectedAgents).filter((id) => {
      const agent = agents.find((a) => a.id === id);
      return !!agent?.installed;
    }) as WorkspaceAgentSlot[],
  );

  // Detection finished and zero installed agents → escape hatch message.
  const noneInstalled = !detecting && agents.filter((a) => a.isBuiltin && a.id !== "terminal" && a.installed).length === 0;

  return (
    <div className="flex flex-col items-center flex-1 overflow-y-auto py-8 px-6 bg-bg-primary">
      <div className="w-full max-w-[560px] flex flex-col gap-4">
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-2 select-none">
          <img src="/favicon.png" alt="PacketCode" className="w-12 h-12 mb-3" />
          <h1 className="text-xl font-semibold text-text-primary mb-1">Welcome to PacketCode</h1>
          <p className="text-xs text-text-secondary">Run AI coding agents in tiled terminals.</p>
        </div>

        {/* Step 1 — Open folder */}
        <StepCard step={1} title="Open a project folder" done={step1Done}>
          {projectPath ? (
            <p className="text-[11px] text-text-secondary font-mono truncate mb-2">{projectPath}</p>
          ) : (
            <p className="text-[11px] text-text-muted mb-2">
              PacketCode works on a folder. Pick the project you want to start with.
            </p>
          )}
          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
          >
            <FolderOpen size={12} />
            {projectPath ? "Change Folder…" : "Open Folder…"}
          </button>
        </StepCard>

        {/* Step 2 — Pick agents */}
        <StepCard step={2} title="Pick at least one agent" done={step2Done} disabled={!step1Done}>
          <p className="text-[11px] text-text-muted mb-2">
            PacketCode wraps these AI coding CLIs. Click an installed one to select it.
          </p>
          <AgentDetectionList
            agents={agents}
            detecting={detecting}
            selectedIds={selectedAgents}
            onToggle={handleToggleAgent}
            showInstallHints
          />
          {noneInstalled && (
            <div className="mt-2 px-2.5 py-1.5 text-[10px] text-accent-amber bg-accent-amber/10 border border-accent-amber/30 rounded">
              No CLIs detected. Install one of the above and click Re-check, or click Skip to explore the app.
            </div>
          )}
          <button
            onClick={handleRecheck}
            disabled={detecting}
            className="mt-2 flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          >
            <RefreshCw size={10} className={detecting ? "animate-spin" : ""} />
            Re-check installed
          </button>
        </StepCard>

        {/* Step 3 — Choose destination */}
        <StepCard step={3} title="What do you want to do next?" done={false} disabled={!step1Done || !step2Done}>
          <p className="text-[11px] text-text-muted mb-2">
            A <strong>Workspace</strong> is a tiled set of agent terminals. The <strong>Flight Deck</strong> plans flights and hands them to a Workspace.
          </p>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={handleOpenWorkspace}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
            >
              <Rocket size={12} />
              Open a Workspace
              <ArrowRight size={11} className="ml-auto" />
            </button>
            <button
              onClick={handleOpenMissions}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-accent-purple bg-accent-purple/10 border border-accent-purple/30 rounded hover:bg-accent-purple/20 transition-colors"
            >
              <Target size={12} />
              Open Flight Deck
              <ArrowRight size={11} className="ml-auto" />
            </button>
          </div>
        </StepCard>

        <button
          onClick={handleSkip}
          className="self-center text-[10px] text-text-muted hover:text-text-secondary transition-colors mt-2"
        >
          Skip for now
        </button>
      </div>

      {showWorkspaceModal && (
        <WorkspaceCreationModal
          onClose={handleWorkspaceClose}
          initialSelected={initialWorkspaceSelection}
        />
      )}
    </div>
  );
}

function StepCard({
  step,
  title,
  done,
  disabled = false,
  children,
}: {
  step: number;
  title: string;
  done: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-bg-secondary border border-bg-border rounded-lg px-4 py-3 ${
        disabled ? "opacity-50 pointer-events-none" : ""
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-bg-elevated border border-bg-border text-[10px] text-text-secondary font-medium shrink-0">
          {step}
        </span>
        <span className="text-xs font-semibold text-text-primary flex-1">{title}</span>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            done ? "bg-accent-green" : "border border-text-muted"
          }`}
        />
      </div>
      <div className="pl-7">{children}</div>
    </div>
  );
}
