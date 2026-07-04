import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  GitBranch,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FileEdit,
  FilePlus,
  FileX,
  FileQuestion,
  Loader2,
  AlertCircle,
  GitBranchPlus,
  Server,
  FileCheck2,
  ShieldCheck,
  Link2,
} from "lucide-react";
import {
  getGitBranch,
  getGitStatus,
  getGitBranchRemote,
  getGitStatusRemote,
  gitPush,
  gitPull,
  gitCreateBranch,
  toGitServerConfigInput,
} from "@/lib/tauri";
import {
  type ChangedFile,
  parseGitStatus,
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  commitStaged,
  findLinkedIssue,
} from "@/lib/gitCommitFlow";
import { useServerStore } from "@/stores/serverStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { useIssueStore } from "@/stores/issueStore";
import {
  matchGitFilesToFlightTasks,
  flightReviewKey,
  type FlightReviewTaskRef,
} from "@/lib/flightReview";

function statusIcon(status: string) {
  switch (status) {
    case "M":
      return <FileEdit size={11} className="text-yellow-400" />;
    case "A":
      return <FilePlus size={11} className="text-accent-green" />;
    case "D":
      return <FileX size={11} className="text-red-400" />;
    case "??":
      return <FileQuestion size={11} className="text-text-muted" />;
    case "R":
      return <FileEdit size={11} className="text-blue-400" />;
    default:
      return <FileEdit size={11} className="text-text-muted" />;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "M":
      return "text-yellow-400";
    case "A":
      return "text-accent-green";
    case "D":
      return "text-red-400";
    case "??":
      return "text-text-muted";
    case "R":
      return "text-blue-400";
    default:
      return "text-text-secondary";
  }
}

interface GitDashboardProps {
  projectPath: string;
  workspaceId?: string;
  /** Phase 3.3: when set, the dashboard reads git state from the matching
   *  saved server via SSH instead of the local filesystem. `projectPath`
   *  is then treated as the *remote* working tree on the host. */
  serverId?: string;
}

/** Phase 3.3: structured failure modes for git state loads. The dashboard
 *  uses these to pick between "Not a git repo", "Unable to connect, retry?"
 *  and the generic error toast — instead of dumping every error into a
 *  toast and leaving the panel stuck on a spinner. */
type LoadError =
  | { kind: "server-missing"; msg: string }
  | { kind: "not-a-repo"; msg: string }
  | { kind: "connection"; msg: string }
  | { kind: "other"; msg: string };

function classifyError(err: unknown): LoadError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("is not inside a git repository") || lower.includes("not a git repository")) {
    return { kind: "not-a-repo", msg: raw };
  }
  if (
    lower.includes("ssh failed") ||
    lower.includes("ssh command timed out") ||
    lower.includes("failed to spawn ssh") ||
    lower.includes("connection refused") ||
    lower.includes("connection reset") ||
    lower.includes("permission denied") ||
    lower.includes("host key verification failed")
  ) {
    return { kind: "connection", msg: raw };
  }
  return { kind: "other", msg: raw };
}

function shortFlightId(id: string): string {
  return `F-${id
    .replace(/^[a-z]+-/i, "")
    .slice(-4)
    .toUpperCase()}`;
}

function reviewTitle(refs: FlightReviewTaskRef[]): string {
  return refs
    .map((ref) => `${shortFlightId(ref.flightId)} / ${ref.taskTitle} (${ref.relation})`)
    .join("\n");
}

/** Per-row staging checkbox. A plain `<input>` doesn't support the
 *  `indeterminate` visual state via a prop — it has to be set on the DOM
 *  node directly, hence the ref effect. */
function StageCheckbox({
  file,
  disabled,
  onToggle,
}: {
  file: ChangedFile;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = file.staged && file.unstaged;
    }
  }, [file.staged, file.unstaged]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={file.staged && !file.unstaged}
      disabled={disabled}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      className="h-3 w-3 shrink-0 accent-accent-green disabled:opacity-40"
      title={file.staged ? "Staged — click to unstage" : "Unstaged — click to stage"}
    />
  );
}

