import { create } from "zustand";
import { loadFromStorage, saveToStorage, generateId as genId } from "@/lib/storage";
import { MONITOR_WINDOW_QUERY_KEY } from "@/lib/brand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createIssueWorktree, saveIssuesSlice } from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { getPreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";

/**
 * Issue lifecycle states.
 *
 * v0.8.5 extended this union additively with `backlog`, `up_next`, and
 * `in_review`. Existing data was authored against the original
 * `todo | in_progress | qa | done | blocked | needs_human` set, so any record
 * that pre-dates the extension keeps its stored status and falls into a
 * sensible Kanban column via the `IssueBoard` column-mapping table.
 */
export type IssueStatus =
  | "backlog"
  | "up_next"
  | "todo"
  | "in_progress"
  | "in_review"
  | "qa"
  | "done"
  | "blocked"
  | "needs_human";
export type IssuePriority = "low" | "medium" | "high" | "critical";

export interface AcceptanceCriterion {
  id: string;
  text: string;
  checked: boolean;
}

/**
 * v0.8.5: inline comment threads on local issues. Persisted on the Issue
 * itself rather than as a parallel table — comment volume per issue is
 * expected to stay small (single-user notes, agent breadcrumbs).
 */
export interface IssueComment {
  id: string;
  author: "user" | "system" | "agent";
  body: string;
  createdAt: number;
}

export interface Issue {
  id: string;
  ticketId: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string[];
  epic: string | null;
  flightId: string | null;
  acceptanceCriteria: AcceptanceCriterion[];
  blockedBy: string[]; // issue IDs
  blocks: string[]; // issue IDs
  /** v0.8.5: inline comments — optional for back-compat with stored issues. */
  comments?: IssueComment[];
  /** v0.8.5: free-form assignee (username/email/"me"). */
  assignee?: string;
  createdAt: number;
  updatedAt: number;
  // v0.8.5 — Send-to-Workspace handoff bookkeeping. These fields are
  // additive: an Issue without `workspaceId` has never been sent. When
  // `sessionId` is set, the IssueCard renders a "→ Workspace" pill that
  // jumps the user back to the linked pane.
  /** Workspace this Issue was handed off to (if any). */
  workspaceId?: string;
  /** Specific pane/session id within the linked workspace. */
  sessionId?: string;
  /** Millis timestamp of the most recent send-to-workspace. */
  sentToWorkspaceAt?: number;
  // v0.8.5 — Spec-import metadata. Additive: hand-authored issues leave
  // both undefined and the IssueCard simply doesn't render the badge.
  /**
   * UUID minted at submit time inside `SpecImportModal` and stamped on
   * every Issue created from a single spec-import batch. Lets the UI
   * surface a "from spec import on {date}" badge that groups all sibling
   * issues from the same import.
   */
  specImportBatchId?: string;
}

const STATUS_COLUMNS: { key: IssueStatus; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "up_next", label: "Up Next" },
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "in_review", label: "In Review" },
  { key: "qa", label: "QA" },
  { key: "done", label: "Done" },
  { key: "blocked", label: "Blocked" },
  { key: "needs_human", label: "Needs Human" },
];

interface IssueStore {
  issues: Issue[];
  nextTicketNum: number;
  ticketPrefix: string;
  epics: string[];
  labels: string[];

  addIssue: (
    issue: Omit<Issue, "id" | "ticketId" | "createdAt" | "updatedAt" | "flightId"> & {
      flightId?: string | null;
    },
  ) => Issue;
  updateIssue: (id: string, updates: Partial<Issue>) => void;
  deleteIssue: (id: string) => void;
  moveIssue: (id: string, status: IssueStatus) => void;
  assignToFlight: (issueId: string, flightId: string | null) => void;
  addEpic: (epic: string) => void;
  addLabel: (label: string) => void;
  setTicketPrefix: (prefix: string) => void;
  hydrateFromBackend: (issues?: Issue[]) => void;
  getIssuesByStatus: (status: IssueStatus) => Issue[];
  getColumns: () => typeof STATUS_COLUMNS;

  // Acceptance criteria
  toggleCriterion: (issueId: string, criterionId: string) => void;
  addCriterion: (issueId: string, text: string) => void;
  removeCriterion: (issueId: string, criterionId: string) => void;

