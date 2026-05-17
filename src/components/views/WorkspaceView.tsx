import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useEditorStore } from "@/stores/editorStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAgentStore } from "@/stores/agentStore";
import { useServerStore } from "@/stores/serverStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { EditorPane } from "@/components/editor/EditorPane";
import { isOnboardingComplete } from "@/lib/onboarding";
import { useState, useRef, useEffect } from "react";
import { LayoutGrid, GitBranch, FileText, Plus, Zap, Brain } from "lucide-react";
import { GitDashboard } from "@/components/workspace/GitDashboard";
import { PaneLayoutControls } from "@/components/workspace/PaneLayoutControls";
import type { WorkspaceAgentSlot, Workspace } from "@/types/workspace";

const agentLabel: Record<WorkspaceAgentSlot, string> = {
  "terminal": "Terminal",
  "claude-code": "Claude",
  "codex": "Codex",
  "gemini": "Gemini",
  "opencode": "OpenCode",
  "packetcode": "PacketCode",
};

const agentColor: Record<WorkspaceAgentSlot, string> = {
  "terminal": "bg-text-muted/20 text-text-secondary",
  "claude-code": "bg-accent-green/20 text-accent-green",
  "codex": "bg-blue-500/20 text-blue-400",
  "gemini": "bg-purple-500/20 text-purple-400",
  "opencode": "bg-orange-500/20 text-orange-400",
  "packetcode": "bg-purple-500/20 text-purple-400",
};

