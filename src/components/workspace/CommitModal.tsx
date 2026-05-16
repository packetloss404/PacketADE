import { useEffect, useMemo, useRef, useState } from "react";
import { GitCommit, Check } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { gitCommit } from "@/lib/tauri";

interface CommitModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  onCommitted?: (sha?: string) => void;
}

/**
 * CommitModal — explicit-action git commit dialog.
 *
 * Replaces the legacy `window.prompt(...)` flow in the Toolbar. Commit is
 * gated behind a primary button click; there is intentionally NO Ctrl+Enter
 * submit shortcut, to prevent accidental commits while the user is still
 * editing the message.
 */
export function CommitModal({ open, onClose, projectPath, onCommitted }: CommitModalProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedSha, setCommittedSha] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset local state when the modal closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setMessage("");
      setError(null);
      setCommittedSha(null);
      setBusy(false);
    }
  }, [open]);

  // Auto-focus the textarea when the modal opens.
  useEffect(() => {
    if (open) {
      // Defer focus until after Modal mounts.
      const handle = window.setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(handle);
    }
  }, [open]);

  const projectBasename = useMemo(() => {
    if (!projectPath) return "";
    // Handle both POSIX and Windows separators.
    const trimmed = projectPath.replace(/[\\/]+$/, "");
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }, [projectPath]);

  const canCommit = message.trim().length > 0 && !busy && !committedSha;

  async function handleCommit() {
    if (!canCommit) return;
    setBusy(true);
    setError(null);
    try {
      // Stage-all is rejected by the safety layer; commit staged changes only.
      // `git commit -m ...` returns stdout like:
      //   [main abc1234] subject
      //    N files changed, ...
      // — parse out the short sha from the first line. Fallback: no sha display.
      const stdout = await gitCommit(projectPath, message.trim(), false);
      const shaMatch = stdout.match(/\[[^\]]+\s([a-f0-9]{7,40})\]/);
      const sha = shaMatch ? shaMatch[1] : "";
      setCommittedSha(sha);
      onCommitted?.(sha || undefined);
      // Briefly show the success state before closing so the user sees the SHA.
      window.setTimeout(() => {
        onClose();
      }, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || "Git commit failed.");
      setBusy(false);
    }
  }

  if (!open) return null;

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-text-muted">
        Commits staged changes only — does not run <code className="font-mono">git add</code>.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCommit}
          disabled={!canCommit}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {committedSha !== null ? (
            <>
              <Check size={11} />
              {committedSha ? `Committed ${committedSha.slice(0, 7)}` : "Committed"}
            </>
          ) : busy ? (
            <>
              <GitCommit size={11} />
              Committing…
            </>
          ) : (
            <>
              <GitCommit size={11} />
              Commit
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={busy || committedSha !== null ? () => {} : onClose}
      closeDisabled={busy || committedSha !== null}
      title="Commit changes"
      icon={<GitCommit size={14} className="text-accent-green" />}
      width="w-[520px]"
      footer={footer}
    >
      <div className="px-5 py-4 flex flex-col gap-3">
        {/* Project summary */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-muted uppercase tracking-wider">
            Project
          </label>
          <div
            className="text-[11px] text-text-secondary bg-bg-primary border border-bg-border rounded px-2.5 py-1.5 font-mono truncate"
            title={projectPath || "(no project path)"}
          >
            {projectBasename || projectPath || "(no project path)"}
          </div>
        </div>

        {/* Commit message */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-muted uppercase tracking-wider">
            Message
          </label>
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            rows={6}
            disabled={busy}
            className="w-full bg-bg-primary text-xs text-text-primary placeholder:text-text-muted px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50 resize-y disabled:opacity-60"
          />
          {error && (
            <p className="text-[11px] text-accent-red whitespace-pre-wrap break-words">
              {error}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
