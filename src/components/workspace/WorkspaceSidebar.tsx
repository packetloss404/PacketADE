import { useState, useMemo, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsRight,
  Plus,
  Folder,
  LayoutGrid,
  X,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
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
  const keepTerminalsAlive = useWorkspaceStore((s) => s.keepTerminalsAlive);
  const setKeepTerminalsAlive = useWorkspaceStore((s) => s.setKeepTerminalsAlive);

  const projectPath = useLayoutStore((s) => s.projectPath);
  const patterns = useMemoryStore((s) => s.patterns);

  const [filter, setFilter] = useState("");
  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);

  async function handleDeleteWorkspace(id: string) {
    const ws = workspaces.find((w) => w.id === id);
    if (ws) {
      // Kill any running PTY sessions before deleting
      await Promise.all(
        ws.panes
          .filter((p) => p.sessionId)
          .map((p) => killPty(p.sessionId!).catch(() => {}))
      );
    }
    deleteWorkspace(id);
  }

  // Filter workspaces to current project only
  const activeWorkspaces = useMemo(
    () => workspaces.filter(
      (w) => w.status === "active" && normalizePath(w.projectPath) === normalizePath(projectPath)
    ),
    [workspaces, projectPath]
  );

  // Clear active workspace when switching to a different project
  useEffect(() => {
    const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
    if (activeWs && normalizePath(activeWs.projectPath) !== normalizePath(projectPath)) {
      setActiveWorkspace(null);
    }
  }, [projectPath, activeWorkspaceId, workspaces, setActiveWorkspace]);

  const filteredWorkspaces = useMemo(() => {
    if (!filter.trim()) return activeWorkspaces;
    const f = filter.toLowerCase();
    return activeWorkspaces.filter((w) => w.name.toLowerCase().includes(f));
  }, [activeWorkspaces, filter]);

  const projectName = projectPath ? shortName(projectPath) : "No project";

  // Session stats for active workspaces
  const totalSessions = activeWorkspaces.reduce(
    (sum, ws) => sum + ws.panes.filter((p) => p.sessionId).length, 0
  );

  // Top patterns (max 4)
  const topPatterns = patterns
    .filter((p) => p.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);

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
              })
            )}
          </div>
        )}
      </div>

      {/* SESSION STATS */}
      <div className="border-b border-bg-border px-3 py-2">
        <span className="text-[10px] uppercase tracking-wide text-text-secondary font-semibold">
          Session Stats
        </span>
        <div className="flex items-center gap-4 mt-1.5">
          <div className="flex items-center gap-1.5">
            <LayoutGrid size={10} className="text-text-muted" />
            <span className="text-[11px] text-text-secondary">{activeWorkspaces.length}</span>
            <span className="text-[9px] text-text-muted">workspace{activeWorkspaces.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Terminal size={10} className="text-text-muted" />
            <span className="text-[11px] text-text-secondary">{totalSessions}</span>
            <span className="text-[9px] text-text-muted">active</span>
          </div>
        </div>
      </div>

      {/* MEMORY PATTERNS */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-1.5 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <Sparkles size={10} className="text-accent-amber" />
            <span className="text-[10px] uppercase tracking-wide text-text-secondary font-semibold">
              Learned Patterns
            </span>
            {topPatterns.length > 0 && (
              <span className="text-[10px] text-text-muted">({topPatterns.length})</span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-2">
          {topPatterns.length === 0 ? (
            <p className="text-[10px] text-text-muted py-1">
              Patterns will appear here as memory learns from your sessions.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {topPatterns.map((p) => (
                <div key={p.id} className="text-[10px] text-text-secondary leading-snug">
                  <span className="text-[9px] text-text-muted">[{p.category}]</span>{" "}
                  {p.pattern}
                </div>
              ))}
            </div>
          )}
        </div>
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
      </div>

      {showCreate && (
        <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