export function WorkspaceView() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setBypassPermissions = useWorkspaceStore((s) => s.setBypassPermissions);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const memoryPatterns = useMemoryStore((s) => s.patterns);
  const memoryLearning = useMemoryStore((s) => s.isLearning);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const addAgentRef = useRef<HTMLDivElement>(null);
  const addPane = useWorkspaceStore((s) => s.addPane);
  const agents = useAgentStore((s) => s.agents);
  const servers = useServerStore((s) => s.servers);

  const openFiles = useEditorStore((s) => s.openFiles);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const closeFile = useEditorStore((s) => s.closeFile);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);

  const activeOpenFile = openFiles.find((f) => f.id === activeFileId) ?? null;
  const editorVisible = openFiles.length > 0;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");
  const isAgentInstalledForWorkspace = (agent: WorkspaceAgentSlot, workspace: Workspace) => {
    if (agent === "terminal") return true;
    if (workspace.serverId) {
      const server = servers.find((srv) => srv.id === workspace.serverId);
      return !!server?.installedAgents.includes(agent);
    }
    return !!agents.find((cfg) => cfg.id === agent)?.installed;
  };

  const showOnboarding =
    initialized && !onboardingDone && activeNonArchived.length === 0 && !projectPath;

  const bypassOn = activeWorkspace?.bypassPermissions ?? false;
  const memoryActive = memoryLearning || memoryPatterns.length > 0;

  // Close add-agent popover on outside click
  useEffect(() => {
    if (!addAgentOpen) return;
    const handler = (e: MouseEvent) => {
      if (addAgentRef.current && !addAgentRef.current.contains(e.target as Node)) {
        setAddAgentOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addAgentOpen]);

  // Count agents per type for the active workspace
  const agentCounts: Partial<Record<WorkspaceAgentSlot, number>> = {};
  if (activeWorkspace) {
    for (const pane of activeWorkspace.panes) {
      agentCounts[pane.agentId] = (agentCounts[pane.agentId] || 0) + 1;
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden relative">
        {/* Merged header: workspace tabs · agent badges · + Add Agent · git
            toggle · pane-layout presets · bypass perms · memory indicator.
            Replaces the previous two-row layout (workspace context header
            stacked above WorkspaceSubTabs). The active tab's tooltip now
            carries the project-path info the old folder chip used to show. */}
        {initialized && activeNonArchived.length > 0 && (
          <div className="flex items-stretch h-[33px] bg-bg-primary border-b border-line-soft px-2 shrink-0">
            <div className="flex items-stretch gap-0 overflow-x-auto">
              {activeNonArchived.map((ws) => {
                const isActive = ws.id === activeWorkspaceId;
                const dot = workspaceStatusDot(ws);
                return (
                  <button
                    key={ws.id}
                    onClick={() => setActiveWorkspace(ws.id)}
                    title={ws.projectPath}
                    className={`relative flex items-center gap-1.5 px-3 text-[11px] whitespace-nowrap transition-colors ${
                      isActive
                        ? "text-text-primary"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${dot.className} ${dot.pulse ? "animate-pulse" : ""}`}
                    />
                    <span>{ws.name}</span>
                    {isActive && (
                      <span className="absolute left-2 right-2 bottom-0 h-[2px] bg-accent-green rounded-t" />
                    )}
                  </button>
                );
              })}
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center px-2 text-text-muted hover:text-text-primary transition-colors"
                title="New workspace"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {activeWorkspace && Object.entries(agentCounts).map(([agent, count]) => (
                <span
                  key={agent}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${agentColor[agent as WorkspaceAgentSlot] || "bg-text-muted/20 text-text-secondary"}`}
                >
                  {agentLabel[agent as WorkspaceAgentSlot] || agent}
                  {(count as number) > 1 && ` x${count}`}
                </span>
              ))}
              {activeWorkspace && (
                <div className="relative" ref={addAgentRef}>
                  <button
                    onClick={() => setAddAgentOpen((v) => !v)}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                      addAgentOpen
                        ? "bg-accent-green/20 text-accent-green"
                        : "text-text-muted hover:text-text-primary hover:bg-bg-tertiary"
                    }`}
                    title="Add agent to workspace"
                  >
                    <Plus size={11} />
                    Add Agent
                  </button>
                  {addAgentOpen && (
                    <div className="absolute right-0 top-full mt-1 bg-bg-tertiary border border-bg-border rounded shadow-lg z-50 min-w-[150px] py-1">
                      {(["claude-code", "codex", "gemini", "opencode", "packetcode", "terminal"] as WorkspaceAgentSlot[]).map((agent) => {
                        const installed = isAgentInstalledForWorkspace(agent, activeWorkspace);
                        return (
                          <button
                            key={agent}
                            onClick={() => {
                              if (!installed) return;
                              addPane(activeWorkspace.id, agent);
                              setAddAgentOpen(false);
                            }}
                            disabled={!installed}
                            title={installed ? `Add ${agentLabel[agent]}` : `${agentLabel[agent]} is not installed for this workspace`}
                            className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2 ${
                              installed
                                ? "text-text-secondary hover:text-text-primary hover:bg-bg-secondary"
                                : "text-text-muted opacity-50 cursor-not-allowed"
                            }`}
                          >
                            <span className={`w-2 h-2 rounded-full ${agentColor[agent]?.split(" ")[0] ?? "bg-text-muted/20"}`} />
                            {agentLabel[agent]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {activeWorkspace && (
                <button
                  onClick={() => setGitPanelOpen((v) => !v)}
                  className={`p-1 rounded transition-colors ${
                    gitPanelOpen
                      ? "bg-accent-green/20 text-accent-green"
                      : "text-text-muted hover:text-text-primary hover:bg-bg-tertiary"
                  }`}
                  title="Git Dashboard"
                >
                  <GitBranch size={12} />
                </button>
              )}
              <PaneLayoutControls />
              <button
                onClick={() => activeWorkspace && setBypassPermissions(activeWorkspace.id, !bypassOn)}
                disabled={!activeWorkspace}
                className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  bypassOn
                    ? "border-accent-line bg-accent-soft text-accent-amber"
                    : "border-bg-border bg-bg-secondary text-text-muted hover:text-text-secondary"
                } disabled:opacity-50`}
                title="Bypass permission prompts for this workspace"
              >
                <Zap size={10} />
                <span>Bypass perms: {bypassOn ? "on" : "off"}</span>
              </button>
              <span
                className={`flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border ${
                  memoryActive
                    ? "border-accent-line bg-accent-soft text-accent-green"
                    : "border-bg-border bg-bg-secondary text-text-muted"
                }`}
                title={memoryLearning ? "Memory layer is summarizing recent sessions" : "Top patterns will be injected on next session"}
              >
                <Brain size={10} />
                <span>{memoryLearning ? "Memory learning" : "Memory injecting"}</span>
              </span>
            </div>
          </div>
        )}
        {showCreate && (
          <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
        )}

        {/* Main content area: workspace panes + optional git panel */}
        <div className="flex flex-1 overflow-hidden">
          {/* Workspace panes */}
          <div className="flex flex-col flex-1 overflow-hidden">
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
          </div>

          {/* Editor panel.
              Phase 3.1: EditorPane uses local-FS Tauri commands
              (`read_file_contents` / `write_file_contents`) and isn't
              wired for remote workspaces yet, so we render a
              placeholder instead. Phase 3.2/3.3 will add a remote-aware
              editor path. */}
          {editorVisible && activeWorkspace && activeOpenFile && (
            <div className="w-[480px] shrink-0 border-l border-bg-border bg-bg-primary overflow-hidden flex flex-col">
              {/* File tabs */}
              {openFiles.length > 1 && (
                <div className="flex items-center bg-bg-secondary border-b border-bg-border overflow-x-auto shrink-0">
                  {openFiles.map((f) => {
                    const name = f.path.replace(/\\/g, "/").split("/").pop() || f.path;
                    const isActive = f.id === activeFileId;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setActiveFile(f.id)}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] border-r border-bg-border whitespace-nowrap transition-colors ${
                          isActive
                            ? "bg-bg-primary text-text-primary"
                            : "text-text-muted hover:text-text-secondary hover:bg-bg-tertiary"
                        }`}
                      >
                        <FileText size={10} />
                        {name}
                      </button>
                    );
                  })}
                </div>
              )}
              {activeWorkspace.serverId ? (
                <div className="flex flex-col items-center justify-center flex-1 px-6 text-center select-none">
                  <FileText size={20} className="text-text-muted opacity-40 mb-2" />
                  <p className="text-xs text-text-secondary mb-1">
                    Editor not yet available for remote workspaces
                  </p>
                  <p className="text-[11px] text-text-muted">
                    Open the workspace locally to edit files.
                  </p>
                </div>
              ) : (
                <EditorPane
                  key={activeOpenFile.id}
                  filePath={activeOpenFile.path}
                  workspace={activeWorkspace.projectPath}
                  onClose={() => closeFile(activeOpenFile.id)}
                />
              )}
            </div>
          )}

          {/* Git Dashboard slide-out panel.
              Phase 3.3: for remote workspaces the dashboard reads via SSH
              using the workspace's `serverId` + `remoteProjectPath`. */}
          {gitPanelOpen && activeWorkspace && (
            <div className="w-[280px] shrink-0 border-l border-bg-border bg-bg-primary overflow-hidden flex flex-col">
              <GitDashboard
                projectPath={
                  activeWorkspace.serverId
                    ? (activeWorkspace.remoteProjectPath ?? activeWorkspace.projectPath)
                    : activeWorkspace.projectPath
                }
                serverId={activeWorkspace.serverId}
              />
            </div>
          )}
        </div>

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

function workspaceStatusDot(ws: Workspace): { className: string; pulse: boolean } {
  const live = ws.panes.some((p) => p.sessionId);
  if (live) {
    return { className: "bg-accent-green", pulse: true };
  }
  if (ws.panes.length > 0) {
    return { className: "bg-accent-amber", pulse: false };
  }
  return { className: "bg-text-faint", pulse: false };
}

