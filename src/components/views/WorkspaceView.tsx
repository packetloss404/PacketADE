import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useEditorStore } from "@/stores/editorStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { EditorPane } from "@/components/editor/EditorPane";
import { isOnboardingComplete } from "@/lib/onboarding";
import { useState, useRef, useEffect } from "react";
import { LayoutGrid, FolderOpen, ChevronDown, Layers, GitBranch, FileText, Plus } from "lucide-react";
import { GitDashboard } from "@/components/workspace/GitDashboard";
import type { WorkspaceAgentSlot } from "@/types/workspace";

const agentLabel: Record<WorkspaceAgentSlot, string> = {
  "terminal": "Terminal",
  "claude-code": "Claude",
  "codex": "Codex",
  "gemini": "Gemini",
  "opencode": "OpenCode",
};

const agentColor: Record<WorkspaceAgentSlot, string> = {
  "terminal": "bg-text-muted/20 text-text-secondary",
  "claude-code": "bg-accent-green/20 text-accent-green",
  "codex": "bg-blue-500/20 text-blue-400",
  "gemini": "bg-purple-500/20 text-purple-400",
  "opencode": "bg-orange-500/20 text-orange-400",
};

function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function WorkspaceView() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const addAgentRef = useRef<HTMLDivElement>(null);
  const addPane = useWorkspaceStore((s) => s.addPane);

  const openFiles = useEditorStore((s) => s.openFiles);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const closeFile = useEditorStore((s) => s.closeFile);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);

  const activeOpenFile = openFiles.find((f) => f.id === activeFileId) ?? null;
  const editorVisible = openFiles.length > 0;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");

  const showOnboarding =
    initialized && !onboardingDone && activeNonArchived.length === 0 && !projectPath;

  // Close switcher on outside click
  useEffect(() => {
    if (!switcherOpen) return;
    const handler = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [switcherOpen]);

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
        {/* Workspace context header */}
        {initialized && activeWorkspace && (
          <div className="py-2 px-3 bg-bg-secondary border-b border-bg-border flex items-center justify-between shrink-0">
            {/* Left: workspace name + project folder */}
            <div className="flex items-center gap-2 min-w-0">
              <Layers size={12} className="text-text-muted shrink-0" />
              <div className="relative" ref={switcherRef}>
                <button
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-1 text-xs font-medium text-text-primary hover:text-accent-green transition-colors"
                >
                  {activeWorkspace.name}
                  {activeNonArchived.length > 1 && (
                    <ChevronDown size={10} className="text-text-muted" />
                  )}
                </button>
                {switcherOpen && activeNonArchived.length > 1 && (
                  <div className="absolute top-full left-0 mt-1 bg-bg-tertiary border border-bg-border rounded shadow-lg z-50 min-w-[160px] py-1">
                    {activeNonArchived.map((ws) => (
                      <button
                        key={ws.id}
                        onClick={() => { setActiveWorkspace(ws.id); setSwitcherOpen(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors ${
                          ws.id === activeWorkspaceId ? "text-accent-green" : "text-text-secondary"
                        }`}
                      >
                        {ws.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="text-[10px] text-text-muted flex items-center gap-1 truncate">
                <FolderOpen size={10} className="shrink-0" />
                {folderName(activeWorkspace.projectPath)}
              </span>
              <span className="text-[10px] text-text-muted">
                {activeWorkspace.panes.length} {activeWorkspace.panes.length === 1 ? "pane" : "panes"}
              </span>
            </div>

            {/* Right: agent badges + git toggle */}
            <div className="flex items-center gap-1.5">
              {Object.entries(agentCounts).map(([agent, count]) => (
                <span
                  key={agent}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${agentColor[agent as WorkspaceAgentSlot] || "bg-text-muted/20 text-text-secondary"}`}
                >
                  {agentLabel[agent as WorkspaceAgentSlot] || agent}
                  {(count as number) > 1 && ` x${count}`}
                </span>
              ))}
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
                {addAgentOpen && activeWorkspace && (
                  <div className="absolute right-0 top-full mt-1 bg-bg-tertiary border border-bg-border rounded shadow-lg z-50 min-w-[150px] py-1">
                    {(["claude-code", "codex", "gemini", "opencode", "terminal"] as WorkspaceAgentSlot[]).map((agent) => (
                      <button
                        key={agent}
                        onClick={() => {
                          addPane(activeWorkspace.id, agent);
                          setAddAgentOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors flex items-center gap-2"
                      >
                        <span className={`w-2 h-2 rounded-full ${agentColor[agent]?.split(" ")[0] ?? "bg-text-muted/20"}`} />
                        {agentLabel[agent]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
            </div>
          </div>
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

          {/* Editor panel */}
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
              <EditorPane
                key={activeOpenFile.id}
                filePath={activeOpenFile.path}
                workspace={activeWorkspace.projectPath}
                onClose={() => closeFile(activeOpenFile.id)}
              />
            </div>
          )}

          {/* Git Dashboard slide-out panel */}
          {gitPanelOpen && activeWorkspace && (
            <div className="w-[280px] shrink-0 border-l border-bg-border bg-bg-primary overflow-hidden flex flex-col">
              <GitDashboard projectPath={activeWorkspace.projectPath} />
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
