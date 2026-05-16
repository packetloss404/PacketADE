import { useEffect, useMemo, useRef, useState } from "react";
import { GitCommit, Check, Link2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { gitCommit } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useIssueStore } from "@/stores/issueStore";

interface CommitModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  onCommitted?: (sha?: string) => void;
}

/**
 * v0.8.5 (CRITICAL FIX 2): pull the trailing numeric suffix off a ticket
 * id like `"PKT-042"` → `42`. Returns `null` if the suffix isn't a number
 * — callers should fall back to skipping the autofill in that case.
 */
function extractTicketNumber(ticketId: string): number | null {
  const m = ticketId.match(/(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * CommitModal — explicit-action git commit dialog.
 *
 * Replaces the legacy `window.prompt(...)` flow in the Toolbar. Commit is
 * gated behind a primary button click; there is intentionally NO Ctrl+Enter
 * submit shortcut, to prevent accidental commits while the user is still
 * editing the message.
 *
 * v0.8.8 (edge case 4): captures the `projectPath` prop on open and
 * holds it stable for the lifetime of the modal session. After v88-A
 * made `useLayoutStore.projectPath` derive from the active workspace,
 * the Toolbar prop would otherwise change live mid-edit if the active
 * workspace got switched, archived, or deleted from another surface —
 * we'd commit to the WRONG repo. Snapshotting on `open` matches the
 * mental model: the user typed a message for THIS project.
 */
export function CommitModal({ open, onClose, projectPath, onCommitted }: CommitModalProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedSha, setCommittedSha] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // v0.8.8 (edge case 4): freeze the project path the moment the modal
  // opens. `capturedProjectPath` is what every downstream effect, label,
  // and `gitCommit` call sees. We also stash it in a ref so the
  // close-reset effect can null it without triggering re-renders.
  const [capturedProjectPath, setCapturedProjectPath] = useState<string>(projectPath);
  const capturedPathRef = useRef<string>(projectPath);
  useEffect(() => {
    if (open) {
      setCapturedProjectPath(projectPath);
      capturedPathRef.current = projectPath;
    }
    // Intentionally NOT depending on `projectPath` — we only want to
    // sample it on the open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // v0.8.5 (CRITICAL FIX 2): if the active workspace is bound to an Issue,
  // auto-seed the commit message with a `Fixes #N` trailer so the Rust
  // `git_commit` → `emit_fixes_events` chain can close the Issue. Reverse
  // lookup: an Issue whose `workspaceId` points at the active workspace.
  // We resolve the workspace by `projectPath` first (the modal's prop is
  // the authoritative project context) and fall back to `activeWorkspaceId`
  // for the case where the user has switched away from the linked
  // workspace but is still committing in the same project tree.
  //
  // Edge case: multiple Issues linked to the same workspace — we pick the
  // smallest ticket number deterministically.
  //
  // Implementation note: we subscribe to the raw `issues` + `workspaces`
  // arrays with plain selectors and derive the linked issue via `useMemo`,
  // rather than returning a fresh object from a single selector. Zustand
  // uses ref equality by default, so a selector returning a new object
  // per render would re-render forever.
  const issues = useIssueStore((s) => s.issues);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const linkedIssue = useMemo(() => {
    if (!open) return null;
    const matchingWs = workspaces.find(
      (w) =>
        w.status === "active" &&
        !w.serverId && // remote workspaces don't drive local commits
        w.projectPath === capturedProjectPath,
    );
    const wsId = matchingWs?.id ?? activeWorkspaceId ?? null;
    if (!wsId) return null;
    const candidates = issues
      .filter(
        (i) =>
          i.workspaceId === wsId &&
          // Exclude any terminal/closed status. `done` is the only terminal
          // state in the current IssueStatus union, but we defensively also
          // exclude `cancelled` so a future union expansion (or a stray
          // status coming in from external sync) doesn't re-introduce the
          // bug where a closed issue still seeds `Fixes #N` into the commit.
          i.status !== "done" &&
          (i.status as string) !== "cancelled",
      )
      .map((i) => ({ issue: i, num: extractTicketNumber(i.ticketId) }))
      .filter((c): c is { issue: typeof c.issue; num: number } => c.num !== null)
      .sort((a, b) => a.num - b.num);
    return candidates[0] ?? null;
  }, [open, capturedProjectPath, issues, workspaces, activeWorkspaceId]);

  // v0.8.5 (CRITICAL FIX 2): one-shot guard so the `Fixes #N` seed runs
  // exactly once per modal open. Without this the seed effect would
  // re-fire after we reset `message=""` on close, or after `linkedIssue`
  // identity changes mid-edit (e.g. the user added an acceptance
  // criterion in another pane while the modal was open).
  const seededForOpenRef = useRef(false);

  // Reset local state when the modal closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setMessage("");
      setError(null);
      setCommittedSha(null);
      setBusy(false);
      seededForOpenRef.current = false;
    }
  }, [open]);

  // v0.8.5 (CRITICAL FIX 2): seed the message with a `Fixes #N` trailer
  // when the active workspace is bound to an Issue. Stamps once per
  // modal open and never overwrites the user's typing. Seeds at the TOP
  // of the textarea with a blank line below; the user types their
  // subject + body underneath.
  useEffect(() => {
    if (!open) return;
    if (seededForOpenRef.current) return;
    if (!linkedIssue) return;
    seededForOpenRef.current = true;
    setMessage((prev) => (prev.length > 0 ? prev : `Fixes #${linkedIssue.num}\n\n`));
  }, [open, linkedIssue]);

  // Auto-focus the textarea when the modal opens. Place the caret at the
  // END of the textarea so the user can immediately start typing AFTER
  // the `Fixes #N` line (rather than overwriting it). Re-fires only on
  // open transitions — not on every keystroke.
  useEffect(() => {
    if (!open) return;
    // Defer focus until after Modal mounts AND the seed effect has run.
    const handle = window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      try {
        el.setSelectionRange(end, end);
      } catch {
        // jsdom-style hosts where setSelectionRange isn't implemented
        // — focus alone is enough.
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  const projectBasename = useMemo(() => {
    if (!capturedProjectPath) return "";
    // Handle both POSIX and Windows separators.
    const trimmed = capturedProjectPath.replace(/[\\/]+$/, "");
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }, [capturedProjectPath]);

  // v0.8.8 (edge case 2): when no workspace exists and the fallback
  // never got set, `capturedProjectPath` is `""`. Block the commit
  // button rather than letting `gitCommit("", ...)` reach the backend.
  const canCommit =
    message.trim().length > 0 &&
    !busy &&
    !committedSha &&
    capturedProjectPath.trim().length > 0;

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
      const stdout = await gitCommit(capturedProjectPath, message.trim(), false);
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
            title={capturedProjectPath || "(no project path)"}
          >
            {projectBasename || capturedProjectPath || "(no project path)"}
          </div>
          {/* v0.8.8 (edge case 2): explain why the commit button is
              disabled when there's no project path. Mirrors the
              `canCommit` guard so the user knows to set a folder via
              the Toolbar picker first. */}
          {!capturedProjectPath.trim() && (
            <p className="text-[10px] text-accent-amber">
              No project folder selected — pick one from the Toolbar before committing.
            </p>
          )}
        </div>

        {/* Commit message */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-muted uppercase tracking-wider">
            Message
          </label>
          {linkedIssue && (
            <div
              className="flex items-center gap-1.5 text-[10px] text-text-muted"
              title={`This commit will auto-close ${linkedIssue.issue.ticketId} when it lands.`}
            >
              <Link2 size={10} className="text-accent-blue/70 shrink-0" />
              <span className="truncate">
                Linked to Issue #{linkedIssue.num}:{" "}
                <span className="text-text-secondary">{linkedIssue.issue.title}</span>
              </span>
            </div>
          )}
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
