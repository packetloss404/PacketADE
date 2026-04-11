import { useMemo } from "react";
import { ShieldX, CheckCircle, XCircle, Clock } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { relativeTime } from "@/lib/time";
import type { Flight, Task, Milestone } from "@/types/flight";

interface ApprovalsTileProps {
  flight: Flight;
}

interface PendingItem {
  task: Task;
  milestone: Milestone;
}

export function ApprovalsTile({ flight }: ApprovalsTileProps) {
  const pending = useMemo<PendingItem[]>(() => {
    const out: PendingItem[] = [];
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        if (t.status === "approval_needed") out.push({ task: t, milestone: m });
      }
    }
    out.sort((a, b) => (a.task.startedAt ?? 0) - (b.task.startedAt ?? 0));
    return out;
  }, [flight.milestones]);

  function handleApprove(taskId: string) {
    void useOrchestrationStore.getState().onTaskApprovalResolved(taskId);
  }

  function handleDeny(item: PendingItem) {
    useFlightStore.getState().updateTask(
      flight.id,
      item.milestone.id,
      item.task.id,
      { status: "cancelled" },
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <ShieldX size={12} className="text-accent-amber" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Approvals
        </span>
        <span className="text-[10px] text-text-muted">({pending.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {pending.length === 0 ? (
          <p className="text-[10px] text-text-muted py-1">No pending approvals.</p>
        ) : (
          <div className="space-y-1.5">
            {pending.map(({ task, milestone }) => (
              <div
                key={task.id}
                className="flex items-start gap-2 px-2 py-1.5 bg-bg-elevated border border-bg-border rounded"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-text-primary truncate">{task.title}</p>
                  <p className="text-[10px] text-text-muted truncate">{milestone.title}</p>
                  <p className="flex items-center gap-1 text-[10px] text-text-muted mt-0.5">
                    <Clock size={9} />
                    {task.startedAt ? relativeTime(task.startedAt) : "waiting"}
                  </p>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => handleApprove(task.id)}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
                    title="Approve"
                  >
                    <CheckCircle size={10} />
                    Approve
                  </button>
                  <button
                    onClick={() => handleDeny({ task, milestone })}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-accent-red hover:bg-accent-red/10 rounded transition-colors"
                    title="Deny"
                  >
                    <XCircle size={10} />
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
