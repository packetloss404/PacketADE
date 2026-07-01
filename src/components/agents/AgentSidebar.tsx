import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Zap,
  Trash2,
  FolderOpen,
  Server,
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
import type { AgentConversation } from "@/types/agent-conversation";
import { Modal } from "@/components/ui/Modal";
import { API_PROVIDERS } from "@/lib/api-models";
import { aggregateConversationCost, formatCostPill } from "@/lib/conversationCost";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Popover } from "@/components/ui/Popover";
import { getAgentColor, getStatusColor } from "@/lib/agentColors";

type StatusFilter = "all" | "active" | "done" | "archived";
type GroupBy = "project" | "status" | "env";

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  project: "Project",
  status: "Status",
  env: "Environment",
};

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
      return <Spinner size={10} className={`${getStatusColor("active")} shrink-0`} />;
    case "idle":
      return <Circle size={10} className={`${getStatusColor("idle")} fill-accent-green shrink-0`} />;
    case "done":
      return <CheckCircle2 size={10} className={`${getStatusColor("done")} shrink-0`} />;
    case "failed":
      return <XCircle size={10} className={`${getStatusColor("failed")} shrink-0`} />;
  }
}

/** Compact model label — drops the date / build suffix when present. */
function shortModel(model: string | undefined): string {
  if (!model) return "";
  // Strip trailing date stamp like "-20250414" and provider prefix.
  let m = model.replace(/-\d{8,}$/, "");
  m = m.replace(/^claude-/i, "").replace(/^gpt-/i, "");
  return m;
}

/** Aggregate "turn" count = number of user messages in the conversation. */
function turnCount(conv: AgentConversation): number {
  return conv.messages.filter((m) => m.role === "user").length;
}

function isWorktreePath(path: string): boolean {
  return path.replace(/\\/g, "/").includes("/.pkt-worktrees/");
}

function envBadge(conv: AgentConversation) {
  if (isWorktreePath(conv.projectPath)) {
    return (
      <Tooltip content="Worktree (Flight Deck attempt)">
        <Badge tone="amber">WT</Badge>
      </Tooltip>
    );
  }
  if (conv.sshTarget) {
    return (
      <Tooltip content={`SSH: ${conv.sshTarget.user}@${conv.sshTarget.host}`}>
        <Badge tone="purple">SSH</Badge>
      </Tooltip>
    );
  }
  return null;
}

