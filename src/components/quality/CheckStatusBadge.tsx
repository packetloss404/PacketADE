import { CheckCircle2, CircleAlert, CircleSlash, Loader2, Square, XCircle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Status badge for a per-check diagnostics run. Lives in its own file so
 * `CodeQualityCheckPanel` can stay a pure component module (react-refresh
 * insists that mixed-export files break fast refresh).
 *
 * The full status state machine for a quality check:
 *
 *   idle  → queued → running →  passed
 *                                failed
 *                                cancelled
 *                                errored   (e.g. spawn failure)
 *   skipped  (configured-off / unavailable on this platform)
 */
export type CheckStatus =
  | "idle"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "errored";

interface BadgeMeta {
  label: string;
  cls: string;
  icon: ReactNode;
}

const BADGE_MAP: Record<CheckStatus, BadgeMeta> = {
  idle: {
    label: "Idle",
    cls: "text-text-muted border-text-muted/30 bg-text-muted/5",
    icon: <CircleSlash size={9} />,
  },
  queued: {
    label: "Queued",
    cls: "text-text-secondary border-text-secondary/30 bg-text-secondary/5",
    icon: <CircleSlash size={9} />,
  },
  running: {
    label: "Running",
    cls: "text-accent-blue border-accent-blue/40 bg-accent-blue/10",
    icon: <Loader2 size={9} className="animate-spin" />,
  },
  passed: {
    label: "Passed",
    cls: "text-accent-green border-accent-green/40 bg-accent-green/10",
    icon: <CheckCircle2 size={9} />,
  },
  failed: {
    label: "Failed",
    cls: "text-accent-red border-accent-red/40 bg-accent-red/10",
    icon: <XCircle size={9} />,
  },
  cancelled: {
    label: "Cancelled",
    cls: "text-text-muted border-text-muted/30 bg-text-muted/5",
    icon: <Square size={9} />,
  },
  skipped: {
    label: "Skipped",
    cls: "text-text-muted border-text-muted/30 bg-text-muted/5",
    icon: <CircleSlash size={9} />,
  },
  errored: {
    label: "Errored",
    cls: "text-accent-red border-accent-red/40 bg-accent-red/10",
    icon: <CircleAlert size={9} />,
  },
};

export function CheckStatusBadge({ status }: { status: CheckStatus }) {
  const meta = BADGE_MAP[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-medium uppercase tracking-wide ${meta.cls}`}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}
