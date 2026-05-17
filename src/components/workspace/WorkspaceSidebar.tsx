import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsRight,
  Plus,
  Folder,
  Github,
  LayoutGrid,
  X,
  Sparkles,
  Terminal,
  Brain,
  Plane,
  Clock,
  Pin,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAppStore } from "@/stores/appStore";
import { WorkspaceCreationModal } from "./WorkspaceCreationModal";
import { killPty } from "@/lib/tauri";
import { relativeTime } from "@/lib/time";
import type { MemoryEvent } from "@/types/memory";

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
  const events = useMemoryStore((s) => s.events);
  const openMemoryView = useAppStore((s) => s.openMemoryView);

  const [filter, setFilter] = useState("");
  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const [learningsOpen, setLearningsOpen] = useState(true);
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

  // Session stats for active workspaces
  const totalSessions = activeWorkspaces.reduce(
    (sum, ws) => sum + ws.panes.filter((p) => p.sessionId).length, 0
  );

  // Top patterns (max 4) — pinned first, then by confidence. Patterns
  // scoped to a different project are filtered out; legacy patterns
  // without a projectPath are kept (treated as global).
  const topPatterns = useMemo(() => {
    const cur = normalizePath(projectPath);
    return [...patterns]
      .filter((p) => {
        if (p.projectPath && normalizePath(p.projectPath) !== cur) return false;
        return p.pinned || p.confidence >= 0.6;
      })
      .sort((a, b) => {
        if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return a.pinned ? -1 : 1;
        return b.confidence - a.confidence;
      })
      .slice(0, 4);
  }, [patterns, projectPath]);

  // v0.8-H — last 5 memory events whose projectPath matches the active
  // workspace's project. Reverse-chronological so the most recent
  // learning is on top.
  const recentLearnings = useMemo(() => {
    if (!projectPath) return [] as MemoryEvent[];
    const cur = normalizePath(projectPath);
    return [...events]
      .filter((e) => normalizePath(e.projectPath) === cur)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);
  }, [events, projectPath]);

  function learningSummary(e: MemoryEvent): string {
    switch (e.type) {
      case "session_completed":
        return e.payload.summary?.trim() || `${e.payload.agentId} session`;
      case "task_completed":
        return e.payload.summary?.trim() || e.payload.taskTitle || "Task done";
      case "flight_completed":
        return e.payload.summary?.trim() || e.payload.flightTitle || "Mission complete";
      case "manual_note":
        return e.payload.summary?.trim() || e.payload.body.slice(0, 80);
    }
  }

  function learningIcon(e: MemoryEvent) {
    switch (e.type) {
      case "session_completed":
        return <Clock size={9} className="text-accent-green flex-shrink-0" />;
      case "task_completed":
        return <Sparkles size={9} className="text-accent-amber flex-shrink-0" />;
      case "flight_completed":
        return <Plane size={9} className="text-accent-blue flex-shrink-0" />;
      case "manual_note":
        return <Pin size={9} className="text-accent-purple flex-shrink-0" />;
    }
  }

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
      <div className="flex flex-col overflow-hidden border-b border-bg-border">
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
        <div className="overflow-y-auto px-3 pb-2 max-h-[180px]">
          {topPatterns.length === 0 ? (
            <p className="text-[10px] text-text-muted py-1">
              Patterns will appear here as memory learns from your sessions.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {topPatterns.map((p) => (
                <div
                  key={p.id}
                  className="text-[10px] text-text-secondary leading-snug flex items-start gap-1"
                >
                  {p.pinned && (
                    <Pin
                      size={8}
                      className="text-accent-green flex-shrink-0 mt-0.5"
                      aria-label="Pinned"
                    />
                  )}
                  <span>
                    <span className="text-[9px] text-text-muted">[{p.category}]</span>{" "}
                    {p.pattern}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* v0.8-H — RECENT LEARNINGS mini-feed scoped to active project */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <button
          onClick={() => setLearningsOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-bg-hover transition-colors flex-shrink-0"
        >
          {learningsOpen ? (
            <ChevronDown size={10} className="text-text-muted" />
          ) : (
            <ChevronRight size={10} className="text-text-muted" />
          )}
          <Brain size={10} className="text-accent-green" />
          <span className="text-[10px] uppercase tracking-wide text-text-secondary font-semibold">
            Recent learnings
          </span>
          {recentLearnings.length > 0 && (
            <span className="text-[10px] text-text-muted">
              ({recentLearnings.length})
            </span>
          )}
        </button>
        {learningsOpen && (
          <div className="flex-1 overflow-y-auto px-3 pb-2">
            {recentLearnings.length === 0 ? (
              <p className="text-[10px] text-text-muted py-1">
                {projectPath
                  ? "Nothing learned yet for this project."
                  : "Open a project to see its learnings."}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {recentLearnings.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-start gap-1.5 text-[10px] text-text-secondary leading-snug"
                    title={learningSummary(e)}
                  >
                    {learningIcon(e)}
                    <span className="flex-1 min-w-0 truncate">
                      {learningSummary(e)}
                    </span>
                    <span className="text-[9px] text-text-muted flex-shrink-0">
                      {relativeTime(e.timestamp)}
                    </span>
                  </div>
                ))}
                {projectPath && (
                  <button
                    type="button"
                    onClick={() =>
                      openMemoryView({ projectPath: projectPath })
                    }
                    className="text-[10px] text-accent-green hover:text-accent-green/80 mt-1 self-start transition-colors"
                  >
                    View all &rarr;
                  </button>
                )}
              </div>
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
      </div>

      {showCreate && (
        <WorkspaceCreationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