  // Dependencies
  addBlockedBy: (issueId: string, blockerIssueId: string) => void;
  removeBlockedBy: (issueId: string, blockerIssueId: string) => void;
  addBlocks: (issueId: string, blockedIssueId: string) => void;
  removeBlocks: (issueId: string, blockedIssueId: string) => void;

  // Comments (v0.8.5)
  addIssueComment: (
    issueId: string,
    body: string,
    author?: IssueComment["author"],
  ) => IssueComment | null;
  deleteIssueComment: (issueId: string, commentId: string) => void;

  /**
   * v0.8.5 — Send-to-Workspace handoff.
   *
   * Orchestrator action: spins up (or reuses) a workspace dedicated to this
   * Issue, seeds the linked `claude-code` pane with the Issue's title +
   * body + acceptance criteria as the first prompt, flips the Issue's
   * status to `in_progress`, and switches the app view to "workspace".
   *
   * Returns the workspace + pane ids on success, or `null` if the
   * operation could not be initiated (no project path, no issue).
   *
   * NOTE: this action lives in the issue store rather than a component so
   * it can be invoked from anywhere (slash commands, hotkeys, plan
   * promotion, etc.) without re-implementing the workspace plumbing.
   */
  sendIssueToWorkspace: (
    issueId: string,
  ) => Promise<{ workspaceId: string; sessionId: string } | null>;
}

const generateIssueId = () => genId("issue");
const generateCriterionId = () => genId("ac", 6);
const generateCommentId = () => genId("ic", 6);

// Migrate old issues that lack new fields
function migrateIssue(issue: Issue): Issue {
  return {
    ...issue,
    // Back-compat: pre-rename persisted issues stored the flight link under the
    // legacy `missionId` key. Read it as a fallback so old data still migrates.
    flightId: (issue as Issue & { missionId?: string | null }).missionId ?? issue.flightId ?? null,
    acceptanceCriteria: issue.acceptanceCriteria || [],
    blockedBy: issue.blockedBy || [],
    blocks: issue.blocks || [],
    // v0.8.5: comments is optional; leave undefined for unwritten issues to
    // keep persisted state small, but normalize to an array when present.
    comments: Array.isArray(issue.comments) ? issue.comments : undefined,
  };
}

type IssueState = {
  issues: Issue[];
  nextTicketNum: number;
  ticketPrefix: string;
  epics: string[];
  labels: string[];
};

const DEFAULT_ISSUE_STATE: IssueState = {
  issues: [],
  nextTicketNum: 1,
  ticketPrefix: "PKT",
  epics: [],
  labels: [
    "bug",
    "feature",
    "enhancement",
    "refactor",
    "docs",
    "api",
    "frontend",
    "working",
    "devops",
  ],
};

