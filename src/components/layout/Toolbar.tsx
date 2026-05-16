import { useState, useRef, useEffect } from "react";
import { FolderOpen, Diamond, Wrench, Rocket, ArrowDown, ArrowUp, GitCommit, Sun, Moon, ShieldCheck, BookOpen, Mic, Search, Plus, ChevronDown, Zap, Target, Ticket } from "lucide-react";
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
import { CodeQualityModal } from "@/components/quality/CodeQualityModal";
import { PromptLibrary } from "@/components/workspace/PromptLibrary";
import { NewFlightModal } from "@/components/flights/NewFlightModal";
import { NewIssueForm } from "@/components/issues/NewIssueForm";
import { CommitModal } from "@/components/workspace/CommitModal";
import { gitPull, gitPush, getGitBranch } from "@/lib/tauri";

export function Toolbar() {
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const gitBranch = useGitInfo();
  const [showCodeQuality, setShowCodeQuality] = useState(false);
  const [showPromptLibrary, setShowPromptLibrary] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showNewFlight, setShowNewFlight] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const quickStartSession = useAppStore((s) => s.quickStartSession);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const moduleStates = useModuleStore((s) => s.states);
  // Code Quality analysis only works on local paths. Disable the button
  // for remote workspaces (mirrors IdeationView's guard).
  const activeWorkspaceIsRemote = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return Boolean(ws?.serverId);
  });

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
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Project Folder",
    });
    if (selected) {
      setProjectPath(selected as string);
    }
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
                label="New Claude session"
                onClick={() => { quickStartSession("claude"); setShowNewMenu(false); }}
              />
              <DropdownItem
                icon={<Zap size={12} className="text-accent-blue" />}
                label="New Codex session"
                onClick={() => { quickStartSession("codex"); setShowNewMenu(false); }}
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

        {/* Review Queue */}
        <button
          onClick={() => setActiveView("review_queue")}
          className={`relative flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "review_queue"
              ? "bg-bg-elevated text-accent-amber"
              : pendingApprovalCount > 0
                ? "text-accent-red hover:text-accent-amber"
                : "text-text-muted hover:text-accent-amber"
          }`}
          title={
            pendingApprovalCount > 0
              ? `Pending tool / file-write approvals (${pendingApprovalCount})`
              : "Pending tool / file-write approvals"
          }
        >
          <div className="relative">
            <ShieldCheck size={12} />
            {pendingApprovalCount > 0 && (
              <span
                className="absolute -top-1 -right-1 bg-accent-red text-white text-[9px] font-medium px-1 rounded-full min-w-[14px] h-[14px] flex items-center justify-center"
                aria-label={`${pendingApprovalCount} pending approvals`}
              >
                {pendingApprovalCount > 99 ? "99+" : String(pendingApprovalCount)}
              </span>
            )}
          </div>
          <span>Review</span>
        </button>

        {/* Deploy button */}
        <button
          onClick={() => setActiveView("deploy")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "deploy"
              ? "bg-bg-elevated text-accent-amber"
              : "bg-bg-elevated text-text-secondary hover:text-accent-amber"
          }`}
          title="Deploy Pipeline — run configured deploy commands for the current project and watch their output."
        >
          <Rocket size={12} className="text-accent-amber" />
          <span>Deploy</span>
        </button>

        {/* Prompt Library button */}
        <button
          onClick={() => setShowPromptLibrary(true)}
          className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-elevated rounded text-xs text-text-secondary hover:text-accent-green transition-colors"
          title="Prompt Library — browse, create, and send prompt templates to Terminal or Scout (agent chat)."
        >
          <BookOpen size={12} className="text-accent-green" />
          <span>Prompts</span>
        </button>

        {/* Code Quality button */}
        <button
          onClick={() => setShowCodeQuality(true)}
          disabled={activeWorkspaceIsRemote}
          className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-elevated rounded text-xs text-text-secondary hover:text-accent-amber transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-text-secondary"
          title={activeWorkspaceIsRemote
            ? "Code Quality analysis is not yet supported on remote workspaces. Open the workspace locally to run it."
            : "Code Quality — run lint, type-check, and test suites for the current project from one panel."}
        >
          <Diamond size={12} className="text-accent-amber" />
          <span>Quality</span>
        </button>

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
                title="Modules — open one of the optional tool modules."
              >
                <Wrench size={12} className="text-accent-green" />
                <span>Modules</span>
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
        <button
          onClick={handleOpenFolder}
          className="flex items-center px-2 py-0.5 bg-bg-elevated rounded text-xs text-text-secondary hover:text-text-primary transition-colors"
          title={projectPath ? `Project: ${projectPath} — click to open a different folder` : "No project open — click to open one"}
        >
          <FolderOpen size={12} />
        </button>

        <div className="w-px h-4 bg-bg-border self-center" />

        {/* Theme toggle — own slot at the far right; not an action verb so
            kept separate from the Action cluster. Also mirrored in Settings. */}
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="p-1 text-text-muted hover:text-text-primary transition-colors"
          title={`Theme — currently ${theme}. Click to switch to ${theme === "dark" ? "light" : "dark"} mode.`}
        >
          {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
        </button>
      </div>

      {/* Modals */}
      {showCodeQuality && (
        <CodeQualityModal onClose={() => setShowCodeQuality(false)} />
      )}
      {showPromptLibrary && (
        <PromptLibrary onClose={() => setShowPromptLibrary(false)} />
      )}
      {showNewFlight && (
        <NewFlightModal onClose={() => setShowNewFlight(false)} />
      )}
      {showNewIssue && (
        <NewIssueForm defaultStatus="todo" onClose={() => setShowNewIssue(false)} />
      )}

    </div>
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
