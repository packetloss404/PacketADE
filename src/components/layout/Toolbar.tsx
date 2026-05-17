import { useState, useRef, useEffect } from "react";
import { FolderOpen, Wrench, ArrowDown, ArrowUp, GitCommit, Bell, Mic, Search, Plus, ChevronDown, Zap, Target, Ticket, Rocket, LayoutGrid, Bookmark } from "lucide-react";
import { DropdownItem } from "./DropdownItem";
import { SidecarStatusChip } from "./SidecarStatusChip";
import { RunningAgentsChip } from "./RunningAgentsChip";
import { LiveSpendChip } from "./LiveSpendChip";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore, isModuleView, moduleViewId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { useFlightStore } from "@/stores/flightStore";
import { getModulesSorted } from "@/modules/registry";
import { useGitInfo } from "@/hooks/useGitInfo";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { NewFlightModal } from "@/components/flights/NewFlightModal";
import { NewAgentModal } from "@/components/workspace/NewAgentModal";
import { NewIssueForm } from "@/components/issues/NewIssueForm";
import { CommitModal } from "@/components/workspace/CommitModal";
import { Modal } from "@/components/ui/Modal";
import { gitPull, gitPush, getGitBranch } from "@/lib/tauri";

/** Last path segment, OS-agnostic. Used to seed the new workspace name. */
function basenameOfPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const seg = trimmed.split(/[\\/]/).pop() ?? "";
  return seg || trimmed || "workspace";
}

