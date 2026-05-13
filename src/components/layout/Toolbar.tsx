import { useState, useRef, useEffect } from "react";
import { GitBranch, FolderOpen, Diamond, Wrench, Rocket, ArrowDown, ArrowUp, GitCommit, Sun, Moon, ShieldCheck, LayoutGrid, DollarSign, BookOpen, Mic } from "lucide-react";
import { DropdownItem } from "./DropdownItem";
import { SidecarStatusChip } from "./SidecarStatusChip";
import { RunningAgentsChip } from "./RunningAgentsChip";
import { LiveSpendChip } from "./LiveSpendChip";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore, isModuleView, moduleViewId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { getModulesSorted } from "@/modules/registry";
import { useGitInfo } from "@/hooks/useGitInfo";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useMosaicStore } from "@/stores/mosaicStore";
import { CodeQualityModal } from "@/components/quality/CodeQualityModal";
import { PromptLibrary } from "@/components/workspace/PromptLibrary";
import { gitCommit, gitPull, gitPush } from "@/lib/tauri";
import type { MosaicLayoutPreset } from "@/types/mosaic";

const LAYOUT_PRESETS: { preset: MosaicLayoutPreset; label: string; minPanes: number }[] = [
  { preset: "1x1", label: "1×1", minPanes: 1 },
  { preset: "1x2", label: "1×2", minPanes: 2 },
  { preset: "2x1", label: "2×1", minPanes: 2 },
  { preset: "2x2", label: "2×2", minPanes: 4 },
  { preset: "2x3", label: "2×3", minPanes: 5 },
  { preset: "3x2", label: "3×2", minPanes: 6 },
];

export function Toolbar() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const gitBranch = useGitInfo();
  const [showCodeQuality, setShowCodeQuality] = useState(false);
  const [showPromptLibrary, setShowPromptLibrary] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const toolsMenuRef = useRef<HTMLDivElement>(null);

  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const moduleStates = useModuleStore((s) => s.states);
  // Code Quality analysis only works on local paths. Disable the button
  // for remote workspaces (mirrors IdeationView's guard).
  const activeWorkspaceIsRemote = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return Boolean(ws?.serverId);
  });

  const projectName = projectPath.split(/[/\\]/).pop() || "PacketADE";
  const enabledModules = getModulesSorted().filter((mod) => moduleStates[mod.id]?.enabled ?? false);

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
      <div className="flex-1" />

      {/* Pane layout presets (visible when a workspace is active) */}
      <PaneLayoutControls />

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

        {/* Review Queue */}
        <button
          onClick={() => setActiveView("review_queue")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "review_queue"
              ? "bg-bg-elevated text-accent-amber"
              : "text-text-muted hover:text-accent-amber"
          }`}
          title="Review Queue — pending tool / file-write approvals from running flights. Click to triage."
        >
          <ShieldCheck size={11} />
          <span>Review</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="p-1 text-text-muted hover:text-text-primary transition-colors"
          title={`Theme — currently ${theme}. Click to switch to ${theme === "dark" ? "light" : "dark"} mode.`}
        >
          {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
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

        {/* Cost Dashboard button */}
        <button
          onClick={() => setActiveView("cost_dashboard")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "cost_dashboard"
              ? "bg-bg-elevated text-accent-green"
              : "bg-bg-elevated text-text-secondary hover:text-accent-green"
          }`}
          title="Cost Dashboard — view API usage costs and spending trends."
        >
          <DollarSign size={12} className="text-accent-green" />
          <span>Costs</span>
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

        {/* Optional Tools (modules) dropdown — primary nav lives in LeftRail */}
        {enabledModules.length > 0 && (
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
                {enabledModules.map((mod) => {
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
        )}

        {/* Dictation (VT) button */}
        <button
          onClick={() => setActiveView("dictation")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "dictation"
              ? "bg-bg-elevated text-accent-purple"
              : "bg-bg-elevated text-text-secondary hover:text-accent-purple"
          }`}
          title="Dictation — voice-to-text with local Whisper transcription."
        >
          <Mic size={12} className="text-accent-purple" />
          <span>VT</span>
        </button>

        {/* Git branch + actions */}
        {gitBranch && (
          <div className="flex items-center gap-0.5">
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-elevated rounded-l text-xs"
              title={`Current git branch: ${gitBranch}`}
            >
              <GitBranch size={12} className="text-accent-purple" />
              <span className="text-text-secondary">{gitBranch}</span>
            </div>
            <GitActionButtons />
          </div>
        )}

        {/* Project name */}
        <button
          onClick={handleOpenFolder}
          className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-elevated rounded text-xs text-text-secondary hover:text-text-primary transition-colors"
          title={`Current project folder: ${projectPath || "none"}. Click to open a different folder.`}
        >
          <FolderOpen size={12} />
          <span>{projectName}</span>
        </button>
      </div>

      {/* Modals */}
      {showCodeQuality && (
        <CodeQualityModal onClose={() => setShowCodeQuality(false)} />
      )}
      {showPromptLibrary && (
        <PromptLibrary onClose={() => setShowPromptLibrary(false)} />
      )}

    </div>
  );
}

function PaneLayoutControls() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const applyPreset = useMosaicStore((s) => s.applyPreset);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!activeWorkspace) return null;

  const paneIds = activeWorkspace.panes.map((p) => p.id);
  const paneCount = paneIds.length;

  return (
    <div
      className="flex items-center gap-1"
      title="Pane layout — current workspace tile count and quick layout presets. Click a preset to rearrange."
    >
      <div className="w-px h-4 bg-bg-border" />
      <LayoutGrid size={11} className="text-accent-green flex-shrink-0" />
      <span className="text-[10px] text-text-secondary">
        {paneCount} pane{paneCount !== 1 ? "s" : ""}
      </span>
      {LAYOUT_PRESETS.filter((p) => p.minPanes <= paneCount).map(({ preset, label }) => (
        <button
          key={preset}
          onClick={() => applyPreset(preset, paneIds)}
          className="px-1.5 py-0.5 text-[9px] text-text-muted hover:text-text-primary bg-bg-primary border border-bg-border rounded transition-colors hover:border-accent-green/30"
          title={`Arrange the ${paneCount} workspace panes into a ${label} grid.`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function GitActionButtons() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [busy, setBusy] = useState<string | null>(null);

  async function handleGitAction(action: "pull" | "push" | "commit") {
    if (busy) return;
    setBusy(action);
    try {
      if (action === "pull") {
        await gitPull(projectPath);
      } else if (action === "push") {
        await gitPush(projectPath);
      } else if (action === "commit") {
        // Commit staged changes only (stage-all is rejected by safety layer)
        const message = window.prompt("Commit message:");
        if (message) {
          await gitCommit(projectPath, message, false);
        }
      }
    } catch (err) {
      console.error(`Git ${action} failed:`, err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center bg-bg-elevated rounded-r border-l border-bg-border">
      <button
        onClick={() => handleGitAction("pull")}
        disabled={busy !== null}
        className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
        title="Git Pull — fetch and merge the latest commits from the upstream branch."
      >
        <ArrowDown size={11} />
      </button>
      <button
        onClick={() => handleGitAction("push")}
        disabled={busy !== null}
        className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
        title="Git Push — publish local commits on the current branch to the remote."
      >
        <ArrowUp size={11} />
      </button>
      <button
        onClick={() => handleGitAction("commit")}
        disabled={busy !== null}
        className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
        title="Git Commit — commit any staged changes with a message you provide. Does not stage files."
      >
        <GitCommit size={11} />
      </button>
    </div>
  );
}
