import { useDeferredValue, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BellRing,
  CheckCircle2,
  Circle,
  FolderOpen,
  Pin,
  Plus,
  Search,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { API_PROVIDERS } from "@/lib/api-models";
import { getAgentColor, getStatusColor } from "@/lib/agentColors";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import type { AgentConversation } from "@/types/agent-conversation";

type StatusFilter = "all" | "active" | "done" | "archived";

interface AgentSidebarProps {
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onNewAgent: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function providerLabel(agent: string): string {
  const provider = API_PROVIDERS.find((candidate) => candidate.agentCli === agent);
  if (provider) {
    return provider.name.replace(" (API)", "").replace(" (Local)", "");
  }
  return agent;
}

function projectKey(conversation: AgentConversation): string {
  return conversation.sshTarget
    ? `ssh:${conversation.sshTarget.id}:${conversation.projectPath}`
    : `local:${conversation.projectPath}`;
}

function projectLabel(conversation: AgentConversation, labels: Record<string, string>): string {
  if (conversation.sshTarget) return conversation.sshTarget.name;
  const custom = labels[conversation.projectPath];
  if (custom) return custom;
  const parts = conversation.projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? conversation.projectPath;
}

function matchesSearch(conversation: AgentConversation, query: string): boolean {
  const normalized = query.toLowerCase();
  if (conversation.title?.toLowerCase().includes(normalized)) return true;
  if (conversation.projectPath.toLowerCase().includes(normalized)) return true;
  return conversation.messages.some((message) =>
    message.content?.toLowerCase().includes(normalized),
  );
}

function statusIcon(status: AgentConversation["status"]) {
  if (status === "active") {
    return <Spinner size={10} className={`${getStatusColor("active")} shrink-0`} />;
  }
  if (status === "done") {
    return <CheckCircle2 size={10} className={`${getStatusColor("done")} shrink-0`} />;
  }
  if (status === "failed") {
    return <XCircle size={10} className={`${getStatusColor("failed")} shrink-0`} />;
  }
  return <Circle size={10} className={`${getStatusColor("idle")} shrink-0 fill-accent-green`} />;
}

function sortConversations(
  conversations: AgentConversation[],
  prefs: Record<string, { pinned?: boolean }>,
): AgentConversation[] {
  return [...conversations].sort((left, right) => {
    const leftPinned = prefs[left.id]?.pinned === true;
    const rightPinned = prefs[right.id]?.pinned === true;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
}

export function AgentSidebar({ selectedId, onSelect, onNewAgent }: AgentSidebarProps) {
  const conversations = useAgentTaskStore((state) => state.conversations);
  const archiveConversation = useAgentTaskStore((state) => state.archiveConversation);
  const unarchiveConversation = useAgentTaskStore((state) => state.unarchiveConversation);
  const deleteConversation = useAgentTaskStore((state) => state.deleteConversation);
  const pendingPermissions = useAgentApprovalStore((state) => state.permissions);
  const pendingEdits = useAgentApprovalStore((state) => state.edits);
  const prefs = useAgentSidebarPrefsStore((state) => state.prefs);
  const togglePinned = useAgentSidebarPrefsStore((state) => state.togglePinned);
  const projectLabels = useAgentSidebarPrefsStore((state) => state.projectLabels);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AgentConversation | null>(null);
  const deferredQuery = useDeferredValue(query.trim());

  const needsYouIds = useMemo(() => {
    const result = new Set<string>();
    for (const conversation of conversations) {
      if (
        (pendingPermissions.get(conversation.id)?.length ?? 0) > 0 ||
        (pendingEdits.get(conversation.id)?.length ?? 0) > 0
      ) {
        result.add(conversation.id);
      }
    }
    return result;
  }, [conversations, pendingPermissions, pendingEdits]);

  const counts = useMemo(() => {
    const result = { all: 0, active: 0, done: 0, archived: 0 };
    for (const conversation of conversations) {
      if (conversation.archived) {
        result.archived += 1;
      } else {
        result.all += 1;
        if (conversation.status === "active" || conversation.status === "idle") {
          result.active += 1;
        } else {
          result.done += 1;
        }
      }
    }
    return result;
  }, [conversations]);

  const filtered = useMemo(() => {
    let result = conversations.filter((conversation) =>
      filter === "archived" ? conversation.archived : !conversation.archived,
    );
    if (filter === "active") {
      result = result.filter(
        (conversation) => conversation.status === "active" || conversation.status === "idle",
      );
    } else if (filter === "done") {
      result = result.filter(
        (conversation) => conversation.status === "done" || conversation.status === "failed",
      );
    }
    if (deferredQuery) {
      result = result.filter((conversation) => matchesSearch(conversation, deferredQuery));
    }
    return sortConversations(result, prefs);
  }, [conversations, deferredQuery, filter, prefs]);

  const needsYou = useMemo(
    () =>
      filter === "archived" || deferredQuery
        ? []
        : filtered.filter((conversation) => needsYouIds.has(conversation.id)),
    [deferredQuery, filter, filtered, needsYouIds],
  );

  const groups = useMemo(() => {
    const map = new Map<string, AgentConversation[]>();
    for (const conversation of filtered) {
      if (needsYouIds.has(conversation.id) && needsYou.length > 0) continue;
      const key = projectKey(conversation);
      const group = map.get(key) ?? [];
      group.push(conversation);
      map.set(key, group);
    }
    return map;
  }, [filtered, needsYou.length, needsYouIds]);

  const renderConversation = (conversation: AgentConversation, attention: boolean) => {
    const selected = conversation.id === selectedId;
    const pinned = prefs[conversation.id]?.pinned === true;
    return (
      <div
        key={conversation.id}
        className={`group relative border-b border-l-2 border-line-soft ${
          selected ? "bg-accent-green/10 border-l-accent-green" : "border-l-transparent"
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          className="flex w-full flex-col gap-0.5 px-3 py-2 pr-[70px] text-left transition-colors hover:bg-bg-hover"
          aria-current={selected ? "page" : undefined}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {attention ? (
              <BellRing size={10} className="shrink-0 text-accent-amber" />
            ) : (
              statusIcon(conversation.status)
            )}
            <span className="truncate text-ui font-medium text-text-primary">
              {conversation.title || "(untitled)"}
            </span>
          </span>
          <span className={`truncate text-meta ${getAgentColor(conversation.agent).text}`}>
            {providerLabel(conversation.agent)}
          </span>
          <span className="text-meta text-text-muted">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
        </button>
        <div className="absolute right-1 top-1 flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => togglePinned(conversation.id)}
            className={`rounded p-1 hover:bg-bg-tertiary ${
              pinned ? "text-accent-amber" : "text-text-muted"
            }`}
            title={pinned ? "Unpin conversation" : "Pin conversation"}
          >
            <Pin size={10} className={pinned ? "fill-accent-amber" : ""} />
          </button>
          <button
            type="button"
            onClick={() =>
              conversation.archived
                ? unarchiveConversation(conversation.id)
                : archiveConversation(conversation.id)
            }
            className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-accent-green"
            title={conversation.archived ? "Unarchive conversation" : "Archive conversation"}
          >
            {conversation.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(conversation)}
            className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-accent-red"
            title="Delete conversation"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside className="flex w-[252px] shrink-0 flex-col overflow-hidden border-r border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-2">
        <span className="text-ui font-semibold text-text-primary">Agents</span>
        <Badge>{counts.all}</Badge>
        {needsYouIds.size > 0 && <Badge tone="amber">{needsYouIds.size}</Badge>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onNewAgent}
          className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-green"
          title="New agent"
        >
          <Plus size={12} />
        </button>
      </div>

      <div className="border-b border-line-soft px-2 py-2">
        <label className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1">
          <Search size={11} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations…"
            className="min-w-0 flex-1 bg-transparent text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </label>
        <div className="mt-1.5 flex items-center gap-0.5">
          {(["all", "active", "done", "archived"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`flex-1 rounded py-0.5 text-meta transition-colors ${
                filter === value
                  ? "bg-accent-green/20 text-accent-green"
                  : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              {value === "all"
                ? "All"
                : value === "active"
                  ? "Active"
                  : value === "done"
                    ? "Done"
                    : "Archive"}
              <span className="ml-0.5 opacity-60">({counts[value]})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState
            className="py-16"
            icon={deferredQuery ? <Search size={22} /> : <BellRing size={22} />}
            title={deferredQuery ? "No matching conversations" : "No conversations yet"}
            description={
              deferredQuery
                ? "Try a different title, project, or message."
                : "Start a GUI agent from this surface."
            }
          />
        ) : (
          <>
            {needsYou.length > 0 && (
              <section>
                <div className="border-accent-amber/30 bg-accent-amber/10 flex items-center gap-1.5 border-y px-3 py-1.5">
                  <BellRing size={10} className="text-accent-amber" />
                  <span className="text-meta font-semibold uppercase tracking-wide text-accent-amber">
                    Needs you
                  </span>
                  <span className="ml-auto text-meta text-accent-amber">{needsYou.length}</span>
                </div>
                {needsYou.map((conversation) => renderConversation(conversation, true))}
              </section>
            )}
            {Array.from(groups.entries()).map(([key, conversationsInProject]) => {
              const example = conversationsInProject[0];
              if (!example) return null;
              return (
                <section key={key}>
                  <div
                    className="flex items-center gap-1.5 border-y border-line-soft bg-bg-tertiary px-3 py-1.5"
                    title={example.projectPath}
                  >
                    {example.sshTarget ? (
                      <Server size={10} className="shrink-0 text-accent-green" />
                    ) : (
                      <FolderOpen size={10} className="shrink-0 text-text-muted" />
                    )}
                    <span className="truncate text-meta font-semibold uppercase tracking-wide text-text-secondary">
                      {projectLabel(example, projectLabels)}
                    </span>
                    <span className="ml-auto text-meta text-text-muted">
                      {conversationsInProject.length}
                    </span>
                  </div>
                  {conversationsInProject.map((conversation) =>
                    renderConversation(conversation, false),
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>

      <div className="border-t border-line-strong bg-bg-tertiary p-2">
        <button
          type="button"
          onClick={onNewAgent}
          className="bg-accent-green/15 hover:bg-accent-green/25 flex w-full items-center justify-center gap-1.5 rounded border border-accent-line px-2 py-1.5 text-ui font-medium text-accent-green transition-colors"
        >
          <Plus size={11} />
          New agent
        </button>
      </div>

      {pendingDelete && (
        <Modal
          title="Delete conversation?"
          width="w-[400px]"
          closeOnEscape
          onClose={() => setPendingDelete(null)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded px-3 py-1.5 text-ui text-text-secondary transition-colors hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteConversation(pendingDelete.id);
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
              Permanently delete{" "}
              <span className="text-text-primary">“{pendingDelete.title || "(untitled)"}”</span>?
              This closes the session and removes its history.
            </p>
            <p className="mt-2 text-meta text-text-muted">This cannot be undone.</p>
          </div>
        </Modal>
      )}
    </aside>
  );
}