export function GitDashboard({ projectPath, workspaceId, serverId }: GitDashboardProps) {
  const [branch, setBranch] = useState<string>("");
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [stagingBusy, setStagingBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [showBranchInput, setShowBranchInput] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  const server = useServerStore((s) =>
    serverId ? s.servers.find((srv) => srv.id === serverId) : undefined,
  );
  const flights = useFlightStore((s) => s.flights);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const issues = useIssueStore((s) => s.issues);
  const isRemote = !!serverId;

  const reviewContext = useMemo(
    () =>
      matchGitFilesToFlightTasks(
        files.map((file) => file.path),
        flights,
        { projectPath, workspaceId: workspaceId ?? null },
      ),
    [files, flights, projectPath, workspaceId],
  );

  const commitCandidateFiles = useMemo(() => files.filter((file) => file.staged), [files]);
  const stagedCount = commitCandidateFiles.length;

  const commitContext = useMemo(() => {
    const candidatePaths = new Set(commitCandidateFiles.map((file) => flightReviewKey(file.path)));
    const refs = [...reviewContext.matchesByPath.entries()]
      .filter(([path]) => candidatePaths.has(path))
      .flatMap(([, match]) => match.refs);
    const flightIds = [...new Set(refs.map((ref) => ref.flightId))];
    const taskIds = [...new Set(refs.map((ref) => ref.taskId))];
    const attemptIds = [...new Set(refs.map((ref) => ref.attemptId).filter(Boolean))];
    const sessionIds = [...new Set(refs.map((ref) => ref.sessionId).filter(Boolean))];
    if (flightIds.length === 0 && taskIds.length === 0) return null;
    return {
      flightId: flightIds.length === 1 ? flightIds[0] : null,
      taskId: taskIds.length === 1 ? taskIds[0] : null,
      attemptId: attemptIds.length === 1 ? attemptIds[0] : null,
      sessionId: sessionIds.length === 1 ? sessionIds[0] : null,
    };
  }, [commitCandidateFiles, reviewContext.matchesByPath]);

  // P1-15: transplanted from CommitModal — auto-seed the commit message
  // with a `Fixes #N` trailer when the active workspace is bound to an
  // open Issue, so the server-side close-loop can flip it to `done`.
  const linkedIssue = useMemo(() => findLinkedIssue(issues, workspaceId ?? null), [issues, workspaceId]);
  const seededRef = useRef(false);

  const openReviewFlight = useCallback(() => {
    const [flightId] = reviewContext.flightIds;
    if (flightId) setActiveFlight(flightId);
    setActiveView("flights");
  }, [reviewContext.flightIds, setActiveFlight, setActiveView]);

  const refresh = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setLoadError(null);
    try {
      if (isRemote) {
        if (!server) {
          setLoadError({
            kind: "server-missing",
            msg: `Server '${serverId}' is no longer configured. Reconnect or attach the workspace to a different server.`,
          });
          setBranch("");
          setFiles([]);
          return;
        }
        const serverConfig = toGitServerConfigInput(server);
        const [b, s] = await Promise.all([
          getGitBranchRemote(serverConfig, projectPath),
          getGitStatusRemote(serverConfig, projectPath),
        ]);
        setBranch(b.trim());
        setFiles(parseGitStatus(s));
      } else {
        const [b, s] = await Promise.all([getGitBranch(projectPath), getGitStatus(projectPath)]);
        setBranch(b.trim());
        setFiles(parseGitStatus(s));
      }
    } catch (e: unknown) {
      const classified = classifyError(e);
      setLoadError(classified);
      setBranch("");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, isRemote, server, serverId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-clear feedback after 4s
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  // P1-15: a workspace switch must not carry a half-typed message (or a
  // stale `Fixes #N` seed) into another repo — this replaces
  // CommitModal's snapshotted-path guard now that GitDashboard stays
  // mounted across active-workspace changes.
  useEffect(() => {
    seededRef.current = false;
    setCommitMsg("");
  }, [projectPath, workspaceId]);

  useEffect(() => {
    if (isRemote) return;
    if (seededRef.current) return;
    if (!linkedIssue) return;
    seededRef.current = true;
    setCommitMsg((prev) => (prev.length > 0 ? prev : `Fixes #${linkedIssue.num}\n\n`));
  }, [isRemote, linkedIssue]);

  async function handleCommit() {
    if (!commitMsg.trim() || stagedCount === 0) return;
    const path = projectPath;
    setActionLoading("commit");
    try {
      const result = await commitStaged(path, commitMsg, commitContext);
      setCommitMsg("");
      setFeedback({ type: "ok", msg: result || "Committed successfully" });
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Commit failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePush() {
    setActionLoading("push");
    try {
      const result = await gitPush(projectPath);
      setFeedback({ type: "ok", msg: result || "Pushed successfully" });
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Push failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handlePull() {
    setActionLoading("pull");
    try {
      const result = await gitPull(projectPath);
      setFeedback({ type: "ok", msg: result || "Pulled successfully" });
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Pull failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCreateBranch() {
    if (!newBranch.trim()) return;
    setActionLoading("branch");
    try {
      await gitCreateBranch(projectPath, newBranch.trim(), true);
      setNewBranch("");
      setShowBranchInput(false);
      setFeedback({ type: "ok", msg: `Switched to new branch: ${newBranch.trim()}` });
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Branch creation failed: ${e}` });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleToggleStage(file: ChangedFile) {
    if (stagingBusy) return;
    setStagingBusy(true);
    try {
      const fullyStaged = file.staged && !file.unstaged;
      if (fullyStaged) {
        await unstageFile(projectPath, file);
      } else {
        await stageFile(projectPath, file);
      }
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `${file.staged ? "Unstage" : "Stage"} failed: ${e}` });
    } finally {
      setStagingBusy(false);
    }
  }

  async function handleStageAll() {
    if (stagingBusy) return;
    setStagingBusy(true);
    try {
      await stageAllFiles(projectPath, files);
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Stage all failed: ${e}` });
    } finally {
      setStagingBusy(false);
    }
  }

  async function handleUnstageAll() {
    if (stagingBusy) return;
    setStagingBusy(true);
    try {
      await unstageAllFiles(projectPath, files);
      await refresh();
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Unstage all failed: ${e}` });
    } finally {
      setStagingBusy(false);
    }
  }

  // Phase 3.3: remote workspaces are read-only in this slice — commit /
  // push / pull / create-branch over SSH lands in a later phase. Disable
  // the action buttons but still expose status + refresh.
  const remoteReadOnlyTip = isRemote ? "Remote commit/push/pull not yet supported" : undefined;
  const hasUnstaged = files.some((f) => f.unstaged);

  return (
    <div className="flex h-full flex-col overflow-hidden text-ui">
      {/* Header: branch + actions */}
      <div className="flex shrink-0 items-center justify-between border-b border-bg-border bg-bg-secondary px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isRemote ? (
            <Server size={12} className="shrink-0 text-accent-blue" />
          ) : (
            <GitBranch size={12} className="shrink-0 text-accent-green" />
          )}
          <span className="truncate font-medium text-text-primary">
            {branch || (loadError ? "—" : "...")}
          </span>
          {isRemote && (
            <span
              className="bg-accent-blue/10 shrink-0 rounded-full px-1.5 py-0.5 font-mono text-meta text-accent-blue"
              title={server ? `${server.username}@${server.host}` : "remote"}
            >
              remote
            </span>
          )}
          {!isRemote && (
            <button
              onClick={() => setShowBranchInput((v) => !v)}
              className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
              title="Create branch"
            >
              <GitBranchPlus size={11} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePull}
            disabled={!!actionLoading || isRemote}
            className="flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:opacity-40"
            title={remoteReadOnlyTip ?? "Pull"}
          >
            {actionLoading === "pull" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <ArrowDownToLine size={10} />
            )}
            Pull
          </button>
          <button
            onClick={handlePush}
            disabled={!!actionLoading || isRemote}
            className="flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:opacity-40"
            title={remoteReadOnlyTip ?? "Push"}
          >
            {actionLoading === "push" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <ArrowUpFromLine size={10} />
            )}
            Push
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1 text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* New branch input */}
      {showBranchInput && (
        <div className="flex items-center gap-1.5 border-b border-bg-border bg-bg-secondary px-3 py-1.5">
          <input
            type="text"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateBranch()}
            placeholder="new-branch-name"
            className="focus:border-accent-green/50 flex-1 rounded border border-bg-border bg-bg-primary px-2 py-0.5 text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
            autoFocus
          />
          <button
            onClick={handleCreateBranch}
            disabled={!newBranch.trim() || !!actionLoading}
            className="bg-accent-green/20 hover:bg-accent-green/30 rounded px-1.5 py-0.5 text-ui text-accent-green transition-colors disabled:opacity-40"
          >
            {actionLoading === "branch" ? <Loader2 size={10} className="animate-spin" /> : "Create"}
          </button>
        </div>
      )}

      {/* Feedback toast */}
      {feedback && (
        <div
          className={`flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-meta ${
            feedback.type === "ok"
              ? "bg-accent-green/10 text-accent-green"
              : "bg-red-500/10 text-red-400"
          }`}
        >
          {feedback.type === "ok" ? <Check size={10} /> : <AlertCircle size={10} />}
          <span className="truncate">{feedback.msg}</span>
        </div>
      )}

      {!loadError && reviewContext.linkedFileCount > 0 && (
        <div className="border-accent-amber/30 bg-accent-amber/5 mx-2 mt-2 shrink-0 rounded border px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={11} className="shrink-0 text-accent-amber" />
            <span className="text-ui font-semibold text-text-primary">
              Review before commit
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={openReviewFlight}
              className="hover:text-accent-amber/80 text-ui text-accent-amber transition-colors"
            >
              Open flight
            </button>
          </div>
          <div className="mt-0.5 text-meta leading-relaxed text-text-muted">
            {reviewContext.linkedFileCount} of {files.length} changed file
            {reviewContext.linkedFileCount === 1 ? "" : "s"} map to {reviewContext.taskCount}{" "}
            flight task
            {reviewContext.taskCount === 1 ? "" : "s"}.
            {reviewContext.pendingApprovalCount > 0
              ? ` ${reviewContext.pendingApprovalCount} approval${reviewContext.pendingApprovalCount === 1 ? "" : "s"} still pending.`
              : " Resolve flight review, then land the commit."}
          </div>
        </div>
      )}

      {/* Select-all affordance — local workspaces only */}
      {!loadError && !isRemote && files.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-bg-border px-3 py-1 text-ui text-text-muted">
          <span>
            {stagedCount} of {files.length} staged
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={handleStageAll}
            disabled={stagingBusy || !hasUnstaged}
            className="rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-40"
          >
            Stage all
          </button>
          <button
            type="button"
            onClick={handleUnstageAll}
            disabled={stagingBusy || stagedCount === 0}
            className="rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-40"
          >
            Unstage all
          </button>
        </div>
      )}

      {/* Changed files list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {loadError && (
          <div className="flex flex-col items-center gap-2 px-3 py-4 text-ui">
            <AlertCircle size={20} className="text-accent-amber" />
            <div className="text-center text-text-secondary">
              {loadError.kind === "server-missing" && (
                <span className="text-accent-red">{loadError.msg}</span>
              )}
              {loadError.kind === "not-a-repo" && (
                <>
                  <div className="font-medium text-text-primary">Not a git repository</div>
                  <div className="mt-0.5 text-meta text-text-muted">{projectPath}</div>
                </>
              )}
              {loadError.kind === "connection" && (
                <>
                  <div className="font-medium text-text-primary">Unable to connect</div>
                  <div className="mt-1 break-words text-meta text-text-muted">
                    {loadError.msg}
                  </div>
                </>
              )}
              {loadError.kind === "other" && (
                <>
                  <div className="font-medium text-text-primary">Failed to load git info</div>
                  <div className="mt-1 break-words text-meta text-text-muted">
                    {loadError.msg}
                  </div>
                </>
              )}
            </div>
            {loadError.kind !== "not-a-repo" && (
              <button
                onClick={refresh}
                disabled={loading}
                className="mt-1 flex items-center gap-1.5 rounded bg-bg-tertiary px-2 py-1 text-ui text-text-secondary transition-colors hover:bg-bg-border hover:text-text-primary disabled:opacity-40"
              >
                {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                Retry
              </button>
            )}
          </div>
        )}
        {!loadError && files.length === 0 && !loading && (
          <div className="flex items-center justify-center py-6 text-ui text-text-muted">
            Working tree clean
          </div>
        )}
        {!loadError && loading && files.length === 0 && (
          <div className="flex items-center justify-center gap-1.5 py-6 text-ui text-text-muted">
            <Loader2 size={11} className="animate-spin" />
            Loading{isRemote ? " over SSH" : ""}...
          </div>
        )}
        {!loadError &&
          files.map((f, i) => {
            const match = reviewContext.matchesByPath.get(flightReviewKey(f.path));
            const primaryRef = match?.refs[0];
            return (
              <div
                key={`${f.path}-${i}`}
                className="group flex items-center gap-1.5 rounded px-2 py-[3px] transition-colors hover:bg-bg-secondary"
              >
                {!isRemote && (
                  <StageCheckbox
                    file={f}
                    disabled={stagingBusy}
                    onToggle={() => handleToggleStage(f)}
                  />
                )}
                {statusIcon(f.status)}
                <span className={`w-5 shrink-0 font-mono text-meta ${statusColor(f.status)}`}>
                  {f.status}
                </span>
                <span className="truncate text-ui text-text-secondary" title={f.path}>
                  {f.path}
                </span>
                {primaryRef && (
                  <button
                    type="button"
                    onClick={openReviewFlight}
                    title={reviewTitle(match.refs)}
                    className="border-accent-amber/25 bg-accent-amber/10 hover:bg-accent-amber/15 ml-auto inline-flex min-w-0 max-w-[112px] shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-meta text-accent-amber transition-colors"
                  >
                    <FileCheck2 size={9} className="shrink-0" />
                    <span className="truncate">
                      {shortFlightId(primaryRef.flightId)} · {primaryRef.taskTitle}
                    </span>
                  </button>
                )}
              </div>
            );
          })}
      </div>

      {/* Commit section — local workspaces only. Remote commit/push lands
          in a follow-up phase; for now we hide the form and surface a
          short note. */}
      {isRemote ? (
        <div className="shrink-0 border-t border-bg-border bg-bg-secondary px-3 py-2 text-meta text-text-muted">
          Remote write actions (commit, push, pull, branch) are not yet supported. Use a terminal
          session on the remote host for now.
        </div>
      ) : (
        <div className="shrink-0 space-y-1.5 border-t border-bg-border bg-bg-secondary px-3 py-2">
          {linkedIssue && (
            <div
              className="flex items-center gap-1.5 text-meta text-text-muted"
              title={`This commit will auto-close ${linkedIssue.issue.ticketId} when it lands.`}
            >
              <Link2 size={10} className="text-accent-blue/70 shrink-0" />
              <span className="truncate">
                Linked to Issue #{linkedIssue.num}:{" "}
                <span className="text-text-secondary">{linkedIssue.issue.title}</span>
              </span>
            </div>
          )}
          {reviewContext.linkedFileCount > 0 ? (
            <div className="flex items-center gap-1.5 text-meta text-accent-amber">
              <FileCheck2 size={10} />
              <span className="truncate">
                Review {reviewContext.linkedFileCount} flight-linked file
                {reviewContext.linkedFileCount === 1 ? "" : "s"} before committing.
              </span>
            </div>
          ) : (
            <div className="text-meta text-text-muted">
              {stagedCount === 0
                ? "Commits staged files only — stage files above"
                : "Flight-linked commits receive PacketADE trailers when a task match is found."}
            </div>
          )}
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            rows={2}
            className="focus:border-accent-green/50 w-full resize-none rounded border border-bg-border bg-bg-primary px-2 py-1 text-ui text-text-primary placeholder:text-text-muted focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || stagedCount === 0 || !!actionLoading}
            className="bg-accent-green/20 hover:bg-accent-green/30 flex w-full items-center justify-center gap-1.5 rounded py-1 text-ui font-medium text-accent-green transition-colors disabled:cursor-not-allowed disabled:opacity-30"
          >
            {actionLoading === "commit" ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            {reviewContext.linkedFileCount > 0 ? "Commit after review" : "Commit staged"}
          </button>
        </div>
      )}
    </div>
  );
}
