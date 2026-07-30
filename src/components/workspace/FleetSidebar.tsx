/**
 * Tile program (P4-S2) — FleetSidebar: the fleet list.
 *
 * Replaces `WorkspaceSidebar` in the Workspace shell. Built from the original
 * machinery (needs-you pinned pseudo-group, All/Active/Done/Archived filter
 * chips, /-search with message scan, pins, archive, relative time, project
 * groups + rename via the shared `agentSidebarPrefsStore`). Under the WA1
 * split, its visible rows are Workspaces only; unplaced conversations live in
 * AgentSidebar. Existing placed conversation panes still roll up into their
 * Workspace rows. Status remains the single truth from `sessionStatus`.
 *
 * The virtual-row handler remains as compatibility scaffolding for callers that
 * explicitly opt into that projection, but this component passes
 * `includeVirtualConversations: false`.
 *
 * Subscriptions are per-slice (via the `sessionStatus` hooks and narrow store
 * selectors) so a streaming frame never forces a full-list re-render.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Server,
  FolderOpen,
  BellRing,
  Archive,
  ArchiveRestore,
  Search,
  X,
  Plus,
  Pin,
  Trash2,
  GitBranch,
} from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import {
  archiveWorkspaceWithFanout,
  openConversationInAgents,
} from "@/stores/sessionGlue";
import { useToast } from "@/components/ui/Toast";
import { useConversationAttention, useWorkspaceStatuses, attentionDot } from "@/lib/sessionStatus";
import { flightAttemptSessionIds } from "@/lib/sessionIndex";
import { buildFleetProjection, basenameOf, type FleetFilter, type FleetRow } from "@/lib/fleetRows";
import { useLayoutStore } from "@/stores/layoutStore";
import { Modal } from "@/components/ui/Modal";
import { Tooltip } from "@/components/ui/Tooltip";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { killPty } from "@/lib/tauri";

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

interface PendingDelete {
  row: FleetRow;
}

export function FleetSidebar() {
  // Per-slice store selectors — no full-store subscription.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const restoreWorkspace = useWorkspaceStore((s) => s.restoreWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const requestPaneFocus = useWorkspaceStore((s) => s.requestPaneFocus);

  const conversations = useAgentTaskStore((s) => s.conversations ?? []);
  const deleteConversation = useAgentTaskStore((s) => s.deleteConversation);
  const archiveConversation = useAgentTaskStore((s) => s.archiveConversation);
  const unarchiveConversation = useAgentTaskStore((s) => s.unarchiveConversation);

  const flights = useFlightStore((s) => s.flights);

  const prefs = useAgentSidebarPrefsStore((s) => s.prefs);
  const togglePinned = useAgentSidebarPrefsStore((s) => s.togglePinned);
  const projectLabels = useAgentSidebarPrefsStore((s) => s.projectLabels);
  const setProjectLabel = useAgentSidebarPrefsStore((s) => s.setProjectLabel);

  // The SINGLE status truth (shared subscriptions with the tab-strip dot).
  const conversationAttention = useConversationAttention();
  const workspaceStatuses = useWorkspaceStatuses();

  const toast = useToast();

  const [filter, setFilter] = useState<FleetFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // New session = the same ruled flow as Ctrl+N: a fresh workspace whose
  // zero-state hosts the CLI-only AddSessionPicker.
  const handleNewSession = () => {
    const projectPath = useLayoutStore.getState().projectPath ?? "";
    useWorkspaceStore.getState().createWorkspace("New Session", [], projectPath);
  };

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);

  const trimmedQuery = searchQuery.trim();
  // Defer the expensive full-message scan so keystrokes never block the input.
  const deferredQuery = useDeferredValue(trimmedQuery);
  const isSearching = deferredQuery.length > 0;

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  const attemptSessionIds = useMemo(() => flightAttemptSessionIds(flights), [flights]);

  const projection = useMemo(
    () =>
      buildFleetProjection({
        workspaces,
        conversations,
        conversationAttention,
        workspaceStatuses,
        attemptSessionIds,
        prefs,
        filter,
        query: isSearching ? deferredQuery : "",
        // WA1: unplaced conversations live in the first-class Agents surface.
        // Existing placed conversation panes still contribute to their
        // Workspace row for compatibility.
        includeVirtualConversations: false,
      }),
    [
      workspaces,
      conversations,
      conversationAttention,
      workspaceStatuses,
      attemptSessionIds,
      prefs,
      filter,
      isSearching,
      deferredQuery,
    ],
  );

  const { needsYou, groups, searchRows, snippets, counts } = projection;
  const needsYouCount = needsYou.length;
  const totalCount = filter === "archived" ? counts.archived : counts.all;
  const hasAnyRows = workspaces.length > 0;
  const hasVisibleRows = isSearching
    ? searchRows.length > 0
    : needsYou.length > 0 || groups.length > 0;

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

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

  // ── Open / needs-you navigation ──
  const handleOpen = (row: FleetRow) => {
    if (row.kind === "workspace") {
      if (row.attention === "needs_you" && row.needsYouPaneId) {
        requestPaneFocus(row.workspaceId, row.needsYouPaneId);
      } else {
        setActiveWorkspace(row.workspaceId);
      }
      return;
    }
    // Defensive fallback: Workspace no longer projects virtual rows, but a
    // stale render must still open the durable conversation in Agents rather
    // than silently materializing a wrapper Workspace.
    openConversationInAgents(row.conversationId);
  };

  const handleArchiveToggle = (row: FleetRow) => {
    if (row.kind === "workspace") {
      if (row.archived) {
        restoreWorkspace(row.workspaceId);
        return;
      }
      // P4-S3 ruled fan-out: kill member PTYs (on archive only), apply the
      // worktree cleanup policy, archive member conversations (transcripts
      // kept), archive the workspace. Explicit archive of unlanded work raises
      // a non-blocking toast with a "Review worktree" action (notification
      // layer as a consumer — no modal, no second codepath).
      void archiveWorkspaceWithFanout(row.workspaceId)
        .then((result) => {
          if (!result || result.auto) return;
          const kept = result.keptWorktreeConversationIds;
          if (kept.length === 0) return;
          toast.show(
            kept.length === 1
              ? "Archived with an unlanded worktree kept for later."
              : `Archived with ${kept.length} unlanded worktrees kept for later.`,
            {
              duration: 8000,
              action: {
                label: "Review worktree",
                // The agent-owned Git ending is reachable from Agents. Do not
                // create a compatibility wrapper from a notification action.
                onClick: () => openConversationInAgents(kept[0]),
              },
            },
          );
        })
        .catch(() => {
          // Fan-out swallows its own IO failures; guard the outer promise too so
          // a rejection never surfaces as an unhandled rejection.
        });
    } else if (row.archived) {
      unarchiveConversation(row.conversationId);
    } else {
      archiveConversation(row.conversationId);
    }
  };

  const confirmDelete = async (row: FleetRow) => {
    if (row.kind === "workspace") {
      const ws = workspaces.find((w) => w.id === row.workspaceId);
      if (ws) {
        // Kill any running PTY sessions before deleting — best-effort.
        await Promise.all(
          ws.panes.filter((p) => p.sessionId).map((p) => killPty(p.sessionId!).catch(() => {})),
        );
      }
      deleteWorkspace(row.workspaceId);
    } else {
      deleteConversation(row.conversationId);
    }
  };

  const isRowSelected = (row: FleetRow): boolean =>
    row.kind === "workspace" && row.workspaceId === activeWorkspaceId;

  // ── Row renderer ──
  const renderRow = (row: FleetRow) => {
    const selected = isRowSelected(row);
    const isPinned = !!prefs[row.id]?.pinned;
    const dot = attentionDot(row.attention);
    const snippet = isSearching ? snippets.get(row.id) : undefined;
    const titleText = row.title || "(untitled)";

    return (
      <div
        key={row.id}
        className={`group relative border-l-2 transition-colors ${
          selected ? "bg-accent-purple/15 border-accent-purple" : "border-transparent"
        } border-b border-line-soft`}
      >
        <button
          onClick={() => handleOpen(row)}
          title={row.title}
          className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
            selected ? "" : "hover:bg-bg-hover"
          }`}
        >
          <div className="flex items-center gap-1.5">
            {isPinned && <Pin size={9} className="shrink-0 fill-accent-amber text-accent-amber" />}
            {row.attention === "needs_you" ? (
              <BellRing size={10} className="shrink-0 text-accent-amber" />
            ) : (
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${dot.className} ${
                  dot.pulse ? "animate-pulse" : ""
                }`}
              />
            )}
            <span
              className={`truncate text-ui leading-tight ${
                selected ? "font-medium text-text-primary" : "text-text-secondary"
              }`}
            >
              {snippet ?? titleText}
            </span>
            <span className="flex-1" />
            {row.worktreePending && (
              <Tooltip content="Worktree pending — unlanded work kept">
                <span className="flex shrink-0 items-center gap-0.5 text-accent-amber">
                  <GitBranch size={9} />
                </span>
              </Tooltip>
            )}
            <span className="shrink-0 text-meta text-text-muted">
              {formatRelativeTime(row.updatedAt)}
            </span>
          </div>
          {/* Line 2 — single agent label (single-tile) or aggregated chips. */}
          {row.singleTile ? (
            row.chips[0] && (
              <div className={`text-meta font-medium ${row.chips[0].colorClass}`}>
                {row.chips[0].label}
              </div>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {row.chips.map((chip, i) => (
                <span key={chip.label} className="flex items-center gap-1">
                  {i > 0 && <span className="text-meta text-text-faint">·</span>}
                  <span
                    className={`text-meta font-medium ${chip.colorClass} flex items-center gap-0.5`}
                  >
                    {chip.needsYou && (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-amber" />
                    )}
                    {chip.label}
                    {chip.count > 1 && ` ×${chip.count}`}
                  </span>
                </span>
              ))}
            </div>
          )}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleArchiveToggle(row);
          }}
          className="absolute right-6 top-1.5 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-accent-green focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
          title={row.archived ? "Unarchive" : "Archive"}
        >
          {row.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPendingDelete({ row });
          }}
          className="absolute right-1 top-1.5 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-accent-red focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
          title="Delete"
        >
          <Trash2 size={10} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePinned(row.id);
          }}
          className={`absolute right-11 top-1.5 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 ${
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
      className="flex w-[240px] flex-shrink-0 flex-col overflow-hidden border-r border-bg-border bg-bg-secondary focus:outline-none"
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-2">
        <span className="text-ui font-semibold text-text-primary">Fleet</span>
        {hasAnyRows && <Badge>{totalCount}</Badge>}
        {needsYouCount > 0 && <Badge tone="amber">{needsYouCount}</Badge>}
        <span className="flex-1" />
        <Tooltip content="Search sessions (/)">
          <button
            aria-label="Search sessions"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            className={`rounded p-1 transition-colors ${
              searchOpen
                ? "bg-accent-green/10 text-accent-green"
                : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            }`}
          >
            <Search size={11} />
          </button>
        </Tooltip>
        <Tooltip content="New session">
          <button
            onClick={handleNewSession}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-green"
          >
            <Plus size={11} />
          </button>
        </Tooltip>
      </div>

      {/* Status filter (hidden when search is open) */}
      {hasAnyRows && !searchOpen && (
        <div className="flex items-center gap-0.5 px-3 pb-1.5 pt-1.5">
          {(["all", "active", "done", "archived"] as FleetFilter[]).map((f) => {
            const label =
              f === "all" ? "All" : f === "active" ? "Active" : f === "done" ? "Done" : "Archived";
            const count = counts[f];
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex-1 rounded py-0.5 text-ui transition-colors ${
                  active
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

      {/* Search input */}
      {searchOpen && (
        <div className="px-3 pb-1.5 pt-1.5">
          <div className="relative">
            <Search
              size={10}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
            />
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
              className="focus:border-accent-green/50 w-full rounded border border-bg-border bg-bg-primary py-1 pl-6 pr-6 text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-muted hover:text-text-secondary"
                title="Clear"
              >
                <X size={10} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Rows */}
      <div className="flex-1 overflow-y-auto px-1">
        {!hasVisibleRows ? (
          isSearching ? (
            <EmptyState
              className="py-16"
              icon={<Search size={24} />}
              title={`No matches for “${trimmedQuery}”`}
              action={
                <button
                  onClick={closeSearch}
                  className="text-ui text-text-muted transition-colors hover:text-text-secondary"
                >
                  Clear search
                </button>
              }
            />
          ) : !hasAnyRows ? (
            <EmptyState
              className="py-16"
              icon={<FolderOpen size={24} />}
              title="No sessions yet"
              description="Start one with New session"
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
              icon={<FolderOpen size={24} />}
              title="No matching sessions"
              description="Try a different filter"
            />
          )
        ) : isSearching ? (
          <div>
            <div className="flex items-center gap-1.5 border-y border-line-soft bg-bg-tertiary px-3 py-1.5">
              <Search size={10} className="shrink-0 text-accent-green" />
              <span className="truncate text-meta font-semibold uppercase tracking-wide text-text-secondary">
                Search results ({searchRows.length})
              </span>
            </div>
            {searchRows.map((row) => renderRow(row))}
          </div>
        ) : (
          <>
            {needsYou.length > 0 && (
              <div>
                <div className="bg-accent-amber/10 border-accent-amber/30 flex items-center gap-1.5 border-y px-3 py-1.5">
                  <BellRing size={10} className="shrink-0 text-accent-amber" />
                  <span className="truncate text-meta font-semibold uppercase tracking-wide text-accent-amber">
                    Needs you
                  </span>
                  <span className="ml-auto shrink-0 text-meta text-accent-amber">
                    {needsYou.length}
                  </span>
                </div>
                {needsYou.map((row) => renderRow(row))}
              </div>
            )}
            {groups.map((group) => {
              const customLabel = projectLabels[group.projectPath];
              const headerLabel = customLabel
                ? customLabel
                : group.isSsh
                  ? (group.sshName ?? basenameOf(group.projectPath))
                  : basenameOf(group.projectPath);
              const canRename = !group.isSsh;
              const isRenaming = canRename && renamingPath === group.projectPath;

              const commitRename = () => {
                setProjectLabel(group.projectPath, renameValue);
                setRenamingPath(null);
                setRenameValue("");
              };

              return (
                <div key={group.key}>
                  <div
                    className="flex items-center gap-1.5 border-y border-line-soft bg-bg-tertiary px-3 py-1.5"
                    title={
                      canRename ? `${group.projectPath} — right-click to rename` : group.projectPath
                    }
                    onContextMenu={(e) => {
                      if (!canRename) return;
                      e.preventDefault();
                      setRenamingPath(group.projectPath);
                      setRenameValue(projectLabels[group.projectPath] ?? headerLabel);
                    }}
                  >
                    {group.isSsh ? (
                      <Server size={10} className="shrink-0 text-accent-green" />
                    ) : (
                      <FolderOpen size={10} className="shrink-0 text-text-muted" />
                    )}
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
                        className="border-accent-green/50 min-w-0 flex-1 rounded border bg-bg-primary px-1 py-px text-meta font-semibold uppercase tracking-wide text-text-primary focus:outline-none"
                      />
                    ) : (
                      <span className="truncate text-meta font-semibold uppercase tracking-wide text-text-secondary">
                        {headerLabel}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-meta text-text-muted">
                      {group.rows.length}
                    </span>
                  </div>
                  {group.rows.map((row) => renderRow(row))}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Footer CTA */}
      <div className="flex items-center gap-1.5 border-t border-line-strong bg-bg-tertiary px-2.5 py-2">
        <button
          onClick={handleNewSession}
          className="bg-accent-green/15 hover:bg-accent-green/25 flex flex-1 items-center justify-center gap-1.5 rounded border border-accent-line px-2 py-1.5 text-ui font-medium text-accent-green transition-colors"
        >
          <Plus size={11} />
          New session
        </button>
      </div>

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
                className="rounded px-3 py-1.5 text-ui text-text-secondary transition-colors hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  void confirmDelete(pendingDelete.row);
                  setPendingDelete(null);
                }}
                className="bg-accent-red/15 hover:bg-accent-red/25 rounded px-3 py-1.5 text-ui font-medium text-accent-red transition-colors"
              >
                Delete
              </button>
            </div>
          }
        >
          <div className="px-5 py-4">
            <p className="text-ui text-text-secondary">
              {pendingDelete.row.kind === "workspace" ? "Delete workspace " : "Permanently delete "}
              <span className="text-text-primary">“{pendingDelete.row.title || "(untitled)"}”</span>
              {pendingDelete.row.kind === "workspace"
                ? "? Member conversations are detached, not destroyed."
                : "? This closes the session and removes its history."}
            </p>
            <p className="mt-2 text-meta text-text-muted">This can’t be undone.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
