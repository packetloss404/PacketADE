import { useMemo, useState } from "react";
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
} from "lucide-react";
import { useAgentTaskStore, repoDisplayName } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { useGitHubStore } from "@/stores/githubStore";
import { API_PROVIDERS } from "@/lib/api-models";

type StatusFilter = "all" | "active" | "done" | "archived";

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
  const repos = useGitHubStore((s) => s.repos);

  const [filter, setFilter] = useState<StatusFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "archived") {
      return conversations.filter((c) => c.archived);
    }
    const visible = conversations.filter((c) => !c.archived);
    if (filter === "all") return visible;
    if (filter === "active") {
      return visible.filter((c) => c.status === "active" || c.status === "idle");
    }
    return visible.filter((c) => c.status === "done" || c.status === "failed");
  }, [conversations, filter]);

  const convsByRepo = useMemo(() => {
    const map = new Map<string, AgentConversation[]>();
    for (const conv of filtered) {
      const key = conv.sshTarget
        ? `ssh:${conv.sshTarget.id}:${conv.projectPath}`
        : `local:${conv.projectPath}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(conv);
    }
    for (const [, list] of map) {
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [filtered]);

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

  const hasConversations = convsByRepo.size > 0;

  return (
    <div className="w-[240px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden">
      {/* New Agent button */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewAgent}
          className="flex items-center gap-2 w-full px-3 py-2 text-[11px] font-medium text-accent-green hover:bg-accent-green/10 rounded transition-colors"
        >
          <Zap size={12} />
          New Agent
          <span className="ml-auto text-[9px] text-text-muted">Ctrl+N</span>
        </button>
      </div>

      <div className="border-b border-bg-border mx-3 mb-1" />

      {/* Status filter */}
      {conversations.length > 0 && (
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

      {/* Conversations grouped by project */}
      <div className="flex-1 overflow-y-auto px-1">
        {!hasConversations ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <Zap size={16} className="mb-2 opacity-30" />
            <p className="text-[10px]">No agents yet</p>
            <p className="text-[9px] mt-1 opacity-70">Start one with New Agent</p>
          </div>
        ) : (
          Array.from(convsByRepo.entries()).map(([key, convs]) => {
            const sshTarget = convs[0]?.sshTarget;
            const projectPath = convs[0]?.projectPath ?? "";
            return (
            <div key={key} className="mb-2">
              {/* Project header */}
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                {sshTarget ? (
                  <Server size={10} className="text-accent-green shrink-0" />
                ) : (
                  <FolderOpen size={10} className="text-text-muted shrink-0" />
                )}
                <span className="text-[10px] font-medium text-text-muted truncate">
                  {sshTarget ? sshTarget.name : repoDisplayName(projectPath, repos)}
                </span>
                <span className="text-[9px] text-text-muted ml-auto shrink-0">{convs.length}</span>
              </div>

              {/* Agent conversations under this project */}
              {convs.map((conv) => {
                const isSelected = conv.id === selectedId;
                const lastMessage = conv.messages?.[conv.messages.length - 1];
                const preview = lastMessage
                  ? lastMessage.content.slice(0, 50) + (lastMessage.content.length > 50 ? "..." : "")
                  : null;
                const modelShort = conv.model?.split("-").slice(0, 2).join(" ") ?? "";

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
                        {modelShort && (
                          <span className="text-[9px] text-text-muted">{modelShort}</span>
                        )}
                        {preview && (
                          <p className="text-[9px] text-text-muted truncate mt-0.5 opacity-70">
                            {preview}
                          </p>
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
    </div>
  );
}
