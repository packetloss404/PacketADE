import { Play, CheckCircle2, XCircle, ArrowRight, Eye, AlertTriangle, Zap, ShieldAlert } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { relativeTime } from "@/lib/time";
import type { Flight, CoordinationEvent, CoordinationEventType } from "@/types/flight";

const eventConfig: Record<CoordinationEventType, { icon: typeof Play; color: string; label: string }> = {
  task_started: { icon: Play, color: "text-accent-blue", label: "Started" },
  task_completed: { icon: CheckCircle2, color: "text-accent-green", label: "Completed" },
  task_failed: { icon: XCircle, color: "text-accent-red", label: "Failed" },
  handoff: { icon: ArrowRight, color: "text-accent-purple", label: "Handoff" },
  review_requested: { icon: Eye, color: "text-accent-amber", label: "Review" },
  review_resolved: { icon: CheckCircle2, color: "text-accent-green", label: "Resolved" },
  collision_warning: { icon: AlertTriangle, color: "text-accent-amber", label: "Collision" },
  escalation: { icon: ShieldAlert, color: "text-accent-red", label: "Escalation" },
};

function EventRow({ event }: { event: CoordinationEvent }) {
  const config = eventConfig[event.type];
  const Icon = config.icon;

  return (
    <div className="flex items-start gap-2 py-1.5 px-3">
      {/* Timeline dot */}
      <div className="flex flex-col items-center pt-0.5">
        <div className={`rounded-full p-0.5 ${config.color}`}>
          <Icon size={10} />
        </div>
        <div className="w-px flex-1 bg-bg-border mt-1" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className={`font-medium ${config.color}`}>{config.label}</span>
          {event.taskTitle && (
            <span className="text-text-secondary truncate">{event.taskTitle}</span>
          )}
          <span className="text-text-muted ml-auto flex-shrink-0">
            {relativeTime(event.timestamp)}
          </span>
        </div>
        <p className="text-[10px] text-text-muted mt-0.5 leading-tight">{event.summary}</p>
      </div>
    </div>
  );
}

interface CoordinationFeedProps {
  flight: Flight;
}

export function CoordinationFeed({ flight }: CoordinationFeedProps) {
  const log = useFlightStore((s) => s.getCoordinationLog)(flight.id);

  if (log.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-[11px] text-text-muted">
        <Zap size={12} className="mr-1.5" />
        No coordination events yet
      </div>
    );
  }

  // Reverse chronological order
  const sorted = [...log].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="divide-y divide-bg-border">
      {sorted.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </div>
  );
}
