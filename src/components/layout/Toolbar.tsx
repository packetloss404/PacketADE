import { useState, useRef, useEffect, useMemo } from "react";
import { GitBranch, FolderOpen, Diamond, Wrench, FolderTree, MessageSquare, Github, Brain, User, BarChart3, Rocket, ArrowDown, ArrowUp, GitCommit, Sun, Moon, DollarSign, ClipboardList, ShieldCheck, LayoutGrid } from "lucide-react";
import { DropdownItem } from "./DropdownItem";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore, isModuleView, moduleViewId, type AppView } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { getModulesSorted } from "@/modules/registry";
import { useProfileStore } from "@/stores/profileStore";
import { useGitInfo } from "@/hooks/useGitInfo";
import { open } from "@tauri-apps/plugin-dialog";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useMosaicStore } from "@/stores/mosaicStore";
import { CodeQualityModal } from "@/components/quality/CodeQualityModal";
import { SpecImportModal } from "@/components/views/SpecImportModal";
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

const TABS: { key: AppView; label: string }[] = [
  { key: "workspace", label: "Workspaces" },
  { key: "flight_deck", label: "Flights" },
  { key: "issues", label: "Issues" },
  { key: "history", label: "History" },
];

export function Toolbar() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);
  const gitBranch = useGitInfo();
  const [showCodeQuality, setShowCodeQuality] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showSpecImport, setShowSpecImport] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const explorerOpen = useLayoutStore((s) => s.explorerOpen);
  const toggleExplorer = useLayoutStore((s) => s.toggleExplorer);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const profiles = useProfileStore((s) => s.profiles);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const moduleStates = useModuleStore((s) => s.states);

  const flights = useFlightStore((s) => s.flights);
  const attentionCount = useMemo(() => {
    const { computeFlightStatus } = useFlightStore.getState();
    return flights.filter((f) => {
      const status = computeFlightStatus(f.id);
      return status === "paused" || status === "failed";
    }).length;
  }, [flights]);

  const approvalCount = flights.reduce((count, f) =>
    count + f.milestones.reduce((mc, m) =>
      mc + m.tasks.filter((t) => t.status === "approval_needed").length, 0), 0);

  const projectName = projectPath.split(/[/\\]/).pop() || "PacketCode";

  // Close tools menu when clicking outside
  useEffect(() => {
    if (!showToolsMenu && !showProfileMenu) return;
    function handleClick(e: MouseEvent) {
      if (showToolsMenu && toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setShowToolsMenu(false);
      }
      if (showProfileMenu && profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showToolsMenu, showProfileMenu]);

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

  function handleTabClick(key: AppView) {
    setActiveView(key);
  }

  return (
    <div className="flex items-center h-9 px-3 bg-bg-tertiary border-b border-bg-border gap-2">
      {/* Left section — view tabs + actions */}
      <div className="flex items-center gap-1 flex-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabClick(tab.key)}
            className={`px-2.5 py-1 text-xs rounded transition-colors flex items-center gap-1 ${
              activeView === tab.key
                ? "text-accent-green bg-bg-elevated"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
          >
            {tab.label}
            {tab.key === "flight_deck" && attentionCount > 0 && (
              <span className="px-1.5 py-0 text-[9px] font-bold rounded-full bg-accent-amber/20 text-accent-amber">
                {attentionCount}
              </span>
            )}
          </button>
        ))}

        {/* Tools dropdown */}
        <div className="relative" ref={toolsMenuRef}>
          <button
            onClick={() => setShowToolsMenu(!showToolsMenu)}
            className={`px-2.5 py-1 text-xs rounded transition-colors flex items-center gap-1 ${
              activeView === "tools" || activeView === "insights" || activeView === "github" || activeView === "memory" || activeView === "analytics" || isModuleView(activeView)
                ? "text-accent-green bg-bg-elevated"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
          >
            <Wrench size={11} />
            Tools
          </button>

          {showToolsMenu && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1">
              <DropdownItem
                icon={<FolderTree size={12} className="text-accent-amber" />}
                label="Explorer"
                badge={explorerOpen ? "open" : undefined}
                onClick={() => { toggleExplorer(); setShowToolsMenu(false); }}
              />
              {getModulesSorted()
                .filter((mod) => moduleStates[mod.id]?.enabled ?? false)
                .map((mod) => {
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
              <DropdownItem icon={<MessageSquare size={12} className="text-accent-blue" />} label="Insights Chat"
                onClick={() => { setActiveView("insights"); setShowToolsMenu(false); }} />
              <DropdownItem icon={<Github size={12} className="text-text-primary" />} label="GitHub"
                onClick={() => { setActiveView("github"); setShowToolsMenu(false); }} />
              <DropdownItem icon={<Brain size={12} className="text-accent-purple" />} label="Memory"
                onClick={() => { setActiveView("memory"); setShowToolsMenu(false); }} />
              <DropdownItem icon={<BarChart3 size={12} className="text-accent-green" />} label="Cost & Usage"
                onClick={() => { setActiveView("analytics"); setShowToolsMenu(false); }} />
              <DropdownItem icon={<ClipboardList size={12} className="text-accent-green" />} label="Import Spec"
                onClick={() => { setShowSpecImport(true); setShowToolsMenu(false); }} />
              <div className="h-px bg-bg-border my-0.5" />
              <DropdownItem icon={<Wrench size={12} className="text-text-muted" />} label="Settings"
                onClick={() => { setActiveView("tools"); setShowToolsMenu(false); }} />
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-bg-border ml-1" />

      </div>

      {/* Profile quick-switch */}
      <div className="relative" ref={profileMenuRef}>
        <button
          onClick={() => setShowProfileMenu(!showProfileMenu)}
          className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded transition-colors ${
            activeProfile
              ? `${activeProfile.color} bg-bg-elevated`
              : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
          }`}
          title="Agent Profile"
        >
          <User size={11} />
          <span>{activeProfile?.name || "No Profile"}</span>
        </button>

        {showProfileMenu && (
          <div className="absolute top-full right-0 mt-1 w-52 bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1">
            <button
              onClick={() => {
                setActiveProfile(null);
                setShowProfileMenu(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-[11px] hover:bg-bg-hover transition-colors text-left ${
                !activeProfileId ? "text-accent-green" : "text-text-secondary"
              }`}
            >
              No Profile
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setActiveProfile(p.id);
                  setShowProfileMenu(false);
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-[11px] hover:bg-bg-hover transition-colors text-left ${
                  activeProfileId === p.id ? "text-accent-green" : "text-text-secondary"
                }`}
              >
                <span className={p.color}>
                  <User size={10} />
                </span>
                <span className="flex-1">{p.name}</span>
                {activeProfileId === p.id && (
                  <span className="text-[9px] text-accent-green">active</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pane layout presets (visible when a workspace is active) */}
      <PaneLayoutControls />

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* Review Queue */}
        <button
          onClick={() => setActiveView("review_queue")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "review_queue"
              ? "bg-bg-elevated text-accent-amber"
              : "text-text-muted hover:text-accent-amber"
          }`}
          title="Review Queue"
        >
          <ShieldCheck size={11} />
          <span>Review</span>
          {approvalCount > 0 && (
            <span className="ml-0.5 px-1.5 py-0 text-[9px] font-bold rounded-full bg-accent-amber/20 text-accent-amber">
              {approvalCount}
            </span>
          )}
        </button>

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="p-1 text-text-muted hover:text-text-primary transition-colors"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
        </button>

        {/* Cost & Usage */}
        <button
          onClick={() => setActiveView("analytics")}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "analytics"
              ? "bg-bg-elevated text-accent-amber"
              : "text-text-muted hover:text-accent-amber"
          }`}
          title="Cost & Usage"
        >
          <DollarSign size={11} />
        </button>

        {/* Deploy button */}
        <button
          onClick={() => setActiveView("deploy")}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors ${
            activeView === "deploy"
              ? "bg-bg-elevated text-accent-amber"
              : "bg-bg-elevated text-text-secondary hover:text-accent-amber"
          }`}
          title="Deploy Pipeline"
        >
          <Rocket size={12} className="text-accent-amber" />
          <span>Deploy</span>
        </button>

        {/* Code Quality button */}
        <button
          onClick={() => setShowCodeQuality(true)}
          className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-elevated rounded text-xs text-text-secondary hover:text-accent-amber transition-colors"
          title="Code Quality"
        >
          <Diamond size={12} className="text-accent-amber" />
          <span>Quality</span>
        </button>

        {/* Git branch + actions */}
        {gitBranch && (
          <div className="flex items-center gap-0.5">
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-elevated rounded-l text-xs">
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
          title={projectPath}
        >
          <FolderOpen size={12} />
          <span>{projectName}</span>
        </button>
      </div>

      {/* Modals */}
      {showCodeQuality && (
        <CodeQualityModal onClose={() => setShowCodeQuality(false)} />
      )}
      {showSpecImport && (
        <SpecImportModal onClose={() => setShowSpecImport(false)} />
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
    <div className="flex items-center gap-1">
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
          title={`Apply ${label} layout`}
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
        title="Git Pull"
      >
        <ArrowDown size={11} />
      </button>
      <button
        onClick={() => handleGitAction("push")}
        disabled={busy !== null}
        className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
        title="Git Push"
      >
        <ArrowUp size={11} />
      </button>
      <button
        onClick={() => handleGitAction("commit")}
        disabled={busy !== null}
        className="p-1 text-text-muted hover:text-accent-green transition-colors disabled:opacity-40"
        title="Git Commit"
      >
        <GitCommit size={11} />
      </button>
    </div>
  );
}
