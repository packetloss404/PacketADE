import { ListChecks } from "lucide-react";
import type { Flight, Milestone, Task } from "@/types/flight";

interface MilestonesPanelProps {
  flight: Flight;
}

export function MilestonesPanel({ flight }: MilestonesPanelProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <ListChecks size={12} className="text-accent-green" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Milestones
        </span>
        <span className="text-[10px] text-text-muted">({flight.milestones.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {flight.milestones.length === 0 ? (
          <p className="text-[10px] text-text-muted py-1">No milestones defined yet.</p>
        ) : (
          <div className="space-y-2">
            {flight.milestones.map((m) => (
              <MilestoneItem key={m.id} milestone={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MilestoneItem({ milestone }: { milestone: Milestone }) {
  const statusColor = {
    pending: "bg-text-muted",
    active: "bg-accent-blue",
    done: "bg-accent-green",
    failed: "bg-accent-red",
  }[milestone.status];

  const doneCount = milestone.tasks.filter((t) => t.status === "done").length;

  return (
    <div className="border border-bg-border rounded bg-bg-elevated">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-bg-border">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
        <span className="text-xs text-text-primary flex-1 truncate">{milestone.title}</span>
        <span className="text-[10px] text-text-muted">
          {doneCount}/{milestone.tasks.length}
        </span>
      </div>
      {milestone.tasks.length === 0 ? (
        <p className="text-[10px] text-text-muted px-2.5 py-1.5">No tasks.</p>
      ) : (
        <div className="divide-y divide-bg-border">
          {milestone.tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const statusColor: Record<string, string> = {
    pending: "bg-text-muted",
    blocked: "bg-accent-red",
    queued: "bg-accent-blue",
    running: "bg-accent-blue animate-pulse",
    approval_needed: "bg-accent-amber",
    paused: "bg-text-muted",
    done: "bg-accent-green",
    failed: "bg-accent-red",
    cancelled: "bg-text-muted",
  };
  return (
    <div className="flex items-center gap-2 px-2.5 py-1">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor[task.status] ?? "bg-text-muted"}`} />
      <span className="text-[11px] text-text-secondary truncate flex-1">{task.title}</span>
      <span className="text-[9px] text-text-muted">{task.agentConfigId}</span>
      <span className="text-[10px] text-text-muted uppercase">{task.type}</span>
    </div>
  );
}
