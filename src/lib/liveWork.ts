import { listPtySessions } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import type { AttemptStatus } from "@/types/flight";

/**
 * UX-09: closing the window tears down every PTY child, every streaming agent
 * turn, and every running flight attempt with no way back. Before honoring a
 * close request the shell asks this module what is actually alive, so the
 * confirmation can name the cost instead of asking a generic "are you sure?".
 *
 * "Live" is deliberately narrow — work that is *running right now* and would
 * be destroyed by the close, not merely open or resumable:
 *
 *   - **PTY sessions** — alive children reported by the Rust PTY manager
 *     (`list_pty_sessions`), which is the authority. Falls back to counting
 *     panes that hold a session id when the command is unavailable.
 *   - **Agent conversations** — conversations in `status: "active"`, i.e. a
 *     turn is streaming (API) or the CLI is mid-response. Idle/done/failed
 *     conversations are persisted and resume fine, so they don't count.
 *   - **Flight attempts** — attempts in a pre-terminal status
 *     (`queued` / `provisioning` / `running`). `reviewing` and the terminal
 *     statuses survive a restart.
 */
export interface LiveWorkSummary {
  /** Live PTY children (terminals, CLI agents). */
  ptySessions: number;
  /** Agent conversations mid-turn. */
  conversations: number;
  /** Flight attempts that have not reached a terminal status. */
  attempts: number;
  /** Sum of the three — zero means the window may close silently. */
  total: number;
}

const RUNNING_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "queued",
  "provisioning",
  "running",
]);

export const EMPTY_LIVE_WORK: LiveWorkSummary = {
  ptySessions: 0,
  conversations: 0,
  attempts: 0,
  total: 0,
};

/** Panes holding a session id — the frontend's best guess when the backend
 *  PTY listing is unreachable (dev browser, command error). */
function countPanesWithSessions(): number {
  let count = 0;
  for (const ws of useWorkspaceStore.getState().workspaces) {
    for (const pane of ws.panes ?? []) {
      if (pane.sessionId) count += 1;
    }
  }
  return count;
}

async function countLivePtySessions(): Promise<number> {
  try {
    const sessions = await listPtySessions();
    return sessions.filter((s) => s.alive).length;
  } catch (err) {
    console.warn("[liveWork.listPtySessions] falling back to pane count:", err);
    return countPanesWithSessions();
  }
}

function countActiveConversations(): number {
  return useAgentTaskStore.getState().conversations.filter((c) => c.status === "active").length;
}

function countRunningAttempts(): number {
  let count = 0;
  for (const flight of useFlightStore.getState().flights) {
    for (const attempt of flight.attempts ?? []) {
      if (RUNNING_ATTEMPT_STATUSES.has(attempt.status)) count += 1;
    }
  }
  return count;
}

/** Snapshot everything a window close would kill. Never throws. */
export async function collectLiveWork(): Promise<LiveWorkSummary> {
  const ptySessions = await countLivePtySessions();
  let conversations = 0;
  let attempts = 0;
  try {
    conversations = countActiveConversations();
    attempts = countRunningAttempts();
  } catch (err) {
    console.warn("[liveWork.collect] store read failed:", err);
  }
  return {
    ptySessions,
    conversations,
    attempts,
    total: ptySessions + conversations + attempts,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Human-readable lines for the confirmation body, one per non-empty kind.
 * Ordered most-destructive-first (a killed PTY loses scrollback and any
 * unsaved shell state; a cancelled turn can be re-sent).
 */
export function describeLiveWork(summary: LiveWorkSummary): string[] {
  const lines: string[] = [];
  if (summary.ptySessions > 0) {
    lines.push(`${plural(summary.ptySessions, "terminal session")} will be killed`);
  }
  if (summary.conversations > 0) {
    lines.push(`${plural(summary.conversations, "agent conversation")} mid-turn will be cut off`);
  }
  if (summary.attempts > 0) {
    lines.push(`${plural(summary.attempts, "flight attempt")} still running will be abandoned`);
  }
  return lines;
}
