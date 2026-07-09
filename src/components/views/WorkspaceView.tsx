import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useEditorStore } from "@/stores/editorStore";
import { useDraftTileStore } from "@/stores/draftTileStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { AddAgentPicker } from "@/components/workspace/AddAgentPicker";
import { AgentsOnboarding } from "@/components/agents/AgentsOnboarding";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { EditorPane } from "@/components/editor/EditorPane";
import { isOnboardingComplete } from "@/lib/onboarding";
import { useState } from "react";
import { LayoutGrid, GitBranch, FileText, Plus, Zap } from "lucide-react";
import { GitDashboard } from "@/components/workspace/GitDashboard";
import { getAgentColor } from "@/lib/agentColors";
import { useWorkspaceStatuses, attentionDot } from "@/lib/sessionStatus";
import type { WorkspaceAgentSlot } from "@/types/workspace";

const agentLabel: Record<WorkspaceAgentSlot, string> = {
  terminal: "Terminal",
  "claude-code": "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  packetcode: "PacketCode",
};

export function WorkspaceView() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setBypassPermissions = useWorkspaceStore((s) => s.setBypassPermissions);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());
  // Git panel open-state lives in appStore so the in-tile ReviewBar "Finish →
  // Commit…" CTA can open the endings surface (openGitPanelForConversation).
  const gitPanelOpen = useAppStore((s) => s.gitPanelOpen);
  const setGitPanelOpen = useAppStore((s) => s.setGitPanelOpen);
  const gitPanelConversationId = useAppStore((s) => s.gitPanelConversationId);
  const [showCreate, setShowCreate] = useState(false);
  const drafts = useDraftTileStore((s) => s.drafts);
  // Tile program (P4-S1): the tab-strip dot reads the SINGLE status truth
  // (sessionStatus rollup — max severity across member tiles), not a local
  // liveness heuristic.
  const workspaceStatuses = useWorkspaceStatuses();

  const openFiles = useEditorStore((s) => s.openFiles);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const closeFile = useEditorStore((s) => s.closeFile);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);

  const activeOpenFile = openFiles.find((f) => f.id === activeFileId) ?? null;
  const editorVisible = openFiles.length > 0;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");

  // Scope the GitDashboard's WorktreeLifecycleBar to the conversation the
  // "Finish → Commit…" CTA opened it for — but only while that conversation
  // actually has a tile in the workspace on screen (else fall back to the plain
  // git view). Guards against a stale scope after a workspace switch.
  const scopedGitConversationId =
    gitPanelConversationId &&
    activeWorkspace?.panes.some(
      (p) => p.kind === "conversation" && p.conversationId === gitPanelConversationId,
    )
      ? gitPanelConversationId
      : undefined;

  const showOnboarding =
    initialized && !onboardingDone && activeNonArchived.length === 0 && !projectPath;

  const bypassOn = activeWorkspace?.bypassPermissions ?? false;

  // Count agents per type for the active workspace. Tile program (P1-S1): the
  // header badges are keyed on `kind` — conversation panes carry the inert
  // carrier agentId "terminal" and must NOT be counted as terminals here.
  const agentCounts: Partial<Record<WorkspaceAgentSlot, number>> = {};
  if (activeWorkspace) {
    for (const pane of activeWorkspace.panes) {
      if (pane.kind === "conversation") continue;
      agentCounts[pane.agentId] = (agentCounts[pane.agentId] || 0) + 1;
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Merged header: workspace tabs · agent badges · + Add Agent · git
            toggle · pane-layout presets · bypass perms.
            Replaces the previous two-row layout (workspace context header
            stacked above WorkspaceSubTabs). The active tab's tooltip now
            carries the project-path info the old folder chip used to show. */}
        {initialized && activeNonArchived.length > 0 && (
          <div className="flex h-[33px] shrink-0 items-stretch border-b border-line-soft bg-bg-primary px-2">
            <div className="flex items-stretch gap-0 overflow-x-auto">
              {activeNonArchived.map((ws) => {
                const isActive = ws.id === activeWorkspaceId;
                const dot = attentionDot(workspaceStatuses.get(ws.id) ?? "idle");
                return (
                  <button
                    key={ws.id}
                    onClick={() => setActiveWorkspace(ws.id)}
                    title={ws.projectPath}
                    className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 text-[11px] transition-colors ${
                      isActive ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${dot.className} ${dot.pulse ? "animate-pulse" : ""}`}
                    />
                    <span>{ws.name}</span>
                    {isActive && (
                      <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-t bg-accent-green" />
                    )}
                  </button>
                );
              })}
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center px-2 text-text-muted transition-colors hover:text-text-primary"
                title="New workspace"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {activeWorkspace &&
                Object.entries(agentCounts).map(([agent, count]) => {
                  const c = getAgentColor(agent);
                  return (
                    <span
                      key={agent}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${c.bg} ${c.text}`}
                    >
                      {agentLabel[agent as WorkspaceAgentSlot] || agent}
                      {(count as number) > 1 && ` x${count}`}
                    </span>
                  );
                })}
              {activeWorkspace && (
                <AddAgentPicker
                  workspace={activeWorkspace}
                  variant="popover"
                  onOpenTemplates={() => setShowCreate(true)}
                />
              )}
              {activeWorkspace && (
                <button
                  onClick={() => setGitPanelOpen(!gitPanelOpen)}
                  className={`rounded p-1 transition-colors ${
                    gitPanelOpen
                      ? "bg-accent-green/20 text-accent-green"
                      : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                  }`}
                  title="Git Dashboard"
                >
                  <GitBranch size={12} />
                </button>
              )}
              <button
                onClick={() =>
                  activeWorkspace && setBypassPermissions(activeWorkspace.id, !bypassOn)
                }
                disabled={!activeWorkspace}
                className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] transition-colors ${
                  bypassOn
                    ? "border-accent-line bg-accent-soft text-accent-amber"
                    : "border-bg-border bg-bg-secondary text-text-muted hover:text-text-secondary"
                } disabled:opacity-50`}
                title="Bypass permission prompts for this workspace"
              >
                <Zap size={10} />
                <span>Bypass perms: {bypassOn ? "on" : "off"}</span>
              </button>
            </div>
          </div>
        )}
        {showCreate && <WorkspaceCreationModal onClose={() => setShowCreate(false)} />}

        {/* Main content area: workspace panes + optional git panel */}
        <div className="flex flex-1 overflow-hidden">
          {/* Workspace panes */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* All active workspaces stay mounted so PTY sessions persist */}
            {initialized &&
              activeNonArchived.map((ws) => {
                // Workspace zero-state: an empty workspace (no panes, no draft
                // tiles) hosts the inline AddAgentPicker centered — first agent
                // and Nth agent are one flow. A draft tile counts as non-empty
                // so the mosaic (which renders it) mounts instead.
                const draftCount = drafts.filter((d) => d.workspaceId === ws.id).length;
                const empty = ws.panes.length === 0 && draftCount === 0;
                return (
                  <div
                    key={ws.id}
                    className="flex flex-1 flex-col overflow-hidden"
                    style={{ display: ws.id === activeWorkspaceId ? "flex" : "none" }}
                  >
                    {empty ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
                        <div className="text-center text-xs text-text-muted">
                          Add your first agent to this workspace
                        </div>
                        <AddAgentPicker
                          workspace={ws}
                          variant="inline"
                          onOpenTemplates={() => setShowCreate(true)}
                        />
                      </div>
                    ) : (
                      <WorkspaceMosaicContainer workspace={ws} />
                    )}
                  </div>
                );
              })}
          </div>

          {/* Editor panel.
              Phase 3.1: EditorPane uses local-FS Tauri commands
              (`read_file_contents` / `write_file_contents`) and isn't
              wired for remote workspaces yet, so we render a
              placeholder instead. Phase 3.2/3.3 will add a remote-aware
              editor path. */}
          {editorVisible && activeWorkspace && activeOpenFile && (
            <div className="flex w-[480px] shrink-0 flex-col overflow-hidden border-l border-bg-border bg-bg-primary">
              {/* File tabs */}
              {openFiles.length > 1 && (
                <div className="flex shrink-0 items-center overflow-x-auto border-b border-bg-border bg-bg-secondary">
                  {openFiles.map((f) => {
                    const name = f.path.replace(/\\/g, "/").split("/").pop() || f.path;
                    const isActive = f.id === activeFileId;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setActiveFile(f.id)}
                        className={`flex items-center gap-1 whitespace-nowrap border-r border-bg-border px-2 py-1 text-[11px] transition-colors ${
                          isActive
                            ? "bg-bg-primary text-text-primary"
                            : "text-text-muted hover:bg-bg-tertiary hover:text-text-secondary"
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
                <div className="flex flex-1 select-none flex-col items-center justify-center px-6 text-center">
                  <FileText size={20} className="mb-2 text-text-muted opacity-40" />
                  <p className="mb-1 text-xs text-text-secondary">
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
            <div className="flex w-[280px] shrink-0 flex-col overflow-hidden border-l border-bg-border bg-bg-primary">
              <GitDashboard
                projectPath={
                  activeWorkspace.serverId
                    ? (activeWorkspace.remoteProjectPath ?? activeWorkspace.projectPath)
                    : activeWorkspace.projectPath
                }
                workspaceId={activeWorkspace.id}
                serverId={activeWorkspace.serverId}
                conversationId={scopedGitConversationId}
              />
            </div>
          )}
        </div>

        {/* No workspace selected */}
        {initialized &&
          !activeWorkspace &&
          (showOnboarding ? (
            <OnboardingPane onComplete={() => setOnboardingDone(true)} />
          ) : (
            <div className="flex flex-1 select-none flex-col items-center justify-center text-text-muted">
              <LayoutGrid size={28} className="mb-3 opacity-30" />
              <p className="text-xs">Select a workspace from the sidebar or create a new one</p>
            </div>
          ))}

        {/* Tile program (P5-S1): AgentsOnboarding re-homed from the retired
            AgentsView to the workspace empty-fleet state. Self-gates on
            onboardingDismissed (renders null once dismissed); shown here so the
            first-run welcome survives the Agents tab's retirement. */}
        {initialized && !activeWorkspace && <AgentsOnboarding />}
      </div>
    </div>
  );
}
