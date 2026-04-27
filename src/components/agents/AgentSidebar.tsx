import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Zap,
  Trash2,
  FolderOpen,
  Server,
  Loader2,
  Circle,
  CheckCircle2,
  XCircle,
  Archive,
  ArchiveRestore,
  Layers,
  GitBranch,
  ChevronDown,
  Search,
  X,
  Plus,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { API_PROVIDERS } from "@/lib/api-models";
import { aggregateConversationCost, formatCostPill } from "@/lib/conversationCost";

type StatusFilter = "all" | "active" | "done" | "archived";
type GroupBy = "project" | "status" | "env" | "workspace";

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  project: "Project",
  status: "Status",
  env: "Environment",
  workspace: "Workspace",
};

const NO_WORKSPACE_KEY = "__no_workspace__";

const STATUS_GROUP_LABELS: Record<AgentConversation["status"], string> = {
  active: "Active",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
};

const STATUS_GROUP_ORDER: AgentConversation["status"][] = ["active", "idle", "done", "failed"];
const ENV_GROUP_ORDER = ["Local", "SSH", "Worktree"] as const;

function envGroupKey(conv: AgentConversation): "Local" | "SSH" | "Worktree" {
  if (isWorktreePath(conv.projectPath)) return "Worktree";
  if (conv.sshTarget) return "SSH";
  return "Local";
}

function statusIcon(status: AgentConversation["status"]) {
  switch (status) {
    case "active":
      return <Loader2 size={10} className="text-accent-green animate-spin shrink-0" />;
    case "idle":
      return <Circle size={10} className="text-accent-green fill-accent-green shrink-0" />;
    case "done":
      return <CheckCircle2 size={10} className="text-text-muted shrink-0" />;
    case "failed":
      return <XCircle size={10} className="text-accent-red shrink-0" />;
  }
}

function isWorktreePath(path: string): boolean {
  return path.replace(/\\/g, "/").includes("/.pkt-worktrees/");
}

function envBadge(conv: AgentConversation) {
  if (isWorktreePath(conv.projectPath)) {
    return (
      <span
        className="text-[8px] px-1 py-px bg-accent-amber/10 text-accent-amber rounded font-medium"
        title="Worktree (Flight Deck attempt)"
      >
        WT
      </span>
    );
  }
  if (conv.sshTarget) {
    return (
      <span
        className="text-[8px] px-1 py-px bg-accent-purple/10 text-accent-purple rounded font-medium"
        title={`SSH: ${conv.sshTarget.user}@${conv.sshTarget.host}`}
      >
        SSH
      </span>
    );
  }
  return null;
}

