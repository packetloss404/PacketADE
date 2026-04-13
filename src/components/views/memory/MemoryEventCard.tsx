import { Terminal, CheckCircle, XCircle, Rocket, Trash2, Clock } from "lucide-react";
import { relativeTime } from "@/lib/time";
import type { MemoryEvent } from "@/types/memory";

interface MemoryEventCardProps {
  event: MemoryEvent;
  onDelete: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function MemoryEventCard({ event, onDelete }: MemoryEventCardProps) {
  return (
    <div className="border border-bg-border rounded bg-bg-secondary hover:border-bg-hover transition-colors group">
      {event.type === "session_completed" && (
        <SessionCard event={event} />
      )}
      {event.type === "task_completed" && (
        <TaskCard event={event} />
      )}
      {event.type === "flight_completed" && (
        <FlightCard event={event} />
      )}
      {/* Footer: timestamp + delete */}
      <div className="flex items-center justify-between px-3 py-1 border-t border-bg-border">
        <div className="flex items-center gap-1.5 text-[9px] text-text-muted">
          <Clock size={9} />
          {relativeTime(event.timestamp)}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-all"
          title="Delete event"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}

function SessionCard({ event }: { event: Extract<MemoryEvent, { type: "session_completed" }> }) {
  const p = event.payload;
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <Terminal size={12} className="text-accent-green flex-shrink-0" />
        <span className="text-[11px] font-medium text-text-primary">{p.agentId}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
          p.status === "done" ? "bg-accent-green/15 text-accent-green" :
          p.status === "error" ? "bg-accent-red/15 text-accent-red" :
          "bg-text-muted/15 text-text-muted"
        }`}>
          {p.status}
        </span>
        <span className="text-[10px] text-text-muted">{formatDuration(p.durationMs)}</span>
      </div>
      {p.summary && (
        <p className="text-[10px] text-text-secondary mt-1 line-clamp-2">{p.summary}</p>
      )}
      {p.filesModified.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.filesModified.slice(0, 5).map((f, i) => (
            <span key={i} className="text-[9px] font-mono text-text-muted bg-bg-primary px-1.5 py-0.5 rounded">{f}</span>
          ))}
          {p.filesModified.length > 5 && (
            <span className="text-[9px] text-text-muted">+{p.filesModified.length - 5} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function TaskCard({ event }: { event: Extract<MemoryEvent, { type: "task_completed" }> }) {
  const p = event.payload;
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        {p.success ? (
          <CheckCircle size={12} className="text-accent-green flex-shrink-0" />
        ) : (
          <XCircle size={12} className="text-accent-red flex-shrink-0" />
        )}
        <span className="text-[11px] font-medium text-text-primary truncate">{p.taskTitle}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
          p.success ? "bg-accent-green/15 text-accent-green" : "bg-accent-red/15 text-accent-red"
        }`}>
          {p.success ? "passed" : "failed"}
        </span>
        <span className="text-[10px] text-text-muted">{formatDuration(p.durationMs)}</span>
      </div>
      <div className="text-[10px] text-text-muted mb-1">
        Flight: {p.flightTitle}
      </div>
      {p.summary && (
        <p className="text-[10px] text-text-secondary line-clamp-2">{p.summary}</p>
      )}
      {p.errors.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {p.errors.slice(0, 3).map((err, i) => (
            <p key={i} className="text-[10px] text-accent-red line-clamp-1">{err}</p>
          ))}
        </div>
      )}
      {p.filesChanged.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.filesChanged.slice(0, 5).map((f, i) => (
            <span key={i} className="text-[9px] font-mono text-text-muted bg-bg-primary px-1.5 py-0.5 rounded">{f}</span>
          ))}
          {p.filesChanged.length > 5 && (
            <span className="text-[9px] text-text-muted">+{p.filesChanged.length - 5} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function FlightCard({ event }: { event: Extract<MemoryEvent, { type: "flight_completed" }> }) {
  const p = event.payload;
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <Rocket size={12} className="text-accent-purple flex-shrink-0" />
        <span className="text-[11px] font-medium text-text-primary">{p.flightTitle}</span>
      </div>
      <p className="text-[10px] text-text-secondary mb-1.5">{p.summary}</p>
      {p.lessonsLearned.length > 0 && (
        <div className="mb-1.5">
          <span className="text-[9px] font-semibold text-text-secondary uppercase tracking-wide">Lessons</span>
          <ul className="mt-0.5 space-y-0.5">
            {p.lessonsLearned.map((l, i) => (
              <li key={i} className="text-[10px] text-text-secondary pl-2 border-l-2 border-accent-purple/30">{l}</li>
            ))}
          </ul>
        </div>
      )}
      {p.whatWorked.length > 0 && (
        <div className="mb-1.5">
          <span className="text-[9px] font-semibold text-accent-green uppercase tracking-wide">Worked</span>
          <ul className="mt-0.5 space-y-0.5">
            {p.whatWorked.slice(0, 3).map((w, i) => (
              <li key={i} className="text-[10px] text-text-muted line-clamp-1">{w}</li>
            ))}
          </ul>
        </div>
      )}
      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.tags.map((t, i) => (
            <span key={i} className="text-[9px] text-accent-purple bg-accent-purple/10 px-1.5 py-0.5 rounded">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}