function loadState(): IssueState {
  const parsed = loadFromStorage<IssueState>("packetade:issues", DEFAULT_ISSUE_STATE);
  return { ...parsed, issues: (parsed.issues || []).map(migrateIssue) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveNextTicketNum(issues: Issue[], ticketPrefix: string, fallback: number): number {
  const pattern = new RegExp(`^${escapeRegExp(ticketPrefix)}-(\\d+)$`);
  const maxTicketNum = issues.reduce((max, issue) => {
    const match = pattern.exec(issue.ticketId);
    if (!match) return max;
    return Math.max(max, Number.parseInt(match[1], 10));
  }, 0);
  return Math.max(fallback, maxTicketNum + 1);
}

function mergeBackendIssueWithLocalExtras(issue: Issue, local?: Issue): Issue {
  const migrated = migrateIssue(issue);
  if (!local) return migrated;

  return {
    ...migrated,
    comments: local.comments ?? migrated.comments,
    assignee: local.assignee ?? migrated.assignee,
    workspaceId: local.workspaceId,
    sentToWorkspaceAt: local.sentToWorkspaceAt,
    specImportBatchId: local.specImportBatchId,
  };
}

/**
 * v0.8.5 (CRITICAL FIX 2): mirror the issue array into the Rust
 * `PersistedState.issues` slice so the `git_commit` backend's
 * `emit_fixes_events` helper can resolve `Fixes #N` trailers against the
 * live local Issues set. Without this, the auto-Done close-loop listener
 * (registered below as `issue-watcher:fixed`) never fires because the
 * Rust side only ever sees an empty issue list. Fire-and-forget — the
 * inner `saveIssuesSlice` already wraps `invoke` and we add an extra
 * try/catch + `.catch()` so non-Tauri (vitest jsdom) environments don't
 * blow up the optimistic in-memory update.
 */
function syncIssuesToBackend(issues: Issue[]) {
  try {
    void saveIssuesSlice(issues).catch(logSwallowed("issueStore.save"));
  } catch {
    // invoke unavailable (test env) — silent fail; localStorage remains
    // the authoritative cold-start cache.
  }
}

function saveState(state: IssueState) {
  saveToStorage("packetade:issues", state);
  // Mirror to Rust PersistedState so server-side consumers (notably
  // `emit_fixes_events` in `commands/git.rs`) see the same data on every
  // mutation. Routed through a single helper here so every code path that
  // calls `saveState` automatically gets the backend sync.
  syncIssuesToBackend(state.issues);
}

let issueFlightReconcileQueued = false;

export async function reconcileIssueFlightLinks(): Promise<void> {
  try {
    const { useFlightStore } = await import("@/stores/flightStore");
    useFlightStore.getState().reconcileIssueLinks();
  } catch (err) {
    logSwallowed("issueStore.reconcileIssueFlightLinks")(err);
  }
}

/**
 * Deleting an Issue must also clear the flight-side half of the link.
 *
 * `Flight.issueIds` and `Issue.flightId` are two halves of one relationship
 * (see CLAUDE.md: `flightStore.addIssueToFlight` + `issueStore.assignToFlight`
 * are always called together). `flightStore.deleteFlight` mirrors this from the
 * other direction — it walks `flight.issueIds` and calls `assignToFlight(id,
 * null)` before dropping the flight. This is the same move for issue deletion:
 * every flight still naming the deleted issue drops it, so no flight is left
 * holding a reference to a record that no longer exists.
 *
 * `reconcileIssueLinks` alone would rebuild the same arrays, but only when the
 * deleted issue itself carried a `flightId`. A flight that lists an issue whose
 * own `flightId` had drifted to null would keep the dangling id forever, so the
 * explicit unlink runs on every delete — and the reconcile then runs on the
 * same store handle as the usual backstop for any other drift.
 *
 * Dynamically imported: `flightStore` imports this module at the top level, so
 * a static import here would close a cycle. One import serves both steps, which
 * also keeps their ordering deterministic.
 */
export async function unlinkDeletedIssueFromFlights(issueId: string): Promise<void> {
  try {
    const { useFlightStore } = await import("@/stores/flightStore");
    const flights = useFlightStore.getState().flights ?? [];
    for (const flight of flights) {
      if (!flight.issueIds?.includes(issueId)) continue;
      useFlightStore.getState().removeIssueFromFlight(flight.id, issueId);
    }
    useFlightStore.getState().reconcileIssueLinks();
  } catch (err) {
    logSwallowed("issueStore.unlinkDeletedIssueFromFlights")(err);
  }
}

function queueIssueFlightReconciliation() {
  if (issueFlightReconcileQueued) return;
  issueFlightReconcileQueued = true;
  void Promise.resolve().then(async () => {
    issueFlightReconcileQueued = false;
    await reconcileIssueFlightLinks();
  });
}

const initial = loadState();

export const useIssueStore = create<IssueStore>((set, get) => ({
  ...initial,

  addIssue: (issue) => {
    const state = get();
    const ticketId = `${state.ticketPrefix}-${String(state.nextTicketNum).padStart(3, "0")}`;
    const newIssue: Issue = {
      ...issue,
      flightId: issue.flightId ?? null,
      id: generateIssueId(),
      ticketId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const newState = {
      issues: [...state.issues, newIssue],
      nextTicketNum: state.nextTicketNum + 1,
      ticketPrefix: state.ticketPrefix,
      epics: state.epics,
      labels: state.labels,
    };
    set(newState);
    saveState(newState);
    if (newIssue.flightId) queueIssueFlightReconciliation();
    return newIssue;
  },

  updateIssue: (id, updates) => {
    const updatesFlightId = Object.prototype.hasOwnProperty.call(updates, "flightId");
    let changedFlightLink = false;

    set((s) => {
      if (updatesFlightId) {
        const existing = s.issues.find((i) => i.id === id);
        changedFlightLink = Boolean(existing && existing.flightId !== updates.flightId);
      }

      const issues = s.issues.map((i) =>
        i.id === id ? { ...i, ...updates, updatedAt: Date.now() } : i,
      );
      saveState({
        issues,
        nextTicketNum: s.nextTicketNum,
        ticketPrefix: s.ticketPrefix,
        epics: s.epics,
        labels: s.labels,
      });
      return { issues };
    });

    if (changedFlightLink) queueIssueFlightReconciliation();
  },

  deleteIssue: (id) => {
    let removedIssue = false;

    set((s) => {
      removedIssue = s.issues.some((i) => i.id === id);
      if (!removedIssue) return {};
      // Also remove this issue from any blockedBy/blocks arrays
      const issues = s.issues
        .filter((i) => i.id !== id)
        .map((i) => ({
          ...i,
          blockedBy: i.blockedBy.filter((bid) => bid !== id),
          blocks: i.blocks.filter((bid) => bid !== id),
        }));
      saveState({
        issues,
        nextTicketNum: s.nextTicketNum,
        ticketPrefix: s.ticketPrefix,
        epics: s.epics,
        labels: s.labels,
      });
      return { issues };
    });

    if (removedIssue) {
      // Bidirectional cleanup: drop the id from any flight that still names it
      // (mirrors `flightStore.deleteFlight` clearing `Issue.flightId`) and run
      // the reconcile backstop. Both live behind one dynamic import.
      void unlinkDeletedIssueFromFlights(id);
    }
  },

  moveIssue: (id, status) => {
    get().updateIssue(id, { status });
  },

  assignToFlight: (issueId, flightId) => {
    get().updateIssue(issueId, { flightId });
  },

  addEpic: (epic) => {
    set((s) => {
      const epics = s.epics.includes(epic) ? s.epics : [...s.epics, epic];
      saveState({
        issues: s.issues,
        nextTicketNum: s.nextTicketNum,
        ticketPrefix: s.ticketPrefix,
        epics,
        labels: s.labels,
      });
      return { epics };
    });
  },

  addLabel: (label) => {
    set((s) => {
      const labels = s.labels.includes(label) ? s.labels : [...s.labels, label];
      saveState({
        issues: s.issues,
        nextTicketNum: s.nextTicketNum,
        ticketPrefix: s.ticketPrefix,
        epics: s.epics,
        labels,
      });
      return { labels };
    });
  },

  setTicketPrefix: (prefix) => {
    set((s) => {
      saveState({
        issues: s.issues,
        nextTicketNum: s.nextTicketNum,
        ticketPrefix: prefix,
        epics: s.epics,
        labels: s.labels,
      });
      return { ticketPrefix: prefix };
    });
  },

  hydrateFromBackend: (backendIssues = []) => {
    const state = get();

    if (backendIssues.length === 0) {
      if (state.issues.length > 0) {
        syncIssuesToBackend(state.issues);
      }
      return;
    }

    const localById = new Map(state.issues.map((issue) => [issue.id, issue]));
    const backendIds = new Set(backendIssues.map((issue) => issue.id));
    const issues = backendIssues.map((issue) =>
      mergeBackendIssueWithLocalExtras(issue, localById.get(issue.id)),
    );
    for (const issue of state.issues) {
      if (!backendIds.has(issue.id)) {
        issues.push(migrateIssue(issue));
      }
    }
    const nextState: IssueState = {
      issues,
      nextTicketNum: deriveNextTicketNum(issues, state.ticketPrefix, state.nextTicketNum),
      ticketPrefix: state.ticketPrefix,
      epics: state.epics,
      labels: state.labels,
    };

    set(nextState);
    saveToStorage("packetade:issues", nextState);
    syncIssuesToBackend(issues);
    queueIssueFlightReconciliation();
  },

  getIssuesByStatus: (status) => get().issues.filter((i) => i.status === status),

  getColumns: () => STATUS_COLUMNS,

  // Acceptance criteria
  toggleCriterion: (issueId, criterionId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return;
    const acceptanceCriteria = issue.acceptanceCriteria.map((c) =>
      c.id === criterionId ? { ...c, checked: !c.checked } : c,
    );
    get().updateIssue(issueId, { acceptanceCriteria });
  },

  addCriterion: (issueId, text) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return;
    const newCriterion: AcceptanceCriterion = {
      id: generateCriterionId(),
      text,
      checked: false,
    };
    get().updateIssue(issueId, {
      acceptanceCriteria: [...issue.acceptanceCriteria, newCriterion],
    });
  },

  removeCriterion: (issueId, criterionId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return;
    get().updateIssue(issueId, {
      acceptanceCriteria: issue.acceptanceCriteria.filter((c) => c.id !== criterionId),
    });
  },

  // Dependencies
  addBlockedBy: (issueId, blockerIssueId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (
      !issue ||
      issue.blockedBy.includes(blockerIssueId) ||
      issue.blocks.includes(blockerIssueId)
    ) {
      return;
    }
    get().updateIssue(issueId, { blockedBy: [...issue.blockedBy, blockerIssueId] });
    // Also add the reverse relationship
    const blocker = get().issues.find((i) => i.id === blockerIssueId);
    if (blocker && !blocker.blocks.includes(issueId)) {
      get().updateIssue(blockerIssueId, { blocks: [...blocker.blocks, issueId] });
    }
  },

  removeBlockedBy: (issueId, blockerIssueId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return;
    get().updateIssue(issueId, {
      blockedBy: issue.blockedBy.filter((id) => id !== blockerIssueId),
    });
    // Also remove the reverse relationship
    const blocker = get().issues.find((i) => i.id === blockerIssueId);
    if (blocker) {
      get().updateIssue(blockerIssueId, { blocks: blocker.blocks.filter((id) => id !== issueId) });
    }
  },

  addBlocks: (issueId, blockedIssueId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (
      !issue ||
      issue.blocks.includes(blockedIssueId) ||
      issue.blockedBy.includes(blockedIssueId)
    ) {
      return;
    }
    get().updateIssue(issueId, { blocks: [...issue.blocks, blockedIssueId] });
    // Also add the reverse relationship
    const blocked = get().issues.find((i) => i.id === blockedIssueId);
    if (blocked && !blocked.blockedBy.includes(issueId)) {
      get().updateIssue(blockedIssueId, { blockedBy: [...blocked.blockedBy, issueId] });
    }
  },

  removeBlocks: (issueId, blockedIssueId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return;
    get().updateIssue(issueId, { blocks: issue.blocks.filter((id) => id !== blockedIssueId) });
    // Also remove the reverse relationship
    const blocked = get().issues.find((i) => i.id === blockedIssueId);
    if (blocked) {
      get().updateIssue(blockedIssueId, {
        blockedBy: blocked.blockedBy.filter((id) => id !== issueId),
      });
    }
  },

  // v0.8.5: inline comments. Comment writes also update `updatedAt` so the
  // issue rises in any recency-sorted view (`updateIssue` already does this).
  addIssueComment: (issueId, body, author = "user") => {
    const trimmed = body.trim();
    if (!trimmed) return null;
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return null;
    const comment: IssueComment = {
      id: generateCommentId(),
      author,
      body: trimmed,
      createdAt: Date.now(),
    };
    const comments = [...(issue.comments ?? []), comment];
    get().updateIssue(issueId, { comments });
    return comment;
  },

  deleteIssueComment: (issueId, commentId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue || !issue.comments) return;
    const comments = issue.comments.filter((c) => c.id !== commentId);
    get().updateIssue(issueId, { comments });
  },

  // v0.8.5 — orchestrator action. See JSDoc on the interface declaration
  // for the contract. Implementation strategy:
  //   1. Build a "first prompt" from the Issue (title + body + acceptance
  //      criteria).
  //   2. Reuse the active workspace if one exists in the current project,
  //      otherwise spin up a dedicated workspace named for the issue with
  //      a single `claude-code` pane.
  //   3. Stamp the workspace/session ids onto the Issue + flip status to
  //      `in_progress`.
  //   4. Switch the app view to "workspace".
  //
  // Lazy-imports the other stores to avoid a module-init cycle (issue
  // store ↔ workspace store ↔ app store).
  sendIssueToWorkspace: async (issueId) => {
    const issue = get().issues.find((i) => i.id === issueId);
    if (!issue) return null;

    const [{ useLayoutStore }, { useWorkspaceStore }, { useAppStore }] = await Promise.all([
      import("@/stores/layoutStore"),
      import("@/stores/workspaceStore"),
      import("@/stores/appStore"),
    ]);

    // Build the Issue-context prompt that seeds the new pane. Mirrors the
    // "Hand off to Claude" CTA in GitHubView so the receiving CLI sees a
    // consistent envelope across surfaces.
    const ticketTag = issue.ticketId || `#${issueId}`;
    const acceptanceBlock =
      issue.acceptanceCriteria.length > 0
        ? `**Acceptance criteria:**\n${issue.acceptanceCriteria
            .map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`)
            .join("\n")}\n\n`
        : "";
    const initialPrompt =
      `--- Issue ${ticketTag}: ${issue.title} ---\n\n` +
      `${issue.description || "(no description)"}\n\n` +
      `${acceptanceBlock}` +
      `--- Please proceed. ---`;

    // Resolve a project path. Prefer the active workspace's path (handles
    // the case where the user is mid-task in a project that differs from
    // the global layout one), fall back to `layoutStore.projectPath`.
    const workspaceState = useWorkspaceStore.getState();
    const activeWs = workspaceState.workspaces.find(
      (w) => w.id === workspaceState.activeWorkspaceId,
    );
    const projectPath = activeWs?.projectPath || useLayoutStore.getState().projectPath || "";
    if (!projectPath) return null;

    // Spin up a workspace dedicated to this Issue. Naming pattern matches
    // GitHub-issue-driven workspaces ("Issue #N: title") so the
    // WorkspaceSidebar groups them together. `prompt` on the workspace is
    // auto-sent into the new PTY by `useTerminalSession` once the session
    // is ready.
    const ticketNumMatch = ticketTag.match(/(\d+)$/);
    const ticketNum = ticketNumMatch ? ticketNumMatch[1] : ticketTag;
    const wsName = `Issue #${ticketNum}: ${issue.title}`.slice(0, 60);

    // v0.8.5 fix: provision a per-Issue git worktree BEFORE creating the
    // workspace. The Rust side installs a `prepare-commit-msg` hook in
    // the worktree that appends `Fixes #N` + `Run-By: PacketADE issue
    // I-<id>` to every commit, which is what closes the auto-Done loop
    // (git_commit emits `issue-watcher:fixed` → the listener below flips
    // the Issue to `done`). Without the worktree, the PTY runs in the
    // bare project root, no hook is installed, and the loop never fires.
    //
    // Fallback: if worktree provisioning fails (uncommitted changes in
    // main, branch-name conflict, non-git project, etc.) we log the
    // error and fall back to the original project path. The user still
    // gets a working pane — they just won't get auto-Done from this
    // session and will have to flip the Issue status manually.
    const parsedIssueNumber = ticketNumMatch ? Number(ticketNumMatch[1]) : NaN;
    let worktreePath = projectPath;
    if (Number.isFinite(parsedIssueNumber) && parsedIssueNumber > 0) {
      try {
        worktreePath = await createIssueWorktree(
          issueId,
          parsedIssueNumber,
          issue.title,
          projectPath,
        );
      } catch (err) {
        console.warn(
          `[issueStore] createIssueWorktree failed for ${issueId} (${ticketTag}); ` +
            `falling back to project root — auto-Done close-loop will NOT fire for this session.`,
          err,
        );
        worktreePath = projectPath;
      }
    } else {
      console.warn(
        `[issueStore] Issue ${issueId} has no numeric ticket suffix (ticketTag="${ticketTag}"); ` +
          `skipping worktree provisioning — auto-Done close-loop will NOT fire for this session.`,
      );
    }

    const workspaceId = workspaceState.createWorkspace(wsName, [getPreferredWorkspaceCli()], worktreePath, {
      prompt: initialPrompt,
    });

    // `createWorkspace` builds exactly one pane for the single agent we
    // passed. Grab its id so we can stamp it onto the Issue. If the
    // workspace creation somehow produced no panes (defensive — never
    // observed in practice) we bail without touching Issue state.
    const created = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
    const paneId = created?.panes[0]?.id;
    if (!paneId) return null;

    // Stamp linkage + flip to in_progress in a single update so the card
    // re-renders the "→ Workspace" pill atomically.
    get().updateIssue(issueId, {
      workspaceId,
      sessionId: paneId,
      sentToWorkspaceAt: Date.now(),
      status: issue.status === "done" ? issue.status : "in_progress",
    });

    // Activate the workspace + switch view. `setActiveWorkspace` already
    // syncs `layoutStore.projectPath` for local workspaces, so no extra
    // wiring needed.
    useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
    useAppStore.getState().setActiveView("workspace");

    return { workspaceId, sessionId: paneId };
  },
}));