function formatRelativeTime(timestamp: number): string {
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Get a short display label for an agent CLI type. */
function agentLabel(agent: string): string {
  const provider = API_PROVIDERS.find((p) => p.agentCli === agent);
  if (provider) return provider.name.replace(" (API)", "").replace(" (Local)", "");
  const labels: Record<string, string> = {
    "claude-code": "Claude",
    codex: "Codex",
    gemini: "Gemini",
    opencode: "OpenCode",
  };
  return labels[agent] ?? agent;
}

interface AgentSidebarProps {
  onNewAgent: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function AgentSidebar({ onNewAgent, selectedId, onSelect }: AgentSidebarProps) {
  const conversations = useAgentTaskStore((s) => s.conversations ?? []);
  const deleteConversation = useAgentTaskStore((s) => s.deleteConversation);
  const archiveConversation = useAgentTaskStore((s) => s.archiveConversation);
  const unarchiveConversation = useAgentTaskStore((s) => s.unarchiveConversation);
  const projectLabels = useAgentTaskStore((s) => s.projectLabels);
  const setProjectLabel = useAgentTaskStore((s) => s.setProjectLabel);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);

  /** State for inline-renaming a project group header (groupBy=project only). */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  // Auto-focus search input when opened
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  // "/" shortcut to open search when sidebar is focused
  const handleSidebarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "/" && !searchOpen) {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  const filtered = useMemo(() => {
    if (isSearching) {
      const q = trimmedQuery.toLowerCase();
      return conversations.filter((c) => {
        if (c.archived) return false;
        if (c.title?.toLowerCase().includes(q)) return true;
        return c.messages?.some((m) => m.content?.toLowerCase().includes(q));
      });
    }
    if (filter === "archived") {
      return conversations.filter((c) => c.archived);
    }
    const visible = conversations.filter((c) => !c.archived);
    if (filter === "all") return visible;
    if (filter === "active") {
      return visible.filter((c) => c.status === "active" || c.status === "idle");
    }
    return visible.filter((c) => c.status === "done" || c.status === "failed");
  }, [conversations, filter, isSearching, trimmedQuery]);

  // Build a snippet around the first match for a conversation
  const matchSnippet = (conv: AgentConversation): string | null => {
    if (!isSearching) return null;
    const q = trimmedQuery.toLowerCase();
    if (conv.title?.toLowerCase().includes(q)) return conv.title;
    const msg = conv.messages?.find((m) => m.content?.toLowerCase().includes(q));
    if (!msg) return null;
    const content = msg.content;
    const idx = content.toLowerCase().indexOf(q);
    if (idx < 0) return null;
    const half = Math.max(0, Math.floor((60 - q.length) / 2));
    const start = Math.max(0, idx - half);
    const end = Math.min(content.length, idx + q.length + half);
    let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";
    return snippet;
  };

  const convsGrouped = useMemo(() => {
    if (isSearching) {
      const sorted = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
      const map = new Map<string, AgentConversation[]>();
      if (sorted.length > 0) map.set("__search__", sorted);
      return map;
    }
    const map = new Map<string, AgentConversation[]>();
    for (const conv of filtered) {
      let key: string;
      if (groupBy === "status") {
        key = conv.status;
      } else if (groupBy === "env") {
        key = envGroupKey(conv);
      } else if (groupBy === "workspace") {
        key = conv.workspaceId ?? NO_WORKSPACE_KEY;
      } else {
        key = conv.sshTarget
          ? `ssh:${conv.sshTarget.id}:${conv.projectPath}`
          : `local:${conv.projectPath}`;
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(conv);
    }
    for (const [, list] of map) {
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (groupBy === "status") {
      const ordered = new Map<string, AgentConversation[]>();
      for (const k of STATUS_GROUP_ORDER) {
        if (map.has(k)) ordered.set(k, map.get(k)!);
      }
      return ordered;
    }
    if (groupBy === "env") {
      const ordered = new Map<string, AgentConversation[]>();
      for (const k of ENV_GROUP_ORDER) {
        if (map.has(k)) ordered.set(k, map.get(k)!);
      }
      return ordered;
    }
    if (groupBy === "workspace") {
      // Order: real workspaces first (by workspace.updatedAt desc), then "(no workspace)" last.
      const ordered = new Map<string, AgentConversation[]>();
      const wsIds = workspaces
        .filter((w) => map.has(w.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((w) => w.id);
      for (const id of wsIds) ordered.set(id, map.get(id)!);
      // Any workspace IDs in the map that no longer exist (stale references) — bucket them as no-workspace.
      const orphans: AgentConversation[] = [];
      for (const [k, list] of map) {
        if (k === NO_WORKSPACE_KEY) continue;
        if (!wsIds.includes(k)) orphans.push(...list);
      }
      const noWs = map.get(NO_WORKSPACE_KEY) ?? [];
      const combined = [...noWs, ...orphans].sort((a, b) => b.updatedAt - a.updatedAt);
      if (combined.length > 0) ordered.set(NO_WORKSPACE_KEY, combined);
      return ordered;
    }
    return map;
  }, [filtered, groupBy, isSearching, workspaces]);

  // Search-result aggregate counts
  const searchStats = useMemo(() => {
    if (!isSearching) return { count: 0, projects: 0 };
    const projects = new Set<string>();
    for (const c of filtered) {
      const key = c.sshTarget
        ? `ssh:${c.sshTarget.id}:${c.projectPath}`
        : `local:${c.projectPath}`;
      projects.add(key);
    }
    return { count: filtered.length, projects: projects.size };
  }, [filtered, isSearching]);

  const counts = useMemo(() => {
    let all = 0;
    let active = 0;
    let done = 0;
    let archived = 0;
    for (const c of conversations) {
      if (c.archived) {
        archived++;
        continue;
      }
      all++;
      if (c.status === "active" || c.status === "idle") active++;
      else done++;
    }
    return { all, active, done, archived };
  }, [conversations]);

  const hasConversations = convsGrouped.size > 0;

  return (
    <div
      ref={sidebarRef}
      tabIndex={-1}
      onKeyDown={handleSidebarKeyDown}
      className="w-[240px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden focus:outline-none"
    >
      {/* New Agent + Search buttons */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-1">
        <button
          onClick={onNewAgent}
          className="flex items-center gap-2 flex-1 px-3 py-2 text-[11px] font-medium bg-accent-green/15 text-accent-green hover:bg-accent-green/25 border border-accent-green/30 rounded transition-colors"
        >
          <Plus size={12} />
          New Agent
          <span className="ml-auto text-[9px] text-accent-green/70">Ctrl+N</span>
        </button>
        <button
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          className={`p-2 rounded transition-colors ${
            searchOpen
              ? "text-accent-green bg-accent-green/10"
              : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
          }`}
          title="Search conversations (/)"
        >
          <Search size={11} />
        </button>
      </div>

      <div className="border-b border-bg-border mx-3 mb-1" />

      {/* Status filter (hidden when search is open) */}
      {conversations.length > 0 && !searchOpen && (
        <div className="flex items-center gap-0.5 px-3 pb-1.5">
          {(["all", "active", "done", "archived"] as StatusFilter[]).map((f) => {
            const label =
              f === "all" ? "All" : f === "active" ? "Active" : f === "done" ? "Done" : "Archived";
            const count = counts[f];
            const isActive = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex-1 text-[10px] py-0.5 rounded transition-colors ${
                  isActive
                    ? "bg-accent-green/15 text-accent-green"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {label}
                <span className="ml-1 opacity-60">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search input (replaces status filter row when active) */}
      {searchOpen && (
        <div className="px-3 pb-1.5">
          <div className="relative">
            <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              placeholder="Search messages, titles…"
              className="w-full pl-6 pr-6 py-1 text-[10px] bg-bg-primary border border-bg-border rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-text-secondary rounded"
                title="Clear"
              >
                <X size={10} />
              </button>
            )}
          </div>
          {isSearching && (
            <div className="text-[9px] text-text-muted mt-1 px-0.5">
              {searchStats.count} {searchStats.count === 1 ? "result" : "results"} across {searchStats.projects}{" "}
              {searchStats.projects === 1 ? "project" : "projects"}
            </div>
          )}
        </div>
      )}

      {/* Group-by dropdown */}
      {conversations.length > 0 && (
        <div className="relative px-3 pb-1.5">
          <button
            onClick={() => !isSearching && setGroupMenuOpen((v) => !v)}
            onBlur={() => setTimeout(() => setGroupMenuOpen(false), 120)}
            disabled={isSearching}
            className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors ${
              isSearching
                ? "text-text-muted/40 cursor-not-allowed"
                : "text-text-muted hover:text-text-secondary"
            }`}
            title={isSearching ? "Grouping disabled while searching" : "Group conversations by"}
          >
            <Layers size={10} />
            <span>Group: {GROUP_BY_LABELS[groupBy]}</span>
            <ChevronDown size={9} className="opacity-70" />
          </button>
          {groupMenuOpen && (
            <div className="absolute z-10 left-3 top-full mt-0.5 bg-bg-primary border border-bg-border rounded shadow-lg py-0.5 min-w-[120px]">
              {(
                ["project", "status", "env", ...(workspaces.length > 0 ? ["workspace" as const] : [])] as GroupBy[]
              ).map((g) => (
                <button
                  key={g}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setGroupBy(g);
                    setGroupMenuOpen(false);
                  }}
                  className={`flex items-center w-full px-2 py-1 text-[10px] text-left transition-colors ${
                    groupBy === g
                      ? "text-accent-green bg-accent-green/10"
                      : "text-text-secondary hover:bg-bg-hover"
                  }`}
                >
                  {GROUP_BY_LABELS[g]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Conversations grouped by project / status / env */}
      <div className="flex-1 overflow-y-auto px-1">
        {!hasConversations ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <Zap size={16} className="mb-2 opacity-30" />
            <p className="text-[10px]">No agents yet</p>
            <p className="text-[9px] mt-1 opacity-70">Start one with New Agent</p>
          </div>
        ) : (
          Array.from(convsGrouped.entries()).map(([key, convs]) => {
            const sshTarget = convs[0]?.sshTarget;
            const projectPath = convs[0]?.projectPath ?? "";

            let headerIcon: ReactNode;
            let headerLabel: string;
            let canRename = false;
            if (isSearching) {
              headerIcon = <Search size={10} className="text-accent-green shrink-0" />;
              headerLabel = `Search results (${convs.length})`;
            } else if (groupBy === "status") {
              const statusKey = key as AgentConversation["status"];
              headerIcon = statusIcon(statusKey);
              headerLabel = STATUS_GROUP_LABELS[statusKey] ?? key;
            } else if (groupBy === "env") {
              if (key === "SSH") {
                headerIcon = <Server size={10} className="text-accent-purple shrink-0" />;
              } else if (key === "Worktree") {
                headerIcon = <GitBranch size={10} className="text-accent-amber shrink-0" />;
              } else {
                headerIcon = <FolderOpen size={10} className="text-text-muted shrink-0" />;
              }
              headerLabel = key;
            } else if (groupBy === "workspace") {
              if (key === NO_WORKSPACE_KEY) {
                headerIcon = <FolderOpen size={10} className="text-text-muted shrink-0" />;
                headerLabel = "(no workspace)";
              } else {
                const ws = workspaces.find((w) => w.id === key);
                headerIcon = <Layers size={10} className="text-accent-blue shrink-0" />;
                headerLabel = ws?.name ?? "(unknown workspace)";
              }
            } else {
              headerIcon = sshTarget ? (
                <Server size={10} className="text-accent-green shrink-0" />
              ) : (
                <FolderOpen size={10} className="text-text-muted shrink-0" />
              );
              const customLabel = projectLabels[projectPath];
              if (customLabel) {
                headerLabel = customLabel;
              } else if (sshTarget) {
                headerLabel = sshTarget.name;
              } else {
                const segments = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
                headerLabel = segments[segments.length - 1] ?? projectPath;
              }
              canRename = !sshTarget;
            }

            const isRenaming = canRename && renamingPath === projectPath;
            const fullPathTitle = sshTarget
              ? `${sshTarget.user}@${sshTarget.host}:${sshTarget.remotePath}`
              : projectPath;

            const commitRename = () => {
              setProjectLabel(projectPath, renameValue);
              setRenamingPath(null);
              setRenameValue("");
            };

            return (
            <div key={key} className="mb-2">
              {/* Group header */}
              <div
                className="flex items-center gap-1.5 px-2 py-1.5"
                title={canRename ? `${fullPathTitle} — right-click to rename` : fullPathTitle}
                onContextMenu={(e) => {
                  if (!canRename) return;
                  e.preventDefault();
                  setRenamingPath(projectPath);
                  setRenameValue(projectLabels[projectPath] ?? headerLabel);
                }}
              >
                {headerIcon}
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingPath(null);
                        setRenameValue("");
                      }
                    }}
                    className="text-[10px] font-medium bg-bg-primary border border-accent-green/40 rounded px-1 py-px text-text-primary lowercase focus:outline-none flex-1 min-w-0"
                  />
                ) : (
                  <span className="text-[10px] font-medium text-text-muted truncate lowercase tracking-wide">
                    {headerLabel}
                  </span>
                )}
                {groupBy === "workspace" && key !== NO_WORKSPACE_KEY && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveWorkspace(key);
                      setActiveView("workspace");
                    }}
                    className="ml-auto p-0.5 text-text-muted hover:text-accent-blue rounded transition-colors"
                    title="Open this workspace"
                    aria-label="Open workspace"
                  >
                    <FolderOpen size={10} />
                  </button>
                )}
                <span
                  className={`text-[9px] text-text-muted shrink-0 ${
                    groupBy === "workspace" && key !== NO_WORKSPACE_KEY ? "" : "ml-auto"
                  }`}
                >
                  {convs.length}
                </span>
              </div>

              {/* Agent conversations under this project */}
              {convs.map((conv) => {
                const isSelected = conv.id === selectedId;
                const lastMessage = conv.messages?.[conv.messages.length - 1];
                const preview = lastMessage
                  ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? "..." : "")
                  : null;
                const modelShort = conv.model?.split("-").slice(0, 2).join(" ") ?? "";
                const snippet = matchSnippet(conv);
                const { totalTokens, estCost } = aggregateConversationCost(conv);
                const costLabel = formatCostPill(estCost, totalTokens);

                return (
                  <div key={conv.id} className="group relative">
                    <button
                      onClick={() => onSelect(conv.id)}
                      title={conv.title}
                      className={`flex items-start gap-2 w-full px-2 py-1.5 text-left rounded transition-colors ${
                        isSelected
                          ? "bg-accent-green/10 border-l-2 border-accent-green"
                          : "hover:bg-bg-hover"
                      }`}
                    >
                      <span className="mt-0.5">{statusIcon(conv.status)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span className={`text-[11px] truncate flex-1 ${isSelected ? "text-text-primary font-medium" : "text-text-secondary"}`}>
                            {agentLabel(conv.agent)}
                          </span>
                          {envBadge(conv)}
                          <span className="text-[9px] text-text-muted shrink-0">
                            {formatRelativeTime(conv.updatedAt)}
                          </span>
                        </div>
                        {snippet ? (
                          <p className="text-[9px] text-text-muted truncate mt-0.5">
                            {snippet}
                          </p>
                        ) : (
                          <>
                            {(modelShort || costLabel) && (
                              <div className="flex items-center gap-1">
                                {modelShort && (
                                  <span className="text-[9px] text-text-muted">{modelShort}</span>
                                )}
                                {costLabel && (
                                  <span
                                    className="text-[8px] px-1 py-px bg-bg-elevated text-text-muted rounded font-mono"
                                    title={`Estimated cost (${totalTokens.toLocaleString()} tokens)`}
                                  >
                                    {costLabel}
                                  </span>
                                )}
                              </div>
                            )}
                            {preview && (
                              <p className="text-[9px] text-text-muted truncate mt-0.5 opacity-70">
                                {preview}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (conv.archived) unarchiveConversation(conv.id);
                        else archiveConversation(conv.id);
                      }}
                      className="absolute right-6 top-1.5 p-0.5 text-text-muted hover:text-accent-green opacity-0 group-hover:opacity-100 transition-opacity rounded"
                      title={conv.archived ? "Unarchive" : "Archive"}
                    >
                      {conv.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                      className="absolute right-1 top-1.5 p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity rounded"
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
            );
          })
        )}
      </div>

      {/* Profile / plan footer */}
      <SidebarFooter />
    </div>
  );
}

function SidebarFooter() {
  const conversations = useAgentTaskStore((s) => s.conversations ?? []);
  const initials = "IW";
  const name = "Ian Walmsley";
  const plan = "Pro+ Plan";
  const activeCount = conversations.filter(
    (c) => !c.archived && (c.status === "active" || c.status === "idle"),
  ).length;
  return (
    <div className="border-t border-bg-border px-3 py-2 flex items-center gap-2">
      <div className="w-6 h-6 rounded-full bg-accent-green/20 text-accent-green flex items-center justify-center text-[10px] font-semibold shrink-0">
        {initials}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[11px] text-text-secondary truncate leading-tight">{name}</span>
        <span className="text-[9px] text-text-muted truncate leading-tight">{plan}</span>
      </div>
      {activeCount > 0 && (
        <span
          className="text-[9px] px-1.5 py-px bg-accent-green/15 text-accent-green rounded-full font-medium"
          title={`${activeCount} active agent${activeCount === 1 ? "" : "s"}`}
        >
          {activeCount}
        </span>
      )}
    </div>
  );
}
