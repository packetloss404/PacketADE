import { useMemo, useState, useEffect } from "react";
import { Target, Clock, ListChecks, Users, Flag, Activity, ChevronDown } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { useIssueStore } from "@/stores/issueStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useActivityStore } from "@/stores/activityStore";
import { relativeTime } from "@/lib/time";
import {
  FLIGHT_STATUS_CONFIG,
  FLIGHT_PRIORITY_COLORS,
  ISSUE_STATUS_COLORS,
  ISSUE_STATUS_LABELS,
} from "@/lib/flight-colors";
import type { Flight, Milestone, Task } from "@/types/flight";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MissionWorkspaceView() {
  const flights = useFlightStore((s) => s.flights);
  const activeFlightId = useFlightStore((s) => s.activeFlightId);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);

  // Default selector: activeFlightId, else first active-status flight, else first flight
  const defaultId = useMemo(() => {
    if (activeFlightId && flights.some((f) => f.id === activeFlightId)) return activeFlightId;
    const active = flights.find((f) => f.status === "active");
    if (active) return active.id;
    return flights[0]?.id ?? null;
  }, [flights, activeFlightId]);

  const [selectedId, setSelectedId] = useState<string | null>(defaultId);

  useEffect(() => {
    if (!selectedId && defaultId) setSelectedId(defaultId);
  }, [defaultId, selectedId]);

  const flight = useMemo(
    () => flights.find((f) => f.id === selectedId) ?? null,
    [flights, selectedId]
  );

  if (flights.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bg-primary">
        <div className="text-center max-w-md">
          <Target size={40} className="mx-auto text-text-muted mb-3" />
          <h2 className="text-sm font-semibold text-text-primary mb-1">No mission selected</h2>
          <p className="text-xs text-text-secondary">
            Create a flight first to open its mission workspace.
          </p>
        </div>
      </div>
    );
  }

  if (!flight) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bg-primary">
        <p className="text-xs text-text-muted">Select a flight…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 h-full overflow-hidden bg-bg-primary">
      <MissionHeader
        flight={flight}
        allFlights={flights}
        onSelect={(id) => {
          setSelectedId(id);
          setActiveFlight(id);
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Left column — milestones + issues */}
        <div className="flex flex-col flex-1 overflow-y-auto border-r border-bg-border">
          <MilestonesPanel flight={flight} />
          <LinkedIssuesPanel flight={flight} />
        </div>

        {/* Right column — timeline, sessions, activity */}
        <div className="flex flex-col w-[340px] min-w-[340px] overflow-y-auto">
          <TimelinePanel flight={flight} />
          <SessionsPanel flight={flight} />
          <ActivityLogPanel flight={flight} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function MissionHeader({
  flight,
  allFlights,
  onSelect,
}: {
  flight: Flight;
  allFlights: Flight[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sc = FLIGHT_STATUS_CONFIG[flight.status];
  const pc = FLIGHT_PRIORITY_COLORS[flight.priority];

  const progress = useMemo(() => {
    const tasks = flight.milestones.flatMap((m) => m.tasks);
    return {
      done: tasks.filter((t) => t.status === "done").length,
      total: tasks.length,
    };
  }, [flight]);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-bg-border bg-bg-secondary">
      <Target size={16} className="text-accent-green shrink-0" />
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setOpen(!open)}
              className="flex items-center gap-1 text-sm font-semibold text-text-primary hover:text-accent-green transition-colors"
            >
              <span className="truncate max-w-[360px]">{flight.title || "Untitled Mission"}</span>
              <ChevronDown size={12} className="text-text-muted" />
            </button>
            {open && (
              <div className="absolute top-full left-0 mt-1 w-72 max-h-80 overflow-y-auto bg-bg-elevated border border-bg-border rounded shadow-xl z-30 py-1">
                {allFlights.map((f) => {
                  const fsc = FLIGHT_STATUS_CONFIG[f.status];
                  return (
                    <button
                      key={f.id}
                      onClick={() => {
                        onSelect(f.id);
                        setOpen(false);
                      }}
                      className={`flex items-center gap-2 w-full text-left px-2 py-1.5 text-[11px] hover:bg-bg-hover transition-colors ${
                        f.id === flight.id ? "text-accent-green" : "text-text-secondary"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${fsc.dot}`} />
                      <span className="truncate flex-1">{f.title || "Untitled"}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${sc.bg} ${sc.text}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
            {sc.label}
          </span>
          <span className={`inline-flex items-center gap-1 text-[10px] ${pc}`}>
            <Flag size={10} />
            {flight.priority}
          </span>
        </div>
        {flight.objective && (
          <p className="text-[11px] text-text-secondary truncate mt-0.5">{flight.objective}</p>
        )}
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className="text-[10px] text-text-muted">
          {progress.done} / {progress.total} tasks done
        </span>
        <span className="text-[10px] text-text-muted">Updated {relativeTime(flight.updatedAt)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Milestones panel
// ---------------------------------------------------------------------------

function MilestonesPanel({ flight }: { flight: Flight }) {
  return (
    <div className="px-4 py-3 border-b border-bg-border">
      <div className="flex items-center gap-2 mb-2">
        <ListChecks size={12} className="text-accent-green" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Milestones & Tasks
        </span>
        <span className="text-[10px] text-text-muted">({flight.milestones.length})</span>
      </div>
      {flight.milestones.length === 0 ? (
        <p className="text-[10px] text-text-muted py-2">No milestones defined yet.</p>
      ) : (
        <div className="space-y-3">
          {flight.milestones.map((m) => (
            <MilestoneItem key={m.id} milestone={m} />
          ))}
        </div>
      )}
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

  return (
    <div className="border border-bg-border rounded bg-bg-secondary">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-bg-border">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
        <span className="text-xs text-text-primary flex-1 truncate">{milestone.title}</span>
        <span className="text-[10px] text-text-muted">
          {milestone.tasks.filter((t) => t.status === "done").length}/{milestone.tasks.length}
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
      <span className="text-[10px] text-text-muted uppercase">{task.type}</span>
      <span className="text-[10px] text-text-muted">{task.status}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linked Issues
// ---------------------------------------------------------------------------

function LinkedIssuesPanel({ flight }: { flight: Flight }) {
  const issues = useIssueStore((s) => s.issues);
  const linked = useMemo(
    () => issues.filter((i) => flight.issueIds.includes(i.id)),
    [issues, flight.issueIds]
  );

  return (
    <div className="px-4 py-3 border-b border-bg-border">
      <div className="flex items-center gap-2 mb-2">
        <Flag size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Linked Issues
        </span>
        <span className="text-[10px] text-text-muted">({linked.length})</span>
      </div>
      {linked.length === 0 ? (
        <p className="text-[10px] text-text-muted py-2">No issues linked to this mission.</p>
      ) : (
        <div className="space-y-0.5">
          {linked.map((issue) => {
            const color = ISSUE_STATUS_COLORS[issue.status] ?? "bg-text-muted";
            return (
              <div key={issue.id} className="flex items-center gap-2 py-1">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color}`} />
                <span className="text-[10px] text-text-muted font-mono w-14 shrink-0">
                  {issue.ticketId}
                </span>
                <span className="text-xs text-text-primary truncate flex-1">{issue.title}</span>
                <span className="text-[10px] text-text-muted">{ISSUE_STATUS_LABELS[issue.status]}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface TimelineEvent {
  at: number;
  label: string;
  kind: "flight" | "task_started" | "task_completed";
}

function TimelinePanel({ flight }: { flight: Flight }) {
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
    <div className="px-4 py-3 border-b border-bg-border">
      <div className="flex items-center gap-2 mb-2">
        <Clock size={12} className="text-accent-purple" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Timeline
        </span>
      </div>
      {events.length === 0 ? (
        <p className="text-[10px] text-text-muted py-2">No timeline events yet.</p>
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
  );
}

// ---------------------------------------------------------------------------
// Sessions panel
// ---------------------------------------------------------------------------

function SessionsPanel({ flight }: { flight: Flight }) {
  const panes = useLayoutStore((s) => s.panes);

  const sessions = useMemo(() => {
    return flight.linkedSessionIds.map((sid) => {
      const pane = panes.find((p) => p.sessionId === sid);
      return { sessionId: sid, pane };
    });
  }, [flight.linkedSessionIds, panes]);

  return (
    <div className="px-4 py-3 border-b border-bg-border">
      <div className="flex items-center gap-2 mb-2">
        <Users size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Agent Sessions
        </span>
        <span className="text-[10px] text-text-muted">({sessions.length})</span>
      </div>
      {sessions.length === 0 ? (
        <p className="text-[10px] text-text-muted py-2">No agent sessions linked yet.</p>
      ) : (
        <div className="space-y-1">
          {sessions.map(({ sessionId, pane }) => (
            <div key={sessionId} className="flex items-center gap-2 py-1">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  pane ? "bg-accent-green" : "bg-text-muted"
                }`}
              />
              <span className="text-[10px] text-text-secondary font-mono truncate flex-1">
                {sessionId}
              </span>
              <span className="text-[10px] text-text-muted">
                {pane?.cliCommand ?? "offline"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function ActivityLogPanel({ flight }: { flight: Flight }) {
  const activities = useActivityStore((s) => s.activities);
  const panes = useLayoutStore((s) => s.panes);

  const entries = useMemo(() => {
    const linkedSet = new Set(flight.linkedSessionIds);
    const out: { paneId: string; sessionId: string | null; activity: (typeof activities)[string] }[] = [];
    for (const pane of panes) {
      if (!pane.sessionId || !linkedSet.has(pane.sessionId)) continue;
      const a = activities[pane.id];
      if (a) out.push({ paneId: pane.id, sessionId: pane.sessionId, activity: a });
    }
    return out.sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt);
  }, [flight.linkedSessionIds, panes, activities]);

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Activity size={12} className="text-accent-amber" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Activity Log
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="text-[10px] text-text-muted py-2">No agent activity to report.</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map(({ paneId, activity }) => (
            <div key={paneId} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 bg-accent-amber" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-text-secondary truncate">
                  {activity.agentState}
                  {activity.currentTool ? ` · ${activity.currentTool}` : ""}
                </p>
                {activity.currentFile && (
                  <p className="text-[10px] text-text-muted truncate">{activity.currentFile}</p>
                )}
                <p className="text-[10px] text-text-muted">
                  {relativeTime(activity.lastActivityAt)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
