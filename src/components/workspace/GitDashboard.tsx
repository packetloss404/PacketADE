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
} from "lucide-react";
import {
  getGitBranch,
  getGitStatus,
  gitCommit,
  gitPush,
  gitPull,
  gitCreateBranch,
} from "@/lib/tauri";

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
}

export function GitDashboard({ projectPath }: GitDashboardProps) {
  const [branch, setBranch] = useState<string>("");
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [showBranchInput, setShowBranchInput] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const [b, s] = await Promise.all([
        getGitBranch(projectPath),
        getGitStatus(projectPath),
      ]);
      setBranch(b.trim());
      setFiles(parseGitStatus(s));
    } catch (e: unknown) {
      setFeedback({ type: "err", msg: `Failed to load git info: ${e}` });
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

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

  return (
    <div className="flex flex-col h-full text-xs overflow-hidden">
      {/* Header: branch + actions */}
      <div className="px-3 py-2 border-b border-bg-border bg-bg-secondary flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch size={12} className="text-accent-green shrink-0" />
          <span className="text-text-primary font-medium truncate">{branch || "..."}</span>
          <button
            onClick={() => setShowBranchInput((v) => !v)}
            className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
            title="Create branch"
          >
            <GitBranchPlus size={11} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePull}
            disabled={!!actionLoading}
            className="px-1.5 py-0.5 rounded text-[10px] bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-border transition-colors disabled:opacity-40 flex items-center gap-1"
            title="Pull"
          >
            {actionLoading === "pull" ? <Loader2 size={10} className="animate-spin" /> : <ArrowDownToLine size={10} />}
            Pull
          </button>
          <button
            onClick={handlePush}
            disabled={!!actionLoading}
            className="px-1.5 py-0.5 rounded text-[10px] bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-border transition-colors disabled:opacity-40 flex items-center gap-1"
            title="Push"
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
        {files.length === 0 && !loading && (
          <div className="flex items-center justify-center py-6 text-text-muted text-[10px]">
            Working tree clean
          </div>
        )}
        {files.map((f, i) => (
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

      {/* Commit section */}
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
    </div>
  );
}
