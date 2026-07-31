/**
 * "Is this SSH host actually in use?" — the honesty layer behind the remote-host
 * delete confirm.
 *
 * Deleting a `ServerConfig` is not a local edit: the same record backs live
 * API-agent conversations (`AgentConversation.sshTarget`), worktree-backed
 * flight attempts (`Attempt.target.kind === "ssh"`), remote workspaces
 * (`Workspace.serverId`), and any open connection tracked in
 * `serverStore.connectionStates`. Removing it silently strands all of them —
 * the conversation keeps a dangling `sshTarget.id`, resume rebuilds no
 * `SshConfig`, and attempt relaunch can no longer resolve the host.
 *
 * Deliberately store-free: callers pass snapshots in, so this stays trivially
 * testable and carries no import weight into the Settings card graph.
 */
import type { AgentConversation } from "@/types/agent-conversation";
import type { Flight } from "@/types/flight";
import type { ServerConnectionState, ServerStatus } from "@/types/server";
import type { Workspace } from "@/types/workspace";

/** Attempt statuses that mean work is still live on the host. */
const LIVE_ATTEMPT_STATUSES = new Set(["queued", "provisioning", "running", "reviewing"]);

export interface ServerUsage {
  /** Connection state from `serverStore`, if any. */
  connection: ServerStatus | null;
  /** Non-archived conversations whose tools execute on this host. */
  conversationTitles: string[];
  /** Of those, the ones mid-turn (`status === "active"`). */
  activeConversationCount: number;
  /** Flight attempts targeting this host that have not finished. */
  liveAttemptCount: number;
  /** Workspaces bound to this host. */
  workspaceNames: string[];
}

export function summarizeServerUsage(
  serverId: string,
  input: {
    connectionStates: Record<string, ServerConnectionState>;
    conversations: AgentConversation[];
    flights: Flight[];
    workspaces: Workspace[];
  },
): ServerUsage {
  const remoteConversations = input.conversations.filter(
    (c) => c.sshTarget?.id === serverId && !c.archived,
  );

  let liveAttemptCount = 0;
  for (const flight of input.flights) {
    for (const attempt of flight.attempts ?? []) {
      if (attempt.target.kind !== "ssh") continue;
      if (attempt.target.serverId !== serverId) continue;
      if (!LIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      liveAttemptCount += 1;
    }
  }

  return {
    connection: input.connectionStates[serverId]?.status ?? null,
    conversationTitles: remoteConversations.map((c) => c.title || "(untitled)"),
    activeConversationCount: remoteConversations.filter((c) => c.status === "active").length,
    liveAttemptCount,
    workspaceNames: input.workspaces
      .filter((w) => w.serverId === serverId && w.status !== "archived")
      .map((w) => w.name),
  };
}

/** Human-readable consequence lines for `ConfirmDeleteModal.warnings`. */
export function serverUsageWarnings(usage: ServerUsage): string[] {
  const lines: string[] = [];

  if (usage.connection === "connected") {
    lines.push("Connected right now — the open SSH connection is dropped.");
  } else if (usage.connection === "connecting") {
    lines.push("A connection attempt is in progress.");
  }

  if (usage.conversationTitles.length > 0) {
    const shown = usage.conversationTitles.slice(0, 3).join(", ");
    const extra = usage.conversationTitles.length - 3;
    const active =
      usage.activeConversationCount > 0 ? ` (${usage.activeConversationCount} mid-turn)` : "";
    const one = usage.conversationTitles.length === 1;
    lines.push(
      `${plural(usage.conversationTitles.length, "conversation")} ${
        one ? "runs" : "run"
      } on this host${active}: ${shown}${extra > 0 ? `, +${extra} more` : ""}. ${
        one ? "It loses its" : "They lose their"
      } remote target.`,
    );
  }

  if (usage.liveAttemptCount > 0) {
    lines.push(
      `${plural(usage.liveAttemptCount, "flight attempt")} still running on this host. Their worktrees stay on the remote machine.`,
    );
  }

  if (usage.workspaceNames.length > 0) {
    const shown = usage.workspaceNames.slice(0, 3).join(", ");
    const extra = usage.workspaceNames.length - 3;
    lines.push(
      `${plural(usage.workspaceNames.length, "workspace")} bound to it: ${shown}${
        extra > 0 ? `, +${extra} more` : ""
      }. New sessions there will fail to launch.`,
    );
  }

  return lines;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
