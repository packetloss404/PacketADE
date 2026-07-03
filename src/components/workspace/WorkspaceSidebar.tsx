import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Folder,
  Github,
  LayoutGrid,
  X,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { WorkspaceCreationModal } from "./WorkspaceCreationModal";
import { killPty } from "@/lib/tauri";

function shortName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function WorkspaceSidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);

  const projectPath = useLayoutStore((s) => s.projectPath);

  const [filter, setFilter] = useState("");
  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);

  async function handleDeleteWorkspace(id: string) {
    const ws = workspaces.find((w) => w.id === id);
    if (ws) {
      // Kill any running PTY sessions before deleting — best-effort,
      // swallow if a pane's PTY has already exited.
      await Promise.all(
        ws.panes
          .filter((p) => p.sessionId)
          .map((p) => killPty(p.sessionId!).catch(() => {}))
      );
    }
    deleteWorkspace(id);
  }

  // Show all active workspaces regardless of project path
  const activeWorkspaces = useMemo(
    () => workspaces.filter((w) => w.status === "active"),
    [workspaces]
  );

  const filteredWorkspaces = useMemo(() => {
    if (!filter.trim()) return activeWorkspaces;
    const f = filter.toLowerCase();
    return activeWorkspaces.filter((w) => w.name.toLowerCase().includes(f));
  }, [activeWorkspaces, filter]);

  // Group filtered workspaces by projectPath, current project first
  const workspacesByProject = useMemo(() => {
    const map = new Map<string, typeof filteredWorkspaces>();
    for (const ws of filteredWorkspaces) {
      const key = ws.projectPath;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ws);
    }
    const currentNorm = normalizePath(projectPath);
    const sorted = [...map.entries()].sort(([a], [b]) => {
      const aIsCurrent = normalizePath(a) === currentNorm;
      const bIsCurrent = normalizePath(b) === currentNorm;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return shortName(a).localeCompare(shortName(b));
    });
    return sorted;
  }, [filteredWorkspaces, projectPath]);

  const projectName = projectPath ? shortName(projectPath) : "No project";

  return (
    <div className="w-60 flex flex-col bg-bg-secondary border-l border-bg-border overflow-hidden">
      {/* Header — current project + nav */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-bg-border">
        <Folder size={11} className="text-accent-green flex-shrink-0" />
        <span className="text-[11px] font-medium text-text-primary truncate flex-1">
          {projectName}
        </span>
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

      {/* WORKSPACES section — owns the freed vertical space now that the
          memory telemetry sections below are gone. */}
      <div className="flex flex-1 min-h-0 flex-col">
        <button
          onClick={() => setWorkspacesOpen((v) => !v)}
          className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-bg-hover transition-colors flex-shrink-0"
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
          <div className="flex-1 min-h-0 overflow-y-auto pb-1">
            {filteredWorkspaces.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-text-muted">No workspaces</div>
            ) : (
              workspacesByProject.map(([projPath, projWorkspaces]) => {
                const isCurrent = normalizePath(projPath) === normalizePath(projectPath);
                return (
                  <div key={projPath}>
                    {/* Project group header */}
                    <div className="flex items-center gap-1.5 px-3 py-1 mt-1">
                      <Folder size={9} className={isCurrent ? "text-accent-green" : "text-text-muted"} />
                      <span className={`text-[9px] uppercase tracking-wide font-semibold truncate ${
                        isCurrent ? "text-accent-green" : "text-text-muted"
                      }`}>
                        {shortName(projPath)}
                      </span>
                      <span className="text-[9px] text-text-muted">({projWorkspaces.length})</span>
                    </div>
                    {/* Workspace cards within this project */}
                    {projWorkspaces.map((ws) => {
                      const isActive = ws.id === activeWorkspaceId;
                      return (
                        <div
                          key={ws.id}
                          className={`flex items-start gap-2 w-full px-3 py-1.5 transition-colors group ${
                            isActive
                              ? "bg-accent-purple/15 border-l-2 border-accent-purple"
                              : "hover:bg-bg-hover border-l-2 border-transparent"
                          }`}
                        >
                          <button
                            onClick={() => setActiveWorkspace(ws.id)}
                            className="flex items-start gap-2 flex-1 min-w-0 text-left"
                          >
                            <LayoutGrid
                              size={11}
                              className={`mt-0.5 flex-shrink-0 ${isActive ? "text-accent-purple" : "text-text-muted"}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div
                                className={`text-[11px] font-medium truncate flex items-center gap-1.5 ${
                                  isActive ? "text-text-primary" : "text-text-secondary"
                                }`}
                              >
                                <span className="truncate">{ws.name}</span>
                                {/* v0.8-15: workspace github bind badge */}
                                {ws.githubRepo && (
                                  <span
                                    className="flex items-center gap-0.5 text-[9px] text-text-muted bg-bg-primary border border-bg-border rounded px-1 py-px"
                                    title={`Linked to ${ws.githubRepo.owner}/${ws.githubRepo.repo}`}
                                  >
                                    <Github size={8} />
                                    <span className="truncate max-w-[80px]">
                                      {ws.githubRepo.owner}/{ws.githubRepo.repo}
                                    </span>
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-text-muted truncate">
                                {shortName(ws.projectPath)}
                                {" \u00b7 "}
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteWorkspace(ws.id);
                            }}
                            className="mt-0.5 p-0.5 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                            title="Delete workspace"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {showCreate && (
        <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
