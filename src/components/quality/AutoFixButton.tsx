// v0.8.8 quality autofix
//
// Self-contained "Apply <fixer>" button + streaming output panel for the
// Code Quality modal. Each instance:
//   1. Confirms the destructive action via a nested Modal.
//   2. Subscribes to `quality-fix:chunk:<runId>` BEFORE invoking the
//      Tauri command (so the first line of output isn't dropped).
//   3. Streams live output into a collapsible panel.
//   4. On completion, fires an optional `onComplete` callback so the
//      parent can re-run lint / refresh availability counts.
//
// Layout note: this component renders inline (header row + collapsible
// streaming pane). The parent modal owns surrounding chrome — q2's
// layout work is unaffected. Drop one of these wherever a fixer makes
// sense in the per-check panel.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Play, Wrench } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { codeQualityRunFix, type QualityFixer, type QualityFixRunResult } from "@/lib/tauri";

interface AutoFixButtonProps {
  /** Project path the fixer should run against. */
  projectPath: string;
  /** Which fixer to run. */
  fixer: QualityFixer;
  /** Human-readable label rendered on the button. */
  label: string;
  /** Tooltip / description displayed in the confirm dialog. */
  description: string;
  /** Optional count rendered in the confirm dialog
   *  ("About to format N files…"). Falls back to the description alone. */
  fileCount?: number;
  /** When false, the button renders disabled with a hover tooltip
   *  explaining why (e.g. "No Cargo.toml found in this project"). */
  enabled: boolean;
  /** Reason the button is disabled (shown as title). */
  disabledReason?: string;
  /** Inline pill rendered to the right of the label (e.g. "12 issues
   *  auto-fixable"). Purely cosmetic. */
  badge?: string;
  /** Tint variant; lint defaults to blue, format to purple, cargo to
   *  amber, security to danger — keeps the modal visually grouped.
   *  Names mirror the shared `Button` variants. */
  variant?: "blue" | "purple" | "amber" | "danger" | "green";
  /** Fired after the run finishes (success OR failure). Use it to
   *  re-run the lint check or refresh availability counts. */
  onComplete?: (result: QualityFixRunResult) => void;
}

function uuid(): string {
  // crypto.randomUUID is fine in the webview; fall back for jsdom in
  // case unit tests ever import this module.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `fix-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function AutoFixButton({
  projectPath,
  fixer,
  label,
  description,
  fileCount,
  enabled,
  disabledReason,
  badge,
  variant = "blue",
  onComplete,
}: AutoFixButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string>("");
  const [expanded, setExpanded] = useState(false);
  const [lastResult, setLastResult] = useState<QualityFixRunResult | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);

  // Auto-scroll the streaming pane as new chunks arrive.
  useEffect(() => {
    if (outputRef.current && expanded) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, expanded]);

  async function runFixer() {
    setConfirmOpen(false);
    setRunning(true);
    setOutput("");
    setExpanded(true);

    const runId = uuid();
    let unlistenChunk: UnlistenFn | null = null;
    let unlistenDone: UnlistenFn | null = null;

    try {
      // Subscribe BEFORE invoking so we don't lose the first chunk.
      unlistenChunk = await listen<string>(`quality-fix:chunk:${runId}`, (event) => {
        setOutput((prev) => prev + event.payload);
      });
      unlistenDone = await listen<{ success: boolean; exit_code: number; duration_ms: number }>(
        `quality-fix:done:${runId}`,
        () => {
          // The done event is informational; the actual result comes
          // back through the awaited promise below. We just use this
          // to surface progress earlier if the promise is slow to
          // resolve.
        },
      );

      const result = await codeQualityRunFix(projectPath, fixer, runId);
      setLastResult(result);
      onComplete?.(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOutput((prev) => prev + `\n[error] ${msg}\n`);
      setLastResult({
        fixer,
        run_id: runId,
        success: false,
        exit_code: -1,
        duration_ms: 0,
        stdout_tail: "",
        stderr_tail: msg,
      });
    } finally {
      if (unlistenChunk) unlistenChunk();
      if (unlistenDone) unlistenDone();
      setRunning(false);
    }
  }

  const accent =
    variant === "purple" ? "text-accent-purple" :
    variant === "amber" ? "text-accent-amber" :
    variant === "danger" ? "text-accent-red" :
    variant === "green" ? "text-accent-green" :
    "text-accent-blue";

  const statusIcon = running ? (
    <Loader2 size={11} className={`${accent} animate-spin`} />
  ) : lastResult ? (
    lastResult.success ? (
      <span className={`text-[10px] ${accent}`}>OK</span>
    ) : (
      <AlertTriangle size={11} className="text-accent-red" />
    )
  ) : (
    <Wrench size={11} className={accent} />
  );

  return (
    <div className="flex flex-col gap-1.5 my-2">
      <div className="flex items-center gap-2">
        <Button
          variant={variant}
          size="xs"
          disabled={!enabled || running}
          onClick={() => setConfirmOpen(true)}
          title={!enabled ? disabledReason : description}
        >
          {statusIcon}
          <span>{label}</span>
        </Button>
        {badge && (
          <span className="text-[10px] text-text-muted bg-bg-elevated rounded px-1.5 py-0.5 border border-bg-border">
            {badge}
          </span>
        )}
        {lastResult && !running && (
          <span className="text-[10px] text-text-muted">
            {lastResult.success ? "done" : `exit ${lastResult.exit_code}`} &middot;{" "}
            {Math.round(lastResult.duration_ms / 100) / 10}s
          </span>
        )}
        {(output || lastResult) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {expanded ? "Hide output" : "Show output"}
          </button>
        )}
      </div>

      {expanded && (output || running) && (
        <pre
          ref={outputRef}
          className="text-[10px] leading-tight bg-bg-primary border border-bg-border rounded px-2 py-1.5 max-h-32 overflow-auto font-mono text-text-secondary whitespace-pre-wrap"
        >
          {output || (running ? "Starting…" : "")}
        </pre>
      )}

      {confirmOpen && (
        <Modal
          onClose={() => setConfirmOpen(false)}
          title={`Run ${label}?`}
          icon={<Wrench size={14} className={accent} />}
          width="w-[420px]"
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button variant={variant} size="sm" onClick={runFixer}>
                <Play size={11} />
                Run {label}
              </Button>
            </div>
          }
        >
          <div className="px-5 py-4 flex flex-col gap-3">
            <p className="text-xs text-text-secondary">{description}</p>
            {typeof fileCount === "number" && (
              <p className="text-[11px] text-text-muted">
                Estimated <span className="text-text-primary font-medium">{fileCount}</span> file
                {fileCount === 1 ? "" : "s"} may be modified.
              </p>
            )}
            <div className="text-[10px] text-text-muted bg-bg-primary border border-bg-border rounded px-2 py-1.5">
              This will modify files in <span className="text-text-secondary">{projectPath}</span>.
              Make sure your work is committed or stashed before continuing.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
