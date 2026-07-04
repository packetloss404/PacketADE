import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Zap,
  Trash2,
  FolderOpen,
  Server,
  Circle,
  CheckCircle2,
  XCircle,
  BellRing,
  Archive,
  ArchiveRestore,
  Search,
  X,
  Plus,
  Pin,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { Modal } from "@/components/ui/Modal";
import { API_PROVIDERS } from "@/lib/api-models";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { getAgentColor, getStatusColor } from "@/lib/agentColors";

type StatusFilter = "all" | "active" | "done" | "archived";

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

function needsYouIcon() {
  return <BellRing size={10} className="text-accent-amber shrink-0" />;
}

/**
 * Order a list of conversations: pinned rows always float to the top, then
 * most-recently-updated first. Returns a new array (does not mutate).
 */
function sortConversations(
  list: AgentConversation[],
  prefs: Record<string, { pinned?: boolean }>,
): AgentConversation[] {
  return [...list].sort((a, b) => {
    const pa = prefs[a.id]?.pinned ? 1 : 0;
    const pb = prefs[b.id]?.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return b.updatedAt - a.updatedAt;
  });
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

/** Build a short match snippet around the first hit of `q` in `content`. */
function buildSnippet(content: string, q: string): string | null {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  const half = Math.max(0, Math.floor((60 - q.length) / 2));
  const start = Math.max(0, idx - half);
  const end = Math.min(content.length, idx + q.length + half);
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}

function projectGroupKey(conv: AgentConversation): string {
  return conv.sshTarget
    ? `ssh:${conv.sshTarget.id}:${conv.projectPath}`
    : `local:${conv.projectPath}`;
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

  // Per-conversation pin (separate persisted store).
  const prefs = useAgentSidebarPrefsStore((s) => s.prefs);
  const togglePinned = useAgentSidebarPrefsStore((s) => s.togglePinned);

  // "Needs you" signal — pending permission/edit prompts, keyed by conversation.
  const pendingPerms = useAgentApprovalStore((s) => s.permissions);
  const pendingEdits = useAgentApprovalStore((s) => s.edits);
  const needsYou = (id: string): boolean =>
    (pendingPerms.get(id)?.length ?? 0) + (pendingEdits.get(id)?.length ?? 0) > 0;

  /** State for inline-renaming a project group header. */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<AgentConversation | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);

  const trimmedQuery = searchQuery.trim();
  // Defer the expensive full-message scan so keystrokes never block the input.
  const deferredQuery = useDeferredValue(trimmedQuery);
  const isSearching = deferredQuery.length > 0;

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

  // Search: single pass over conversations that both filters AND builds the
  // match snippet, instead of scanning every message twice.
  const { list: searchList, snippets: searchSnippets } = useMemo(() => {
    if (!isSearching) return { list: [] as AgentConversation[], snippets: new Map<string, string>() };
    const q = deferredQuery.toLowerCase();
    const list: AgentConversation[] = [];
    const snippets = new Map<string, string>();
    for (const c of conversations) {
      if (c.archived) continue;
      if (c.title?.toLowerCase().includes(q)) {
        list.push(c);
        snippets.set(c.id, c.title);
        continue;
      }
      const msg = c.messages?.find((m) => m.content?.toLowerCase().includes(q));
      if (msg) {
        const snippet = buildSnippet(msg.content, q);
        list.push(c);
        if (snippet) snippets.set(c.id, snippet);
      }
    }
    return { list: sortConversations(list, prefs), snippets };
  }, [conversations, isSearching, deferredQuery, prefs]);

  const statusFiltered = useMemo(() => {
    if (isSearching) return [];
    if (filter === "archived") {
      return conversations.filter((c) => c.archived);
    }
    const visible = conversations.filter((c) => !c.archived);
    if (filter === "all") return visible;
    if (filter === "active") {
      return visible.filter((c) => c.status === "active" || c.status === "idle");
    }
    return visible.filter((c) => c.status === "done" || c.status === "failed");
  }, [conversations, filter, isSearching]);

  const filtered = isSearching ? searchList : statusFiltered;

  // "Needs you" pseudo-group — pinned to the top, pulled out of its project
  // group while pending. Excluded entirely from the archived filter and
  // while searching.
  const { needsYouList, projectGrouped } = useMemo(() => {
    if (isSearching) return { needsYouList: [] as AgentConversation[], projectGrouped: new Map<string, AgentConversation[]>() };
    const ny: AgentConversation[] = [];
    const rest: AgentConversation[] = [];
    for (const c of statusFiltered) {
      if (!c.archived && needsYou(c.id)) ny.push(c);
      else rest.push(c);
    }
    const map = new Map<string, AgentConversation[]>();
    for (const conv of rest) {
      const key = projectGroupKey(conv);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(conv);
    }
    for (const [key, list] of map) {
      map.set(key, sortConversations(list, prefs));
    }
    return { needsYouList: sortConversations(ny, prefs), projectGrouped: map };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFiltered, isSearching, prefs, pendingPerms, pendingEdits]);

  // Search-result aggregate counts
  const searchStats = useMemo(() => {
    if (!isSearching) return { count: 0, projects: 0 };
    const projects = new Set<string>();
    for (const c of filtered) projects.add(projectGroupKey(c));
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

  const needsYouCount = needsYouList.length;
  const hasConversations = isSearching
    ? searchList.length > 0
    : needsYouList.length > 0 || projectGrouped.size > 0;
  const hasAnyConversations = conversations.length > 0;

  const renderRow = (conv: AgentConversation, isNeedsYou: boolean) => {
    const isSelected = conv.id === selectedId;
    const snippet = isSearching ? searchSnippets.get(conv.id) : undefined;
    const titleText = conv.title || "(untitled)";
    const isPinned = !!prefs[conv.id]?.pinned;

    return (
      <div
        key={conv.id}
        className={`group relative border-l-2 transition-colors ${
          isSelected ? "border-accent-purple bg-accent-purple/15" : "border-transparent"
        } border-b border-line-soft`}
      >
        <button
          onClick={() => onSelect(conv.id)}
          title={conv.title}
          className={`flex flex-col w-full px-3 py-2 text-left gap-0.5 transition-colors ${
            isSelected ? "" : "hover:bg-bg-hover"
          }`}
        >
          <div className="flex items-center gap-1.5">
            {isPinned && <Pin size={9} className="text-accent-amber fill-accent-amber shrink-0" />}
            <span>{isNeedsYou ? needsYouIcon() : statusIcon(conv.status)}</span>
            <span
              className={`text-ui leading-tight truncate ${
                isSelected ? "text-text-primary font-medium" : "text-text-secondary"
              }`}
            >
              {snippet ?? titleText}
            </span>
            <span className="flex-1" />
            <span className="text-meta text-text-muted shrink-0">
              {formatRelativeTime(conv.updatedAt)}
            </span>
          </div>
          <div className={`text-meta font-medium ${getAgentColor(conv.agent).text}`}>
            {agentLabel(conv.agent)}
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
          onClick={(e) => {
            e.stopPropagation();
            setPendingDelete(conv);
          }}
          className="absolute right-1 top-1.5 p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity rounded"
          title="Delete"
        >
          <Trash2 size={10} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePinned(conv.id);
          }}
          className={`absolute right-11 top-1.5 p-0.5 rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity ${
            isPinned ? "text-accent-amber" : "text-text-muted hover:text-accent-amber"
          }`}
          title={isPinned ? "Unpin" : "Pin to top"}
        >
          <Pin size={10} className={isPinned ? "fill-accent-amber" : ""} />
        </button>
      </div>
    );
  };

  return (
    <div
      ref={sidebarRef}
      tabIndex={-1}
      onKeyDown={handleSidebarKeyDown}
      className="w-[240px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden focus:outline-none"
    >
      {/* Sessions list header — matches design (label + count pill + search/plus icons) */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-line-soft">
        <span className="text-ui font-semibold text-text-primary">Sessions</span>
        {conversations.length > 0 && (
          <Badge>
            {isSearching
              ? searchStats.count
              : filter === "archived"
                ? counts.archived
                : counts.all}
          </Badge>
        )}
        {needsYouCount > 0 && <Badge tone="amber">{needsYouCount}</Badge>}
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
                className={`flex-1 text-ui py-0.5 rounded transition-colors ${
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
              className="w-full pl-6 pr-6 py-1 text-ui bg-bg-primary border border-bg-border rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/50"
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
            <div className="text-meta text-text-muted mt-1 px-0.5">
              {searchStats.count} {searchStats.count === 1 ? "result" : "results"} across {searchStats.projects}{" "}
              {searchStats.projects === 1 ? "project" : "projects"}
            </div>
          )}
        </div>
      )}

      {/* Conversations: NEEDS YOU first, then grouped by project */}
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
                  className="text-ui text-text-muted hover:text-text-secondary transition-colors"
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
            <EmptyState className="py-16" icon={<Archive size={24} />} title="No archived sessions" />
          ) : (
            <EmptyState
              className="py-16"
              icon={<Zap size={24} />}
              title="No matching sessions"
              description="Try a different filter"
            />
          )
        ) : isSearching ? (
          <div>
            <div className="px-3 py-1.5 flex items-center gap-1.5 bg-bg-tertiary border-y border-line-soft">
              <Search size={10} className="text-accent-green shrink-0" />
              <span className="text-meta font-semibold text-text-secondary truncate uppercase tracking-wide">
                Search results ({searchList.length})
              </span>
            </div>
            {searchList.map((conv) => renderRow(conv, false))}
          </div>
        ) : (
          <>
            {needsYouList.length > 0 && (
              <div>
                <div className="px-3 py-1.5 flex items-center gap-1.5 bg-accent-amber/10 border-y border-accent-amber/30">
                  <BellRing size={10} className="text-accent-amber shrink-0" />
                  <span className="text-meta font-semibold text-accent-amber truncate uppercase tracking-wide">
                    Needs you
                  </span>
                  <span className="text-meta text-accent-amber shrink-0 ml-auto">
                    {needsYouList.length}
                  </span>
                </div>
                {needsYouList.map((conv) => renderRow(conv, true))}
              </div>
            )}
            {Array.from(projectGrouped.entries()).map(([key, convs]) => {
              const sshTarget = convs[0]?.sshTarget;
              const projectPath = convs[0]?.projectPath ?? "";
              const headerIcon = sshTarget ? (
                <Server size={10} className="text-accent-green shrink-0" />
              ) : (
                <FolderOpen size={10} className="text-text-muted shrink-0" />
              );
              const customLabel = projectLabels[projectPath];
              const headerLabel = customLabel
                ? customLabel
                : sshTarget
                  ? sshTarget.name
                  : (() => {
                      const segments = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
                      return segments[segments.length - 1] ?? projectPath;
                    })();
              const canRename = !sshTarget;
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
                        className="text-meta font-semibold bg-bg-primary border border-accent-green/50 rounded px-1 py-px text-text-primary uppercase tracking-wide focus:outline-none flex-1 min-w-0"
                      />
                    ) : (
                      <span className="text-meta font-semibold text-text-secondary truncate uppercase tracking-wide">
                        {headerLabel}
                      </span>
                    )}
                    <span className="text-meta text-text-muted shrink-0 ml-auto">{convs.length}</span>
                  </div>

                  {/* Agent conversations under this project */}
                  {convs.map((conv) => renderRow(conv, false))}
                </div>
              );
            })}
          </>
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
                className="px-3 py-1.5 rounded text-ui text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteConversation(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="px-3 py-1.5 rounded text-ui font-medium bg-accent-red/15 text-accent-red hover:bg-accent-red/25 transition-colors"
              >
                Delete
              </button>
            </div>
          }
        >
          <div className="px-5 py-4">
            <p className="text-ui text-text-secondary">
              Permanently delete{" "}
              <span className="text-text-primary">“{pendingDelete.title || "(untitled)"}”</span>
              ? This closes the session and removes its history.
            </p>
            <p className="text-meta text-text-muted mt-2">This can’t be undone.</p>
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
        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-ui font-medium bg-accent-green/15 text-accent-green hover:bg-accent-green/25 border border-accent-line rounded transition-colors"
      >
        <Plus size={11} />
        New session
      </button>
    </div>
  );
}