export function Toolbar() {
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const gitBranch = useGitInfo();
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showNewFlight, setShowNewFlight] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);
  // v0.8.8: when no workspace is active, picking a folder pops a small
  // disambiguation dialog (create-new vs. set-default-only). Holds the
  // path the user selected from the OS picker while they decide.
  const [pendingPickedPath, setPendingPickedPath] = useState<string | null>(null);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const moduleStates = useModuleStore((s) => s.states);
  // v0.8.8: the active workspace drives both the picker title and the
  // tooltip copy. When no workspace is active, the picker offers a
  // create-vs-default fork instead of silently writing the fallback.
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);

  const enabledModules = getModulesSorted().filter((mod) => moduleStates[mod.id]?.enabled ?? false);

  // Count of pending approvals — mirrors ReviewQueueView's filter so the
  // badge matches what the user sees when they click through. We only count
  // tasks (not mission-planner approvals) because those surface inline on
  // the mission view, not in the Review Queue.
  const pendingApprovalCount = useFlightStore((s) => {
    let n = 0;
    for (const flight of s.flights) {
      for (const milestone of flight.milestones) {
        for (const task of milestone.tasks) {
          if (task.status === "approval_needed") n++;
        }
      }
    }
    return n;
  });

  // Close tools menu when clicking outside
  useEffect(() => {
    if (!showToolsMenu) return;
    function handleClick(e: MouseEvent) {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setShowToolsMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showToolsMenu]);

  // Close "New" menu when clicking outside
  useEffect(() => {
    if (!showNewMenu) return;
    function handleClick(e: MouseEvent) {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setShowNewMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showNewMenu]);

  async function handleOpenFolder() {
    // v0.8.8: smart picker. With an active workspace, the title makes it
    // clear the choice will rebind THAT workspace's project folder. With
    // no workspace, we don't silently write the fallback — we let the
    // user choose whether to create a workspace or just stash the path.
    const titled = activeWorkspace
      ? `Change folder for "${activeWorkspace.name}"`
      : "Open project folder";
    const selected = await open({
      directory: true,
      multiple: false,
      title: titled,
    });
    if (!selected) return;
    const path = selected as string;
    if (activeWorkspace) {
      // setProjectPath writes through to the active workspace
      // (layoutStore subscription in v88-A), so this is the only call
      // needed. Remote workspaces don't get rebound through this path —
      // the workspaceStore subscription guards on serverId — so a no-op
      // here is the right answer for SSH workspaces too.
      setProjectPath(path);
      return;
    }
    // No active workspace: surface the disambiguation dialog.
    setPendingPickedPath(path);
  }

  function handleCreateWorkspaceFromPicker(path: string) {
    const id = createWorkspace(basenameOfPath(path), ["claude-code"], path);
    setPendingPickedPath(null);
    // Land the user on the workspace view so the new workspace's panes
    // become visible immediately — otherwise the create is invisible.
    if (id) setActiveView("workspace");
  }

  function handleSetDefaultFromPicker(path: string) {
    // Store on the fallback field only. No workspace was active, so the
    // workspaceStore subscription has nothing to write through to.
    setProjectPath(path);
    setPendingPickedPath(null);
  }

  return (
    <div className="flex items-center h-9 px-3 bg-bg-secondary border-b border-bg-border gap-2">
      {/* Left section: search + global "New" dropdown */}
      <div className="flex items-center gap-2">
        {/* Ctrl+K Search chip — opens the command palette */}
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-bg-secondary border border-bg-border text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors"
          title="Search and navigate (Ctrl+K)"
        >
          <Search size={12} />
          <span>Search</span>
          <span className="text-[9px] text-text-muted bg-bg-primary px-1 rounded font-mono">Ctrl+K</span>
        </button>

        {/* Global "+ New" dropdown */}
        <div className="relative" ref={newMenuRef}>
          <button
            onClick={() => setShowNewMenu((v) => !v)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs border border-bg-border transition-colors ${
              showNewMenu
                ? "bg-bg-elevated text-text-primary"
                : "bg-bg-secondary text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
            }`}
            title="Create a new session, mission, or issue"
          >
            <Plus size={12} />
            <span>New</span>
            <ChevronDown size={10} className="text-text-muted" />
          </button>

          {showNewMenu && (
            <div className="absolute top-full left-0 mt-1 w-52 bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1">
              <DropdownItem
                icon={<Zap size={12} className="text-accent-green" />}
                label="New Agent"
                onClick={() => { setShowNewAgent(true); setShowNewMenu(false); }}
              />
              <DropdownItem
                icon={<Target size={12} className="text-accent-green" />}
                label="New Mission"
                onClick={() => { setShowNewFlight(true); setShowNewMenu(false); }}
              />
              <DropdownItem
                icon={<Ticket size={12} className="text-accent-amber" />}
                label="New Issue"
                onClick={() => { setShowNewIssue(true); setShowNewMenu(false); }}
              />
              <DropdownItem
                icon={<Rocket size={12} className="text-accent-purple" />}
                label="New deploy run"
                onClick={() => { setActiveView("deploy"); setShowNewMenu(false); }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex-1" />

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* Sidecar status chip (v2 Tier 2 slice B) */}
        <SidecarStatusChip />

        {/* Running agents tray — only renders when at least one agent is
            mid-stream. Click to inspect / jump / stop. */}
        <RunningAgentsChip />

        {/* B6: live spend HUD — today's persisted total + in-flight session
            spend. Auto-refreshes; click jumps to the Cost Dashboard. */}
        <LiveSpendChip />

        <div className="w-px h-4 bg-bg-border self-center" />

        {/* Optional Tools (modules) dropdown — primary nav lives in LeftRail */}
        {/* Dictation is intentionally filtered out here; it surfaces via the dedicated VT button,
            the CommandPalette, and the StatusStrip indicator instead. */}
        {(() => {
          const toolbarModules = enabledModules.filter((mod) => mod.id !== "dictation");
          if (toolbarModules.length === 0) return null;
          return (
            <div className="relative" ref={toolsMenuRef}>
              <button
                onClick={() => setShowToolsMenu(!showToolsMenu)}
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
                  isModuleView(activeView)
                    ? "bg-bg-elevated text-accent-green"
                    : "bg-bg-elevated text-text-secondary hover:text-accent-green"
                }`}
                title="Tools — open one of the optional tool modules."
              >
                <Wrench size={12} className="text-accent-green" />
                <span>Tools</span>
              </button>

              {showToolsMenu && (
                <div className="absolute top-full right-0 mt-1 w-48 bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1">
                  {toolbarModules.map((mod) => {
                    const Icon = mod.icon;
                    return (
                      <DropdownItem
                        key={mod.id}
                        icon={<Icon size={12} className={mod.iconColor} />}
                        label={mod.name}
                        onClick={() => { setActiveView(moduleViewId(mod.id)); setShowToolsMenu(false); }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Dictation (VT) button */}
        <button
          onClick={() => setActiveView("dictation")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "dictation"
              ? "bg-bg-elevated text-accent-purple"
              : "bg-bg-elevated text-text-secondary hover:text-accent-purple"
          }`}
          title="Dictation — voice-to-text with local Whisper transcription. (Ctrl+Shift+D)"
        >
          <Mic size={12} className="text-accent-purple" />
          <span>VT</span>
        </button>

        <div className="w-px h-4 bg-bg-border self-center" />

        {/* Git actions */}
        {gitBranch && <GitActionButtons />}

        {/* Open project folder */}
        {(() => {
          const folderTooltip = activeWorkspace
            ? `Project: ${projectPath || "(unset)"} (${activeWorkspace.name}) — click to change`
            : projectPath
              ? `Default folder: ${projectPath} — no workspace open. Click to change or create one.`
              : "No workspace open — click to create one";
          return (
            <button
              onClick={handleOpenFolder}
              className="flex items-center px-2 py-0.5 bg-bg-elevated rounded text-xs text-text-secondary hover:text-text-primary transition-colors"
              title={folderTooltip}
              aria-label={folderTooltip}
            >
              <FolderOpen size={12} />
            </button>
          );
        })()}

        <div className="w-px h-4 bg-bg-border self-center" />

        {/* Review Queue — far-right slot. Dull when empty; flips to urgent
            red with a count badge when approvals are pending. The canonical
            Theme toggle lives in Settings > General > Theme. */}
        <button
          onClick={() => setActiveView("review_queue")}
          className={`relative flex items-center p-1 rounded transition-colors ${
            activeView === "review_queue"
              ? "text-accent-amber"
              : pendingApprovalCount > 0
                ? "text-accent-red hover:text-accent-amber"
                : "text-text-muted hover:text-text-primary"
          }`}
          title={
            pendingApprovalCount === 0
              ? "Review queue — no pending approvals"
              : `Review queue — ${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`
          }
          aria-label={
            pendingApprovalCount === 0
              ? "Review queue — no pending approvals"
              : `Review queue — ${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`
          }
        >
          <Bell size={12} />
          {pendingApprovalCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 bg-accent-red text-white text-[9px] font-bold px-1 rounded-full min-w-[14px] h-[14px] flex items-center justify-center leading-none"
              aria-hidden="true"
            >
              {pendingApprovalCount > 99 ? "99+" : String(pendingApprovalCount)}
            </span>
          )}
        </button>
      </div>

      {/* Modals */}
      {showNewAgent && (
        <NewAgentModal onClose={() => setShowNewAgent(false)} />
      )}
      {showNewFlight && (
        <NewFlightModal onClose={() => setShowNewFlight(false)} />
      )}
      {showNewIssue && (
        <NewIssueForm defaultStatus="todo" onClose={() => setShowNewIssue(false)} />
      )}
      {pendingPickedPath && (
        <FolderPickerFollowUp
          pickedPath={pendingPickedPath}
          onCreateWorkspace={() => handleCreateWorkspaceFromPicker(pendingPickedPath)}
          onSetDefault={() => handleSetDefaultFromPicker(pendingPickedPath)}
          onCancel={() => setPendingPickedPath(null)}
        />
      )}

    </div>
  );
}

/**
 * Small follow-up shown after the user picks a folder while no workspace
 * is active. Splits the two reasonable intents: "I want a workspace here
 * now" vs. "I'm just stashing this path as the default for next time".
 */
function FolderPickerFollowUp({
  pickedPath,
  onCreateWorkspace,
  onSetDefault,
  onCancel,
}: {
  pickedPath: string;
  onCreateWorkspace: () => void;
  onSetDefault: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      onClose={onCancel}
      title="Use this folder"
      icon={<FolderOpen size={16} className="text-accent-green" />}
      width="w-[460px]"
      closeOnEscape
    >
      <div className="px-5 py-4 flex flex-col gap-4">
        <div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Selected folder</div>
          <div className="bg-bg-primary border border-bg-border rounded px-3 py-2 text-xs text-text-primary font-mono truncate" title={pickedPath}>
            {pickedPath}
          </div>
        </div>
        <p className="text-[11px] text-text-secondary">
          No workspace is open. Pick what to do with this folder:
        </p>
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={onCreateWorkspace}
            className="flex items-start gap-3 px-3 py-3 bg-bg-primary border border-bg-border rounded text-left hover:border-accent-green/40 hover:bg-accent-green/5 transition-colors"
          >
            <LayoutGrid size={14} className="text-accent-green flex-shrink-0 mt-0.5" />
            <span className="flex flex-col">
              <span className="text-[12px] font-medium text-text-primary">Create new workspace</span>
              <span className="text-[10px] text-text-muted mt-0.5">
                Open a workspace here with a Claude Code pane. You can adjust agents later.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={onSetDefault}
            className="flex items-start gap-3 px-3 py-3 bg-bg-primary border border-bg-border rounded text-left hover:border-accent-amber/40 hover:bg-accent-amber/5 transition-colors"
          >
            <Bookmark size={14} className="text-accent-amber flex-shrink-0 mt-0.5" />
            <span className="flex flex-col">
              <span className="text-[12px] font-medium text-text-primary">Set as default for next workspace</span>
              <span className="text-[10px] text-text-muted mt-0.5">
                Remember this path so the next workspace you create starts here. No workspace is opened now.
              </span>
            </span>
          </button>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function GitActionButtons() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setGitBranch = useAppStore((s) => s.setGitBranch);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCommitModal, setShowCommitModal] = useState(false);

  async function handleGitAction(action: "pull" | "push") {
    if (busy) return;
    setBusy(action);
    try {
      if (action === "pull") {
        await gitPull(projectPath);
      } else if (action === "push") {
        await gitPush(projectPath);
      }
    } catch (err) {
      console.error(`Git ${action} failed:`, err);
    } finally {
      setBusy(null);
    }
  }

  async function refreshGitBranch() {
    try {
      const branch = await getGitBranch(projectPath);
      setGitBranch(branch);
    } catch {
      // poll-based fallback handles the next refresh
    }
  }

  return (
    <>
      <div className="flex items-center bg-bg-elevated rounded">
        <button
          onClick={() => handleGitAction("pull")}
          disabled={busy !== null}
          className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
          title="Git Pull — fetch and merge the latest commits from the upstream branch."
        >
          <ArrowDown size={12} />
        </button>
        <button
          onClick={() => handleGitAction("push")}
          disabled={busy !== null}
          className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
          title="Git Push — publish local commits on the current branch to the remote."
        >
          <ArrowUp size={12} />
        </button>
        <button
          onClick={() => setShowCommitModal(true)}
          disabled={busy !== null}
          className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
          title="Git Commit — commit any staged changes with a message you provide. Does not stage files."
        >
          <GitCommit size={12} />
        </button>
      </div>
      <CommitModal
        open={showCommitModal}
        onClose={() => setShowCommitModal(false)}
        projectPath={projectPath}
        onCommitted={refreshGitBranch}
      />
    </>
  );
}