/**
 * v0.8.5 — close-loop listener.
 *
 * The Rust `git_commit` command scans every successful commit message for
 * `Fixes #N` / `Closes #N` / `Resolves #N` trailers (the
 * `prepare-commit-msg` hook installed by
 * `core::worktree::create_local_worktree_for_issue` appends `Fixes
 * #{issue_number}` to every commit made inside an Issue-bound worktree).
 * When a trailer resolves to a known Issue by `ticketId` suffix, the
 * backend emits `issue-watcher:fixed` with the issue id + commit
 * metadata.
 *
 * This module-level listener flips the matching Issue to `done` and
 * records an auto-comment for audit. The listener is registered once at
 * module init (matching the dictation / side-chat store patterns) and is
 * guarded by a try/catch so non-Tauri test environments don't blow up.
 *
 * Note: this intentionally does NOT kill or otherwise touch any linked
 * `sessionId` workspace pane — closing the Issue is a status flip only;
 * the agent's session keeps running for follow-up work.
 */
interface IssueFixedPayload {
  issueId: string;
  ticketId: string;
  issueNumber: number;
  commitSha: string;
  commitSubject: string;
}

let issueWatcherUnlisten: UnlistenFn | null = null;

async function registerIssueWatcher() {
  try {
    issueWatcherUnlisten = await listen<IssueFixedPayload>("issue-watcher:fixed", (event) => {
      const payload = event.payload;
      if (!payload || !payload.issueId) return;
      const store = useIssueStore.getState();
      const issue = store.issues.find((i) => i.id === payload.issueId);
      if (!issue) return;
      if (issue.status === "done") return;

      // Flip to done. We deliberately do NOT touch sessionId /
      // workspaceId — the agent session stays alive for follow-up.
      store.updateIssue(payload.issueId, { status: "done" });

      // Audit trail: drop a system comment with the commit ref. The
      // comments field was introduced in v0.8.5 (Agent D's slice) so
      // the API is available; on stored issues that pre-date comments
      // the `addIssueComment` helper transparently initialises the
      // array.
      const shortSha = (payload.commitSha || "").slice(0, 7);
      const subject = (payload.commitSubject || "").trim();
      const body = shortSha
        ? subject
          ? `Auto-closed by commit ${shortSha}: ${subject}`
          : `Auto-closed by commit ${shortSha}`
        : subject
          ? `Auto-closed by commit: ${subject}`
          : "Auto-closed by commit";
      try {
        store.addIssueComment(payload.issueId, body, "system");
      } catch {
        // Comment failure is non-fatal — the status flip is the
        // primary effect and has already happened.
      }
    });
  } catch {
    // listen() throws under non-Tauri contexts (vitest unit tests). The
    // store still functions; the close-loop simply won't auto-trigger.
    issueWatcherUnlisten = null;
  }
}

// Read-only Monitor windows evaluate this module too (main.tsx statically
// imports the whole App graph), but their issueStore snapshot is frozen at
// window boot and this handler whole-slice-saves `packetade:issues` —
// registering here would let a stale monitor copy clobber the shared
// localStorage. The main window owns the close-loop. (Inline check instead
// of `isMonitorBoot()` to avoid the issueStore → monitorWindows →
// flightStore → issueStore import cycle.)
const bootedAsMonitorWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get(MONITOR_WINDOW_QUERY_KEY) === "monitor";
if (!bootedAsMonitorWindow) void registerIssueWatcher();

/**
 * v0.8.5: exported for HMR + tests. Detaches the `issue-watcher:fixed`
 * listener so a fresh module instance can re-register cleanly.
 */
export function _disposeIssueWatcher() {
  if (issueWatcherUnlisten) {
    issueWatcherUnlisten();
    issueWatcherUnlisten = null;
  }
}
