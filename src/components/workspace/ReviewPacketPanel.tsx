import { useMemo } from "react";
import { X, ShieldAlert, ShieldCheck, ExternalLink, FileDiff } from "lucide-react";
import type { Flight, Task, ReviewPacket, TaskStatus } from "@/types/flight";
import type { FlightReviewTaskRef } from "@/lib/flightReview";

/**
 * N4: surfaces the flight `ReviewPacket`(s) behind the changed files in
 * GitDashboard. The authoritative diff stays the git diff (GitDashboard's
 * `openDiff`); this panel shows the agent's *account* of a linked task — its
 * review summary, type, command, and reported diff — plus the task's approval
 * status, and deep-links into the flight where the approve/reject action lives.
 * It deliberately does NOT relocate the (session-scoped) approval action.
 */

interface ResolvedTask {
  flight: Flight;
  task: Task;
  packet?: ReviewPacket;
}

function resolveTasks(flights: Flight[], refs: FlightReviewTaskRef[]): ResolvedTask[] {
  const seen = new Set<string>();
  const out: ResolvedTask[] = [];
  for (const ref of refs) {
    const key = `${ref.flightId}:${ref.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const flight = flights.find((f) => f.id === ref.flightId);
    if (!flight) continue;
    let task: Task | undefined;
    for (const milestone of flight.milestones) {
      task = milestone.tasks.find((t) => t.id === ref.taskId);
      if (task) break;
    }
    if (!task) continue;
    out.push({ flight, task, packet: task.reviewPacket });
  }
  return out;
}

const REVIEW_TYPE_LABEL: Record<ReviewPacket["reviewType"], string> = {
  tool_call: "Tool call",
  file_write: "File write",
  command: "Command",
  milestone_gate: "Milestone gate",
};

function statusLabel(status: TaskStatus): string {
  return status.replace(/_/g, " ");
}

function isPendingApproval(status: TaskStatus): boolean {
  return status === "approval_needed";
}

/** Render a unified-diff string as lightweight colored lines (no new deps). */
function DiffPreview({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.replace(/\n$/, "").split("\n"), [diff]);
  return (
    <pre className="mt-1 max-h-64 overflow-auto rounded border border-bg-border bg-bg-primary p-2 font-mono text-meta leading-relaxed">
      {lines.map((line, i) => {
        let cls = "text-text-muted";
        if (line.startsWith("@@")) cls = "text-accent-blue";
        else if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-accent-green";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-accent-red";
        else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
          cls = "text-text-secondary";
        return (
          <div key={i} className={`whitespace-pre ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export interface ReviewPacketPanelProps {
  refs: FlightReviewTaskRef[];
  flights: Flight[];
  onOpenFlight: (flightId: string) => void;
  onClose: () => void;
  /** Session ids with a live pending approval prompt, so the panel can offer a
   *  deep-link to where the (session-scoped) approve/reject actually happens. */
  pendingApprovalSessionIds?: Set<string>;
  /** Deep-link to the conversation tile owning a live approval prompt. */
  onOpenApproval?: (conversationId: string) => void;
  /** Open the authoritative working-tree diff for a packet-linked file. */
  onOpenDiff?: (filePath: string) => void;
}

export function ReviewPacketPanel({
  refs,
  flights,
  onOpenFlight,
  onClose,
  pendingApprovalSessionIds,
  onOpenApproval,
  onOpenDiff,
}: ReviewPacketPanelProps) {
  const resolved = useMemo(() => resolveTasks(flights, refs), [flights, refs]);
  const paths = useMemo(() => [...new Set(refs.map((r) => r.filePath))], [refs]);
  const headerLabel =
    paths.length === 1 ? paths[0] : paths.length > 1 ? `${paths.length} files` : undefined;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg-primary">
      <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-2">
        <ShieldCheck size={12} className="shrink-0 text-accent-amber" />
        <span className="truncate text-ui font-semibold text-text-primary" title={headerLabel}>
          Flight review{headerLabel ? ` — ${headerLabel}` : ""}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
          aria-label="Close review"
          title="Close review (Esc)"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-auto px-2 py-2">
        {resolved.length === 0 && (
          <div className="px-2 py-6 text-center text-ui text-text-muted">
            The linked flight or task is no longer available.
          </div>
        )}

        {resolved.map(({ flight, task, packet }) => {
          const pending = isPendingApproval(task.status);
          return (
            <div
              key={`${flight.id}:${task.id}`}
              className={`rounded border px-2.5 py-2 ${
                pending
                  ? "border-accent-amber/30 bg-accent-amber/5"
                  : "border-bg-border bg-bg-secondary"
              }`}
            >
              <div className="flex items-center gap-1.5">
                {pending ? (
                  <ShieldAlert size={11} className="shrink-0 text-accent-amber" />
                ) : (
                  <ShieldCheck size={11} className="shrink-0 text-text-muted" />
                )}
                <span className="truncate text-ui font-medium text-text-primary" title={task.title}>
                  {task.title || "Untitled task"}
                </span>
                <span
                  className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-meta ${
                    pending
                      ? "bg-accent-amber/15 text-accent-amber"
                      : "bg-bg-primary text-text-muted"
                  }`}
                >
                  {statusLabel(task.status)}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-text-muted">
                <span className="truncate" title={flight.title}>
                  {flight.title || "Untitled flight"}
                </span>
                {packet && (
                  <span className="rounded bg-bg-primary px-1 py-0.5 text-text-secondary">
                    {REVIEW_TYPE_LABEL[packet.reviewType]}
                  </span>
                )}
              </div>

              {packet?.summary && (
                <p className="mt-1.5 whitespace-pre-wrap text-ui leading-relaxed text-text-secondary">
                  {packet.summary}
                </p>
              )}

              {packet?.command && (
                <pre className="mt-1.5 overflow-auto rounded border border-bg-border bg-bg-primary p-2 font-mono text-meta text-text-secondary">
                  {packet.command}
                </pre>
              )}

              {packet?.diff && (
                <div className="mt-1.5">
                  <div className="flex items-center gap-1 text-meta text-text-muted">
                    <FileDiff size={9} className="shrink-0" />
                    Agent-reported diff
                  </div>
                  <DiffPreview diff={packet.diff} />
                </div>
              )}

              {!packet && (
                <p className="mt-1.5 text-meta text-text-muted">
                  No review packet recorded for this task yet.
                </p>
              )}

              {(() => {
                const sessionId = packet?.sessionId ?? task.sessionId ?? undefined;
                const liveApproval = !!(sessionId && pendingApprovalSessionIds?.has(sessionId));
                return (
                  <div className="mt-2 flex items-center justify-end gap-3">
                    {pending && !liveApproval && (
                      <span className="mr-auto text-meta text-text-muted">
                        Approval prompt not active in this session.
                      </span>
                    )}
                    {liveApproval && onOpenApproval && sessionId && (
                      <button
                        type="button"
                        onClick={() => onOpenApproval(sessionId)}
                        className="hover:bg-accent-amber/25 bg-accent-amber/15 inline-flex items-center gap-1 rounded px-2 py-0.5 text-ui font-medium text-accent-amber transition-colors"
                      >
                        <ShieldAlert size={10} className="shrink-0" />
                        Go to approval
                      </button>
                    )}
                    {onOpenDiff && (packet?.filePaths[0] ?? refs[0]?.filePath) && (
                      <button
                        type="button"
                        onClick={() => onOpenDiff(packet?.filePaths[0] ?? refs[0].filePath)}
                        className="inline-flex items-center gap-1 text-ui text-text-secondary transition-colors hover:text-text-primary"
                      >
                        <FileDiff size={10} className="shrink-0" />
                        Open diff
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenFlight(flight.id)}
                      className="inline-flex items-center gap-1 text-ui text-text-secondary transition-colors hover:text-text-primary"
                    >
                      <ExternalLink size={10} className="shrink-0" />
                      Open flight
                    </button>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
