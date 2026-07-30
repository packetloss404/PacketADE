import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { WorkspaceMosaicContainer } from "@/components/workspace/WorkspaceMosaicContainer";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { AddSessionPicker } from "@/components/workspace/AddSessionPicker";
import { OnboardingPane } from "@/components/onboarding/OnboardingPane";
import { EditorDockPanel } from "@/components/editor/EditorDockPanel";
import { RightDock, type RightDockPanel } from "@/components/layout/RightDock";
import { isPanelVisible, useRightDockStore } from "@/stores/rightDockStore";
import { REMOTE_UNSUPPORTED_TOOLTIP } from "@/lib/remoteConversation";
import { isOnboardingComplete } from "@/lib/onboarding";
import { useEffect, useState } from "react";
import { Bot, LayoutGrid, GitBranch, FileText, Plus, Zap } from "lucide-react";
import { GitDashboard } from "@/components/workspace/GitDashboard";
import { getAgentColor } from "@/lib/agentColors";
import { useWorkspaceStatuses, attentionDot } from "@/lib/sessionStatus";
import type { WorkspaceAgentSlot } from "@/types/workspace";
import { delegateWorkspaceToAgents } from "@/lib/agentHandoffs";
import { useWorkspaceAgentsDogfoodStore } from "@/stores/workspaceAgentsDogfoodStore";

const agentLabel: Record<WorkspaceAgentSlot, string> = {
  terminal: "Terminal",
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  packetcode: "PacketCode",
};

interface WorkspaceViewProps {
  /**
   * True only while the Workspace surface is visible. The view stays mounted
   * after its first visit to preserve live PTYs, but hidden Workspaces must not
   * cold-start or restart terminal processes in the background.
   */
  surfaceActive?: boolean;
}

export function WorkspaceView({ surfaceActive = true }: WorkspaceViewProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setBypassPermissions = useWorkspaceStore((s) => s.setBypassPermissions);
  const initialized = useAppStore((s) => s.initialized);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(() => isOnboardingComplete());
  // D2: the Git panel's VISIBILITY belongs to the RightDock. appStore keeps
  // only the deep-link scope written by the in-tile ReviewBar "Finish →
  // Commit…" CTA (openGitPanelForConversation).
  const gitPanelConversationId = useAppStore((s) => s.gitPanelConversationId);
  const gitPanelWorkspaceId = useAppStore((s) => s.gitPanelWorkspaceId);
  const gitPanelVisible = useRightDockStore((s) =>
    isPanelVisible(s.surfaces, "workspace", "git"),
  );
  const toggleDockPanel = useRightDockStore((s) => s.togglePanel);
  const [showCreate, setShowCreate] = useState(false);
  // Tile program (P4-S1): the tab-strip dot reads the SINGLE status truth
  // (sessionStatus rollup — max severity across member tiles), not a local
  // liveness heuristic.
  const workspaceStatuses = useWorkspaceStatuses();

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeNonArchived = workspaces.filter((w) => w.status === "active");
  const recordVisibleConversations = useWorkspaceAgentsDogfoodStore(
    (state) => state.recordVisibleConversations,
  );
  const visibleConversationCount =
    activeWorkspace?.panes.filter((pane) => pane.kind === "conversation").length ?? 0;

  useEffect(() => {
    recordVisibleConversations(visibleConversationCount);
  }, [recordVisibleConversations, visibleConversationCount]);

  // Scope the GitDashboard's WorktreeLifecycleBar to the project Workspace
  // opened by the Agent handoff. No conversation pane is created; the explicit
  // Workspace id prevents stale scope after a tab switch.
  const scopedGitConversationId =
    gitPanelConversationId && gitPanelWorkspaceId === activeWorkspace?.id
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

  // D2 — the Workspace surface registers its right-side panels with the ONE
  // dock instead of rendering competing fixed-width columns (P0-2). D3 stays
  // honoured: the local-FS editor is disabled (not hidden) on SSH workspaces.
  const workspaceRemote = Boolean(activeWorkspace?.serverId);
  const gitProjectPath = activeWorkspace
    ? workspaceRemote
      ? (activeWorkspace.remoteProjectPath ?? activeWorkspace.projectPath)
      : activeWorkspace.projectPath
    : "";
  const dockPanels: RightDockPanel[] = !activeWorkspace
    ? []
    : [
        {
          id: "editor",
          label: "Editor",
          icon: FileText,
          disabled: workspaceRemote,
          disabledReason: REMOTE_UNSUPPORTED_TOOLTIP,
          render: () => <EditorDockPanel />,
        },
        {
          id: "git",
          label: "Git",
          icon: GitBranch,
          render: () => (
            <GitDashboard
              projectPath={gitProjectPath}
              workspaceId={activeWorkspace.id}
              serverId={activeWorkspace.serverId}
              conversationId={scopedGitConversationId}
            />
          ),
        },
      ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Merged header: workspace tabs · CLI badges · + Add Session · git
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
                <AddSessionPicker
                  workspace={activeWorkspace}
                  variant="popover"
                  onOpenTemplates={() => setShowCreate(true)}
                />
              )}
              {activeWorkspace && (
                <button
                  type="button"
                  onClick={() => delegateWorkspaceToAgents(activeWorkspace.id)}
                  className="flex items-center gap-1 rounded border border-bg-border bg-bg-secondary px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  title="Delegate work on this project to a GUI agent"
                >
                  <Bot size={10} />
                  Delegate
                </button>
              )}
              {activeWorkspace && (
                <button
                  onClick={() => toggleDockPanel("workspace", "git")}
                  className={`rounded p-1 transition-colors ${
                    gitPanelVisible
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

        {/* Main content area: workspace panes + the ONE right dock (D2).
            `relative` anchors the dock's overlay mode at narrow widths. */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* Workspace panes */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* All active workspaces stay mounted so PTY sessions persist */}
            {initialized &&
              activeNonArchived.map((ws) => {
                const empty = ws.panes.length === 0;
                return (
                  <div
                    key={ws.id}
                    className="flex flex-1 flex-col overflow-hidden"
                    style={{ display: ws.id === activeWorkspaceId ? "flex" : "none" }}
                  >
                    {empty ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
                        <div className="text-center text-xs text-text-muted">
                          Add your first CLI session to this workspace
                        </div>
                        <AddSessionPicker
                          workspace={ws}
                          variant="inline"
                          onOpenTemplates={() => setShowCreate(true)}
                        />
                      </div>
                    ) : (
                      <WorkspaceMosaicContainer
                        workspace={ws}
                        autoStartTerminals={surfaceActive && ws.id === activeWorkspaceId}
                      />
                    )}
                  </div>
                );
              })}
          </div>

          {/* D2 — one dock, one visible panel, one resizer, one width budget.
              The Editor and the Git Dashboard used to render as independent
              480px + 280px columns that could stack (P0-2). */}
          <RightDock
            surface="workspace"
            panels={dockPanels}
            ariaLabel="Workspace panels"
          />
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
      </div>
    </div>
  );
}
