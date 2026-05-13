import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import {
  getGitBranch,
  getGitStatus,
  getGitBranchRemote,
  getGitStatusRemote,
  gitCommit,
  gitPush,
  gitPull,
  gitCreateBranch,
  toGitServerConfigInput,
} from "@/lib/tauri";
import { useServerStore } from "@/stores/serverStore";

interface ChangedFile {
  status: string;
  path: string;
}

function parseGitStatus(output: string): ChangedFile[] {
  if (!output.trim()) return [];
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.substring(0, 2).trim(),
      path: line.substring(3).trim(),
    }));
}

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

export function GitDashboard({ projectPath, serverId }: GitDashboardProps) {
  const [branch, setBranch] = useState<string>("");
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [showBranchInput, setShowBranchInput] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  const server = useServerStore((s) => (serverId ? s.servers.find((srv) => srv.id === serverId) : undefined));
  const isRemote = !!serverId;

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
        const [b, s] = await Promise.all([
          getGitBranch(projectPath),
          getGitStatus(projectPath),
        ]);
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

  async function handleCommit() {
    if (!commitMsg.trim() || files.length === 0) return;
    setActionLoading("commit");
    try {
      const result = await gitCommit(projectPath, commitMsg.trim(), stageAll);
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

  // Phase 3.3: remote workspaces are read-only in this slice — commit /
  // push / pull / create-branch over SSH lands in a later phase. Disable
  // the action buttons but still expose status + refresh.
  const remoteReadOnlyTip = isRemote ? "Remote commit/push/pull not yet supported" : undefined;

  return (
    <div className="flex flex-col h-full text-xs overflow-hidden">
      {/* Header: branch + actions */}
      <div className="px-3 py-2 border-b border-bg-border bg-bg-secondary flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isRemote ? (
            <Server size={12} className="text-accent-blue shrink-0" />
          ) : (
            <GitBranch size={12} className="text-accent-green shrink-0" />
          )}
          <span className="text-text-primary font-medium truncate">{branch || (loadError ? "—" : "...")}</span>
          {isRemote && (
            <span
              className="shrink-0 rounded-full bg-accent-blue/10 px-1.5 py-0.5 font-mono text-[9px] text-accent-blue"
              title={server ? `${server.username}@${server.host}` : "remote"}
            >
              remote
            </span>
          )}
          {!isRemote && (
            <button
              onClick={() => setShowBranchInput((v) => !v)}
              className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
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
            className="px-1.5 py-0.5 rounded text-[10px] bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-border transition-colors disabled:opacity-40 flex items-center gap-1"
            title={remoteReadOnlyTip ?? "Pull"}
          >
            {actionLoading === "pull" ? <Loader2 size={10} className="animate-spin" /> : <ArrowDownToLine size={10} />}
            Pull
          </button>
          <button
            onClick={handlePush}
            disabled={!!actionLoading || isRemote}
            className="px-1.5 py-0.5 rounded text-[10px] bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-border transition-colors disabled:opacity-40 flex items-center gap-1"
            title={remoteReadOnlyTip ?? "Push"}
          >
            {actionLoading === "push" ? <Loader2 size={10} className="animate-spin" /> : <ArrowUpFromLine size={10} />}
            Push
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1 text-text-muted hover:text-text-primary transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* New branch input */}
      {showBranchInput && (
        <div className="px-3 py-1.5 border-b border-bg-border bg-bg-secondary flex items-center gap-1.5">
          <input
            type="text"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateBranch()}
            placeholder="new-branch-name"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-0.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/50"
            autoFocus
          />
          <button
            onClick={handleCreateBranch}
            disabled={!newBranch.trim() || !!actionLoading}
            className="px-1.5 py-0.5 rounded text-[10px] bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-40"
          >
            {actionLoading === "branch" ? <Loader2 size={10} className="animate-spin" /> : "Create"}
          </button>
        </div>
      )}

      {/* Feedback toast */}
      {feedback && (
        <div
          className={`px-3 py-1.5 text-[10px] flex items-center gap-1.5 shrink-0 ${
            feedback.type === "ok"
              ? "bg-accent-green/10 text-accent-green"
              : "bg-red-500/10 text-red-400"
          }`}
        >
          {feedback.type === "ok" ? <Check size={10} /> : <AlertCircle size={10} />}
          <span className="truncate">{feedback.msg}</span>
        </div>
      )}

      {/* Changed files list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {loadError && (
          <div className="px-3 py-4 flex flex-col items-center gap-2 text-[11px]">
            <AlertCircle size={20} className="text-accent-amber" />
            <div className="text-text-secondary text-center">
              {loadError.kind === "server-missing" && (
                <span className="text-accent-red">{loadError.msg}</span>
              )}
              {loadError.kind === "not-a-repo" && (
                <>
                  <div className="font-medium text-text-primary">Not a git repository</div>
                  <div className="text-text-muted text-[10px] mt-0.5">
                    {projectPath}
                  </div>
                </>
              )}
              {loadError.kind === "connection" && (
                <>
                  <div className="font-medium text-text-primary">Unable to connect</div>
                  <div className="text-text-muted text-[10px] mt-1 break-words">
                    {loadError.msg}
                  </div>
                </>
              )}
              {loadError.kind === "other" && (
                <>
                  <div className="font-medium text-text-primary">Failed to load git info</div>
                  <div className="text-text-muted text-[10px] mt-1 break-words">
                    {loadError.msg}
                  </div>
                </>
              )}
            </div>
            {loadError.kind !== "not-a-repo" && (
              <button
                onClick={refresh}
                disabled={loading}
                className="mt-1 px-2 py-1 rounded text-[10px] bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-border transition-colors disabled:opacity-40 flex items-center gap-1.5"
              >
                {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                Retry
              </button>
            )}
          </div>
        )}
        {!loadError && files.length === 0 && !loading && (
          <div className="flex items-center justify-center py-6 text-text-muted text-[10px]">
            Working tree clean
          </div>
        )}
        {!loadError && loading && files.length === 0 && (
          <div className="flex items-center justify-center py-6 text-text-muted text-[10px] gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Loading{isRemote ? " over SSH" : ""}...
          </div>
        )}
        {!loadError && files.map((f, i) => (
          <div
            key={`${f.path}-${i}`}
            className="flex items-center gap-1.5 px-2 py-[3px] rounded hover:bg-bg-secondary transition-colors group"
          >
            {statusIcon(f.status)}
            <span className={`font-mono text-[10px] w-5 shrink-0 ${statusColor(f.status)}`}>
              {f.status}
            </span>
            <span className="text-text-secondary truncate text-[11px]" title={f.path}>
              {f.path}
            </span>
          </div>
        ))}
      </div>

      {/* Commit section — local workspaces only. Remote commit/push lands
          in a follow-up phase; for now we hide the form and surface a
          short note. */}
      {isRemote ? (
        <div className="px-3 py-2 border-t border-bg-border bg-bg-secondary shrink-0 text-[10px] text-text-muted">
          Remote write actions (commit, push, pull, branch) are not yet
          supported. Use a terminal session on the remote host for now.
        </div>
      ) : (
      <div className="px-3 py-2 border-t border-bg-border bg-bg-secondary shrink-0 space-y-1.5">
        <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(e) => setStageAll(e.target.checked)}
            className="accent-accent-green w-3 h-3"
          />
          Stage all changes
        </label>
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message..."
          rows={2}
          className="w-full bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/50 resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleCommit();
            }
          }}
        />
        <button
          onClick={handleCommit}
          disabled={!commitMsg.trim() || files.length === 0 || !!actionLoading}
          className="w-full py-1 rounded text-[11px] font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
        >
          {actionLoading === "commit" ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Check size={11} />
          )}
          Commit{stageAll ? " (stage all)" : ""}
        </button>
      </div>
      )}
    </div>
  );
}
