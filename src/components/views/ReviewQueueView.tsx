import { useMemo } from "react";
import { ShieldCheck, ShieldX, Clock, CheckCircle, XCircle } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { useOrchestrationStateStore } from "@/stores/orchestrationStateStore";
import type { Task, Flight, Milestone } from "@/types/flight";

interface ApprovalItem {
  flight: Flight;
  milestone: Milestone;
  task: Task;
}

function formatWaitTime(startedAt: number | undefined): string {
  if (!startedAt) return "unknown";
  const minutes = Math.round((Date.now() - startedAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) return remainingMins > 0 ? `${hours}h ${remainingMins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ReviewQueueView() {
  const flights = useFlightStore((s) => s.flights);

  const approvalItems = useMemo<ApprovalItem[]>(() => {
    const items: ApprovalItem[] = [];
    for (const flight of flights) {
      for (const milestone of flight.milestones) {
        for (const task of milestone.tasks) {
          if (task.status === "approval_needed") {
            items.push({ flight, milestone, task });
          }
        }
      }
    }
    // Sort oldest first
    items.sort((a, b) => (a.task.startedAt ?? 0) - (b.task.startedAt ?? 0));
    return items;
  }, [flights]);

  function handleApprove(taskId: string) {
    useOrchestrationStateStore.getState().onTaskApprovalResolved(taskId);
  }

  function handleDeny(item: ApprovalItem) {
    useFlightStore.getState().updateTask(
      item.flight.id,
      item.milestone.id,
      item.task.id,
      { status: "cancelled" },
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-bg-border">
        <ShieldCheck size={14} className="text-accent-amber" />
        <h2 className="text-xs font-semibold text-text-primary">Review Queue</h2>
        {approvalItems.length > 0 && (
          <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-accent-amber/20 text-accent-amber">
            {approvalItems.length}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {approvalItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted">
            <ShieldCheck size={32} className="opacity-40" />
            <p className="text-xs">No pending approvals</p>
            <p className="text-[11px] text-text-muted/60">
              Tasks requiring approval will appear here
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {approvalItems.map((item) => (
              <div
                key={item.task.id}
                className="flex items-center gap-3 px-3 py-2.5 bg-bg-elevated rounded-lg border border-bg-border hover:border-accent-amber/30 transition-colors"
              >
                {/* Icon */}
                <ShieldX size={14} className="text-accent-amber flex-shrink-0" />

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-primary font-medium truncate">
                      {item.task.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-text-secondary truncate">
                      {item.flight.title}
                    </span>
                    <span className="text-[10px] text-text-muted">/</span>
                    <span className="text-[11px] text-text-muted truncate">
                      {item.milestone.title}
                    </span>
                  </div>
                </div>

                {/* Agent */}
                <span className="text-[10px] text-text-muted bg-bg-primary px-1.5 py-0.5 rounded flex-shrink-0">
                  {item.task.agentConfigId}
                </span>

                {/* Wait time */}
                <div className="flex items-center gap-1 text-[11px] text-text-muted flex-shrink-0">
                  <Clock size={10} />
                  <span>{formatWaitTime(item.task.startedAt)}</span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => handleApprove(item.task.id)}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
                    title="Approve"
                  >
                    <CheckCircle size={12} />
                    <span>Approve</span>
                  </button>
                  <button
                    onClick={() => handleDeny(item)}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-red hover:bg-accent-red/10 rounded transition-colors"
                    title="Deny"
                  >
                    <XCircle size={12} />
                    <span>Deny</span>
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
