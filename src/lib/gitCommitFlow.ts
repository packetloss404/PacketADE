import { gitCommit, gitStageFiles, gitUnstageFiles } from "@/lib/tauri";

/**
 * P1-15: the staging→commit flow, extracted from GitDashboard so it can
 * be unit-tested at the command-wrapper layer without mounting React.
 *
 * `core/git.rs commit_with_context` hard-rejects `stage_all` commits and
 * requires the index to be non-empty (see git.rs:235-244) — the in-app
 * commit flow MUST stage specific files first via `gitStageFiles`, then
 * commit with `stageAll=false`. Every function here funnels through the
 * existing `gitCommit` wrapper so the server-side `Fixes #N` close-loop
 * (commands/git.rs `git_commit` → `emit_fixes_events`) keeps firing.
 */

export interface ChangedFile {
  status: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
}

/** Parses `git status --short` output. Moved from GitDashboard.tsx, plus
 *  `unstaged` (rawStatus[1] !== " "): a file like "MM" is both staged AND
 *  has further worktree changes ("partially staged"). For "??" both status
 *  chars are "?", so unstaged=true and staged=false, matching the
 *  pre-existing staged rule.
 *
 *  P1-15 fix over the GitDashboard original: split into lines BEFORE any
 *  trimming. The old blob-level `output.trim()` ate the leading space of
 *  the first line, so a worktree-only change like " M foo.ts" sorted first
 *  parsed as staged with a garbled path — harmless when the status columns
 *  were cosmetic, data-loss once they drive per-file staging. Only trailing
 *  \r is stripped per line; the status columns are position-sensitive. */
export function parseGitStatus(output: string): ChangedFile[] {
  return output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const rawStatus = line.substring(0, 2);
      return {
        status: rawStatus.trim(),
        path: line.substring(3).trim(),
        staged: rawStatus[0] !== " " && rawStatus[0] !== "?",
        unstaged: rawStatus[1] !== " ",
      };
    });
}

/** Renames arrive from `git status --short` as `R  old -> new` with
 *  `path` set to the composite `"old -> new"`. `git add`/`git restore`
 *  need both halves passed explicitly or the operation fails — split on
 *  " -> " only for rename statuses; every other status is a single path. */
export function pathsForStagingOp(file: ChangedFile): string[] {
  if (file.status.startsWith("R") && file.path.includes(" -> ")) {
    return file.path.split(" -> ");
  }
  return [file.path];
}

export async function stageFile(projectPath: string, file: ChangedFile): Promise<string> {
  return gitStageFiles(projectPath, pathsForStagingOp(file));
}

export async function unstageFile(projectPath: string, file: ChangedFile): Promise<string> {
  return gitUnstageFiles(projectPath, pathsForStagingOp(file));
}

/** The "working select-all affordance": one batched `git add -- <paths>`
 *  over every file with worktree changes. This is NOT the banned
 *  stage-all commit flag — it's an explicit `git add` of enumerated
 *  paths, same as clicking every per-row checkbox at once. No-op when
 *  nothing is unstaged. */
export async function stageAllFiles(
  projectPath: string,
  files: ChangedFile[],
): Promise<string | undefined> {
  const paths = files.filter((f) => f.unstaged).flatMap(pathsForStagingOp);
  if (paths.length === 0) return undefined;
  return gitStageFiles(projectPath, paths);
}

export async function unstageAllFiles(
  projectPath: string,
  files: ChangedFile[],
): Promise<string | undefined> {
  const paths = files.filter((f) => f.staged).flatMap(pathsForStagingOp);
  if (paths.length === 0) return undefined;
  return gitUnstageFiles(projectPath, paths);
}

export interface CommitContext {
  flightId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
}

/** The transplanted CommitModal commit engine: staged-only, hardcoded
 *  `stageAll=false` (the only value `commit_with_context` accepts). Rejects
 *  an empty/whitespace message WITHOUT invoking `gitCommit` at all. */
export async function commitStaged(
  projectPath: string,
  message: string,
  context?: CommitContext | null,
): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Commit message is required");
  }
  return gitCommit(projectPath, trimmed, false, context ?? null);
}

/**
 * v0.8.5 (CRITICAL FIX 2): pull the trailing numeric suffix off a ticket
 * id like `"PKT-042"` → `42`. Returns `null` if the suffix isn't a number
 * — callers should fall back to skipping the autofill in that case.
 * Moved verbatim from CommitModal.tsx.
 */
export function extractTicketNumber(ticketId: string): number | null {
  const m = ticketId.match(/(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Loose shape of the subset of `Issue` (see @/stores/issueStore) that
 *  `findLinkedIssue` needs — typed structurally so this module doesn't
 *  have to import the full store type. */
export interface LinkableIssue {
  ticketId: string;
  title: string;
  status: string;
  workspaceId?: string;
}

export interface LinkedIssueMatch<T extends LinkableIssue> {
  issue: T;
  num: number;
}

/**
 * Pure extraction of CommitModal.tsx's linked-issue candidate logic
 * (:97-112), simplified: GitDashboard receives `workspaceId` directly as
 * a prop, so CommitModal's workspace-by-projectPath reverse lookup is
 * unnecessary here — callers just pass the workspace id they already
 * have. Excludes `done`/`cancelled` issues, drops non-numeric ticket
 * ids, and picks the smallest ticket number deterministically when
 * multiple issues are linked to the same workspace.
 */
export function findLinkedIssue<T extends LinkableIssue>(
  issues: T[],
  workspaceId: string | null | undefined,
): LinkedIssueMatch<T> | null {
  if (!workspaceId) return null;
  const candidates = issues
    .filter(
      (i) => i.workspaceId === workspaceId && i.status !== "done" && i.status !== "cancelled",
    )
    .map((i) => ({ issue: i, num: extractTicketNumber(i.ticketId) }))
    .filter((c): c is LinkedIssueMatch<T> => c.num !== null)
    .sort((a, b) => a.num - b.num);
  return candidates[0] ?? null;
}