function basenameOfPath(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
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
    packetcode: "PacketCode",
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

  /** State for inline-renaming a project group header (groupBy=project only). */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<AgentConversation | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const groupBtnRef = useRef<HTMLButtonElement | null>(null);
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
    return map;
  }, [filtered, groupBy, isSearching]);

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
  const hasAnyConversations = conversations.length > 0;

  return (
    <div
      ref={sidebarRef}
      tabIndex={-1}
      onKeyDown={handleSidebarKeyDown}
      className="w-[240px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden focus:outline-none"
    >
      {/* Sessions list header — matches design (label + count pill + search/plus icons) */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-line-soft">
        <span className="text-[11px] font-semibold text-text-primary">Sessions</span>
        {conversations.length > 0 && (
          <Badge>
            {isSearching
              ? searchStats.count
              : filter === "archived"
                ? counts.archived
                : counts.all}
          </Badge>
        )}
        <span className="flex-1" />
        <Tooltip content="Search conversations (/)">
          <button
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            className={`p-1 rounded transition-colors ${
              searchOpen
                ? "text-accent-green bg-accent-green/10"
                : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
            }`}
          >
            <Search size={11} />
          </button>
        </Tooltip>
        <Tooltip content="New session (Ctrl+N)">
          <button
            onClick={onNewAgent}
            className="p-1 rounded text-text-muted hover:text-accent-green hover:bg-bg-hover transition-colors"
          >
            <Plus size={11} />
          </button>
        </Tooltip>
      </div>

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
                    ? "bg-accent-green/20 text-accent-green"
                    : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
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
          <Tooltip content={isSearching ? "Grouping disabled while searching" : "Group conversations by"}>
            <button
              ref={groupBtnRef}
              onClick={() => !isSearching && setGroupMenuOpen((v) => !v)}
              disabled={isSearching}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                isSearching
                  ? "text-text-faint cursor-not-allowed"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <Layers size={10} />
              <span>Group: {GROUP_BY_LABELS[groupBy]}</span>
              <ChevronDown size={11} className="opacity-70" />
            </button>
          </Tooltip>
          <Popover
            open={groupMenuOpen}
            onClose={() => setGroupMenuOpen(false)}
            anchorRef={groupBtnRef}
            placement="bottom-start"
            role="menu"
            className="py-0.5 min-w-[120px]"
          >
            {(["project", "status", "env"] as GroupBy[]).map((g) => (
              <button
                key={g}
                role="menuitem"
                onClick={() => {
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
          </Popover>
        </div>
      )}

      {/* Conversations grouped by project / status / env */}
      <div className="flex-1 overflow-y-auto px-1">
        {!hasConversations ? (
          isSearching ? (
            <EmptyState
              className="py-16"
              icon={<Search size={24} />}
              title={`No matches for “${trimmedQuery}”`}
              action={
                <button
                  onClick={closeSearch}
                  className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                >
                  Clear search
                </button>
              }
            />
          ) : !hasAnyConversations ? (
            <EmptyState
              className="py-16"
              icon={<Zap size={24} />}
              title="No agents yet"
              description="Start one with New Agent"
            />
          ) : filter === "archived" ? (
            <EmptyState
              className="py-16"
              icon={<Archive size={24} />}
              title="No archived sessions"
            />
          ) : (
            <EmptyState
              className="py-16"
              icon={<Zap size={24} />}
              title="No matching sessions"
              description="Try a different filter"
            />
          )
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
            <div key={key}>
              {/* Group header — uppercase tracking, design-matched */}
              <div
                className="px-3 py-1.5 flex items-center gap-1.5 bg-bg-tertiary border-y border-line-soft"
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
                    className="text-[10px] font-semibold bg-bg-primary border border-accent-green/50 rounded px-1 py-px text-text-primary uppercase tracking-wide focus:outline-none flex-1 min-w-0"
                  />
                ) : (
                  <span className="text-[10px] font-semibold text-text-secondary truncate uppercase tracking-wide">
                    {headerLabel}
                  </span>
                )}
                <span className="text-[10px] text-text-muted shrink-0 ml-auto">
                  {convs.length}
                </span>
              </div>

              {/* Agent conversations under this project */}
              {convs.map((conv) => {
                const isSelected = conv.id === selectedId;
                const snippet = matchSnippet(conv);
                const { totalTokens, estCost } = aggregateConversationCost(conv);
                const costLabel = formatCostPill(estCost, totalTokens);
                const turns = turnCount(conv);
                const branchLabel = conv.sshTarget?.name ?? "";
                const titleText = conv.title || "(untitled)";

                return (
                  <div
                    key={conv.id}
                    className={`group relative border-l-2 transition-colors ${
                      isSelected
                        ? "border-accent-purple bg-accent-purple/15"
                        : "border-transparent"
                    } border-b border-line-soft`}
                  >
                    <button
                      onClick={() => onSelect(conv.id)}
                      title={conv.title}
                      className={`flex flex-col w-full px-3 py-2 text-left gap-1 transition-colors ${
                        isSelected ? "" : "hover:bg-bg-hover"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span>{statusIcon(conv.status)}</span>
                        <span
                          className={`text-[11px] font-semibold ${getAgentColor(conv.agent).text}`}
                        >
                          {agentLabel(conv.agent)}
                        </span>
                        {conv.model && (
                          <span className="font-mono text-[9px] text-text-muted truncate">
                            {shortModel(conv.model)}
                          </span>
                        )}
                        {envBadge(conv)}
                        <span className="flex-1" />
                        <span className="text-[10px] text-text-muted shrink-0">
                          {formatRelativeTime(conv.updatedAt)}
                        </span>
                      </div>
                      <div
                        className={`text-xs leading-tight truncate ${
                          isSelected
                            ? "text-text-primary font-medium"
                            : "text-text-secondary"
                        }`}
                      >
                        {snippet ?? titleText}
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px] text-text-muted">
                        <GitBranch size={9} />
                        <span
                          className="font-mono text-text-secondary truncate max-w-[90px]"
                          title={branchLabel || conv.projectPath}
                        >
                          {branchLabel || basenameOfPath(conv.projectPath)}
                        </span>
                        <span>·</span>
                        <span>
                          {turns} turn{turns === 1 ? "" : "s"}
                        </span>
                        <span className="flex-1" />
                        {costLabel && (
                          <Tooltip content={`${totalTokens.toLocaleString()} tokens`}>
                            <span className="font-mono">
                              {costLabel}
                            </span>
                          </Tooltip>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (conv.archived) unarchiveConversation(conv.id);
                        else archiveConversation(conv.id);
                      }}
                      className="absolute right-6 top-1.5 p-0.5 text-text-muted hover:text-accent-green opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity rounded"
                      title={conv.archived ? "Unarchive" : "Archive"}
                    >
                      {conv.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingDelete(conv); }}
                      className="absolute right-1 top-1.5 p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity rounded"
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

      {/* "New session" footer — primary CTA */}
      <SidebarFooter onNewAgent={onNewAgent} />

      {pendingDelete && (
        <Modal
          title="Delete session?"
          width="w-[400px]"
          closeOnEscape
          onClose={() => setPendingDelete(null)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 rounded text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteConversation(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="px-3 py-1.5 rounded text-[11px] font-medium bg-accent-red/15 text-accent-red hover:bg-accent-red/25 transition-colors"
              >
                Delete
              </button>
            </div>
          }
        >
          <div className="px-5 py-4">
            <p className="text-xs text-text-secondary">
              Permanently delete{" "}
              <span className="text-text-primary">
                “{pendingDelete.title || "(untitled)"}”
              </span>
              ? This closes the session and removes its history.
            </p>
            <p className="text-[10px] text-text-muted mt-2">
              This can’t be undone.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SidebarFooter({ onNewAgent }: { onNewAgent: () => void }) {
  return (
    <div className="border-t border-line-strong bg-bg-tertiary px-2.5 py-2 flex items-center gap-1.5">
      <button
        onClick={onNewAgent}
        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] font-medium bg-accent-green/15 text-accent-green hover:bg-accent-green/25 border border-accent-line rounded transition-colors"
      >
        <Plus size={11} />
        New session
      </button>
    </div>
  );
}
