import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsRight,
  Plus,
  Folder,
  FolderOpen,
  LayoutGrid,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { WorkspaceCreationModal } from "./WorkspaceCreationModal";

function shortName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function compactRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  const hour = Math.floor(diff / 3_600_000);
  const day = Math.floor(diff / 86_400_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (hour < 24) return `${hour}h`;
  if (day < 30) return `${day}d`;
  // Use absolute month/day for older entries
  const d = new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

export function WorkspaceSidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const keepTerminalsAlive = useWorkspaceStore((s) => s.keepTerminalsAlive);
  const setKeepTerminalsAlive = useWorkspaceStore((s) => s.setKeepTerminalsAlive);

  const projects = useProjectHistoryStore((s) => s.projects);
  const projectPath = useLayoutStore((s) => s.projectPath);
  const setProjectPath = useLayoutStore((s) => s.setProjectPath);

  const [filter, setFilter] = useState("");
  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const activeWorkspaces = useMemo(
    () => workspaces.filter((w) => w.status === "active"),
    [workspaces]
  );

  const filteredWorkspaces = useMemo(() => {
    if (!filter.trim()) return activeWorkspaces;
    const f = filter.toLowerCase();
    return activeWorkspaces.filter((w) => w.name.toLowerCase().includes(f));
  }, [activeWorkspaces, filter]);

  const filteredProjects = useMemo(() => {
    const sorted = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);
    if (!filter.trim()) return sorted;
    const f = filter.toLowerCase();
    return sorted.filter((p) => shortName(p.path).toLowerCase().includes(f));
  }, [projects, filter]);

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

  const projectName = projectPath ? shortName(projectPath) : "No project";

  return (
    <div className="w-60 flex flex-col bg-bg-secondary border-l border-bg-border overflow-hidden">
      {/* Header — current project + nav */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-bg-border">
        <Folder size={11} className="text-accent-green flex-shrink-0" />
        <span className="text-[11px] font-medium text-text-primary truncate flex-1">
          {projectName}
        </span>
        <button className="p-0.5 text-text-muted hover:text-text-primary transition-colors" title="Sort">
          <ChevronsRight size={11} />
        </button>
        <button className="p-0.5 text-text-muted hover:text-text-primary transition-colors" title="Previous">
          <ChevronLeft size={11} />
        </button>
        <button className="p-0.5 text-text-muted hover:text-text-primary transition-colors" title="Next">
          <ChevronRight size={11} />
        </button>
      </div>

      {/* Filter */}
      <div className="px-3 py-2 border-b border-bg-border">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          className="w-full bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
        />
      </div>

      {/* WORKSPACES section */}
      <div className="border-b border-bg-border">
        <button
          onClick={() => setWorkspacesOpen((v) => !v)}
          className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-bg-hover transition-colors"
        >
          {workspacesOpen ? (
            <ChevronDown size={10} className="text-text-muted" />
          ) : (
            <ChevronRight size={10} className="text-text-muted" />
          )}
          <span className="text-[10px] uppercase tracking-wide text-text-secondary font-semibold">
            Workspaces
          </span>
          <span className="text-[10px] text-text-muted">({filteredWorkspaces.length})</span>
          <div className="flex-1" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowCreate(true);
            }}
            className="flex items-center gap-0.5 text-[10px] text-accent-green hover:text-accent-green/80 transition-colors"
            title="New workspace"
          >
            <Plus size={10} />
            New
          </button>
        </button>
        {workspacesOpen && (
          <div className="pb-1">
            {filteredWorkspaces.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-text-muted">No workspaces</div>
            ) : (
              filteredWorkspaces.map((ws) => {
                const isActive = ws.id === activeWorkspaceId;
                return (
                  <button
                    key={ws.id}
                    onClick={() => setActiveWorkspace(ws.id)}
                    className={`flex items-start gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                      isActive
                        ? "bg-accent-purple/15 border-l-2 border-accent-purple"
                        : "hover:bg-bg-hover border-l-2 border-transparent"
                    }`}
                  >
                    <LayoutGrid
                      size={11}
                      className={`mt-0.5 ${isActive ? "text-accent-purple" : "text-text-muted"}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-[11px] font-medium truncate ${
                          isActive ? "text-text-primary" : "text-text-secondary"
                        }`}
                      >
                        {ws.name}
                      </div>
                      <div className="text-[9px] text-text-muted truncate">
                        {new Date(ws.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* PROJECTS section */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <button
          onClick={() => setProjectsOpen((v) => !v)}
          className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-bg-hover transition-colors flex-shrink-0"
        >
          {projectsOpen ? (
            <ChevronDown size={10} className="text-text-muted" />
          ) : (
            <ChevronRight size={10} className="text-text-muted" />
          )}
          <span className="text-[10px] uppercase tracking-wide text-text-secondary font-semibold">
            Projects
          </span>
          <span className="text-[10px] text-text-muted">({filteredProjects.length})</span>
          <div className="flex-1" />
          <span className="flex items-center gap-0.5 text-[10px] text-text-muted">
            Recent
            <ChevronDown size={9} />
          </span>
        </button>
        {projectsOpen && (
          <div className="flex-1 overflow-y-auto pb-1">
            {filteredProjects.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-text-muted">No projects yet</div>
            ) : (
              filteredProjects.map((p) => {
                const isActive = p.path === projectPath;
                return (
                  <button
                    key={p.path}
                    onClick={() => setProjectPath(p.path)}
                    className={`flex items-center gap-2 w-full px-3 py-1 text-left transition-colors ${
                      isActive
                        ? "bg-accent-green/10 border-l-2 border-accent-green"
                        : "hover:bg-bg-hover border-l-2 border-transparent"
                    }`}
                    title={p.path}
                  >
                    <Folder
                      size={10}
                      className={isActive ? "text-accent-green" : "text-text-muted"}
                    />
                    <span
                      className={`flex-1 text-[11px] truncate ${
                        isActive ? "text-accent-green font-medium" : "text-text-secondary"
                      }`}
                    >
                      {shortName(p.path)}
                    </span>
                    <span className="text-[9px] text-text-muted flex-shrink-0">
                      {compactRelative(p.lastOpened)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-bg-border">
        <button
          onClick={() => setKeepTerminalsAlive(!keepTerminalsAlive)}
          className="flex items-center gap-2 w-full px-3 py-2 hover:bg-bg-hover transition-colors text-left"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              keepTerminalsAlive ? "bg-accent-green" : "bg-text-muted"
            }`}
          />
          <span className="text-[11px] text-text-secondary">Keep terminals alive</span>
        </button>
        <button
          onClick={handleOpenFolder}
          className="flex items-center gap-2 w-full px-3 py-2 border-t border-bg-border hover:bg-bg-hover transition-colors text-left"
        >
          <FolderOpen size={11} className="text-text-muted" />
          <span className="text-[11px] text-text-secondary">Open Folder...</span>
        </button>
      </div>

      {showCreate && (
        <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
