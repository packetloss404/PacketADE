import { useMemo } from "react";
import { Clock } from "lucide-react";
import { relativeTime } from "@/lib/time";
import type { Flight } from "@/types/flight";

interface TimelineTileProps {
  flight: Flight;
}

interface TimelineEvent {
  at: number;
  label: string;
  kind: "flight" | "task_started" | "task_completed";
}

export function TimelineTile({ flight }: TimelineTileProps) {
  const events = useMemo<TimelineEvent[]>(() => {
    const out: TimelineEvent[] = [];
    out.push({ at: flight.createdAt, label: "Mission created", kind: "flight" });
    if (flight.updatedAt && flight.updatedAt !== flight.createdAt) {
      out.push({ at: flight.updatedAt, label: "Mission updated", kind: "flight" });
    }
    if (flight.completedAt) {
      out.push({ at: flight.completedAt, label: "Mission completed", kind: "flight" });
    }
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        if (t.startedAt) {
          out.push({ at: t.startedAt, label: `Started: ${t.title}`, kind: "task_started" });
        }
        if (t.completedAt) {
          out.push({ at: t.completedAt, label: `Completed: ${t.title}`, kind: "task_completed" });
        }
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [flight]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <Clock size={12} className="text-accent-purple" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Timeline
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {events.length === 0 ? (
          <p className="text-[10px] text-text-muted py-1">No timeline events yet.</p>
        ) : (
          <div className="space-y-1.5">
            {events.slice(0, 20).map((e, i) => {
              const dot =
                e.kind === "task_completed"
                  ? "bg-accent-green"
                  : e.kind === "task_started"
                    ? "bg-accent-blue"
                    : "bg-accent-purple";
              return (
                <div key={i} className="flex items-start gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dot}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-text-secondary truncate">{e.label}</p>
                    <p className="text-[10px] text-text-muted">{relativeTime(e.at)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
