import { useMemo, useState } from "react";
import { ListChecks, AlertTriangle, ChevronDown, ChevronRight, FileText, ArrowRight } from "lucide-react";
import type { Flight, Milestone, Task, TaskHandoff } from "@/types/flight";
import { TASK_ROLE_CONFIG } from "@/lib/flight-colors";
import { useFlightStore } from "@/stores/flightStore";

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
  const [handoffExpanded, setHandoffExpanded] = useState(false);
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

  const hasHandoffLog = task.handoffLog && task.handoffLog.length > 0;
  const isBlocked = task.status === "blocked" && task.blockedReason;

  // File ownership collision detection — recomputes when flights change
  const flights = useFlightStore((s) => s.flights);
  const collisions = useMemo(() => {
    const flight = flights.find((f) => f.id === task.flightId);
    if (!flight) return [];
    const allTasks = flight.milestones.flatMap((m) => m.tasks);
    const thisTask = allTasks.find((t) => t.id === task.id);
    if (!thisTask?.ownedPaths?.length) return [];

    const activeTasks = allTasks.filter(
      (t) =>
        t.id !== task.id &&
        (t.status === "running" || t.status === "queued") &&
        t.ownedPaths?.length,
    );

    const conflicts: string[] = [];
    for (const other of activeTasks) {
      for (const path of thisTask.ownedPaths) {
        if (
          other.ownedPaths!.some(
            (op) => op === path || path.startsWith(op + "/") || op.startsWith(path + "/"),
          )
        ) {
          conflicts.push(`${path} (owned by "${other.title}")`);
        }
      }
    }
    return conflicts;
  }, [flights, task.flightId, task.id]);
  const hasCollisions = collisions.length > 0;

  return (
    <div className="px-2.5 py-1">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor[task.status] ?? "bg-text-muted"}`} />
        <span className="text-[11px] text-text-secondary truncate flex-1">{task.title}</span>
        {hasCollisions && (
          <span title={collisions.join("\n")}>
            <AlertTriangle size={10} className="text-accent-red shrink-0" />
          </span>
        )}
        <span className={`text-[9px] px-1 py-0.5 rounded ${TASK_ROLE_CONFIG[task.role ?? "builder"].color} bg-current/10`}>
          {TASK_ROLE_CONFIG[task.role ?? "builder"].label}
        </span>
        <span className="text-[9px] text-text-muted">{task.agentConfigId}</span>
        <span className="text-[10px] text-text-muted uppercase">{task.type}</span>
      </div>

      {hasCollisions && (
        <div className="flex items-start gap-1.5 mt-1 ml-3.5 px-2 py-1 rounded bg-accent-red/10 border border-accent-red/30">
          <AlertTriangle size={10} className="text-accent-red shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-accent-red font-medium">File ownership collision</span>
            {collisions.map((c, i) => (
              <span key={i} className="text-[9px] text-accent-red/80">{c}</span>
            ))}
          </div>
        </div>
      )}

      {isBlocked && (
        <div className="flex items-start gap-1.5 mt-1 ml-3.5 px-2 py-1 rounded bg-accent-amber/10 border border-accent-amber/30">
          <AlertTriangle size={10} className="text-accent-amber shrink-0 mt-0.5" />
          <span className="text-[10px] text-accent-amber">{task.blockedReason}</span>
        </div>
      )}

      {hasHandoffLog && (
        <div className="mt-1 ml-3.5">
          <button
            onClick={() => setHandoffExpanded(!handoffExpanded)}
            className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary"
          >
            {handoffExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Handoff log ({task.handoffLog!.length})
          </button>
          {handoffExpanded && (
            <div className="mt-1 space-y-1">
              {task.handoffLog!.map((h, idx) => (
                <HandoffEntry key={idx} handoff={h} index={idx} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HandoffEntry({ handoff, index }: { handoff: TaskHandoff; index: number }) {
  return (
    <div className="border border-bg-border rounded bg-bg-secondary px-2 py-1.5">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[9px] text-text-muted font-mono">#{index + 1}</span>
        <span className="text-[10px] text-text-secondary">{handoff.summary}</span>
      </div>
      <div className="flex items-center gap-3 text-[9px] text-text-muted">
        {handoff.filesChanged.length > 0 && (
          <span className="flex items-center gap-0.5">
            <FileText size={8} />
            {handoff.filesChanged.length} file{handoff.filesChanged.length !== 1 ? "s" : ""} changed
          </span>
        )}
        {handoff.followUps.length > 0 && (
          <span className="flex items-center gap-0.5">
            <ArrowRight size={8} />
            {handoff.followUps.length} follow-up{handoff.followUps.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
