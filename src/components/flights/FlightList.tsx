import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, AlertTriangle, X } from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { FLIGHT_STATUS_CONFIG } from "@/lib/flight-colors";
import { LaunchAsyncFlightModal } from "./LaunchAsyncFlightModal";
import type { Flight, FlightStatus } from "@/types/flight";

type WorkspaceFilter = "active" | "all";

interface FlightListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Group {
  key: string;
  label: string;
  flights: Flight[];
  /** When true, header is highlighted amber (Attention group). */
  attention?: boolean;
  defaultOpen?: boolean;
}

export function FlightList({ selectedId, onSelect }: FlightListProps) {
  const flights = useFlightStore((s) => s.flights);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorkspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<WorkspaceFilter>(
    activeWorkspaceId ? "active" : "all",
  );

  const visibleFlights = useMemo(() => {
    if (filter === "all" || !activeWorkspaceId) return flights;
    return flights.filter((f) => f.workspaceId === activeWorkspaceId);
  }, [flights, filter, activeWorkspaceId]);

  const groups = useMemo<Group[]>(() => {
    const { computeFlightStatus } = useFlightStore.getState();

    const buckets: Record<FlightStatus, Flight[]> = {
      spec: [],
      draft: [],
      planning: [],
      ready: [],
      active: [],
      paused: [],
      review: [],
      done: [],
      failed: [],
      cancelled: [],
    };
    for (const f of visibleFlights) {
      const status = computeFlightStatus(f.id);
      buckets[status].push(f);
    }

    // Attention = paused + failed + flights with any approval_needed task
    const attention: Flight[] = [];
    const seen = new Set<string>();
    for (const f of [...buckets.paused, ...buckets.failed]) {
      if (!seen.has(f.id)) {
        attention.push(f);
        seen.add(f.id);
      }
    }
    for (const f of visibleFlights) {
      if (seen.has(f.id)) continue;
      const hasApproval = f.milestones.some((m) =>
        m.tasks.some((t) => t.status === "approval_needed"),
      );
      if (hasApproval) {
        attention.push(f);
        seen.add(f.id);
      }
    }

    const draftish = [...buckets.draft, ...buckets.planning, ...buckets.ready];

    return [
      { key: "attention", label: "Attention", flights: attention, attention: true, defaultOpen: true },
      { key: "active", label: "Active", flights: buckets.active, defaultOpen: true },
      { key: "review", label: "Review", flights: buckets.review, defaultOpen: true },
      { key: "draft", label: "Draft", flights: draftish, defaultOpen: false },
      { key: "done", label: "Done", flights: buckets.done, defaultOpen: false },
      { key: "cancelled", label: "Cancelled", flights: buckets.cancelled, defaultOpen: false },
    ];
  }, [visibleFlights]);

  function handleCreated(id: string) {
    onSelect(id);
  }

  return (
    <div className="w-[260px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Flights
        </span>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1 text-[10px] text-accent-green hover:text-accent-green/80 transition-colors"
          title="New flight"
        >
          <Plus size={11} />
          New
        </button>
      </div>

      {/* Workspace filter */}
      {activeWorkspaceId && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-bg-border">
          <button
            onClick={() => setFilter("active")}
            className={`flex-1 text-[10px] py-1 rounded transition-colors ${
              filter === "active"
                ? "bg-accent-purple/15 text-accent-purple"
                : "text-text-muted hover:text-text-secondary"
            }`}
            title={`Show only flights in workspace "${activeWorkspaceName ?? "active"}"`}
          >
            {activeWorkspaceName ?? "Workspace"}
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`flex-1 text-[10px] py-1 rounded transition-colors ${
              filter === "all"
                ? "bg-accent-purple/15 text-accent-purple"
                : "text-text-muted hover:text-text-secondary"
            }`}
            title="Show all flights across workspaces"
          >
            All
          </button>
        </div>
      )}

      {/* Groups */}
      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => (
          <FlightGroup key={g.key} group={g} selectedId={selectedId} onSelect={onSelect} />
        ))}
      </div>

      {showCreate && (
        <LaunchAsyncFlightModal
          onLaunched={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

function FlightGroup({
  group,
  selectedId,
  onSelect,
}: {
  group: Group;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(group.defaultOpen ?? false);

  if (group.flights.length === 0) return null;

  return (
    <div className="border-b border-bg-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 hover:bg-bg-hover transition-colors"
      >
        {open ? (
          <ChevronDown size={10} className="text-text-muted" />
        ) : (
          <ChevronRight size={10} className="text-text-muted" />
        )}
        {group.attention && <AlertTriangle size={10} className="text-accent-amber" />}
        <span
          className={`text-[10px] uppercase tracking-wide font-semibold ${
            group.attention ? "text-accent-amber" : "text-text-secondary"
          }`}
        >
          {group.label}
        </span>
        <span className="text-[10px] text-text-muted">({group.flights.length})</span>
      </button>
      {open && (
        <div className="pb-1">
          {group.flights.map((f) => (
            <FlightRow
              key={f.id}
              flight={f}
              selected={f.id === selectedId}
              onSelect={() => onSelect(f.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlightRow({
  flight,
  selected,
  onSelect,
}: {
  flight: Flight;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = useFlightStore((s) => s.computeFlightStatus)(flight.id);
  const deleteFlight = useFlightStore((s) => s.deleteFlight);
  const cfg = FLIGHT_STATUS_CONFIG[status];

  const tasks = flight.milestones.flatMap((m) => m.tasks);
  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;

  return (
    <div
      className={`flex items-start gap-2 w-full px-3 py-1.5 text-left transition-colors border-l-2 group ${
        selected
          ? "bg-accent-purple/15 border-accent-purple"
          : "hover:bg-bg-hover border-transparent"
      }`}
    >
      <button onClick={onSelect} className="flex items-start gap-2 flex-1 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${cfg.dot}`} />
        <div className="flex-1 min-w-0">
          <div
            className={`text-[11px] font-medium truncate ${
              selected ? "text-text-primary" : "text-text-secondary"
            }`}
          >
            {flight.title || "Untitled"}
          </div>
          <div className="flex items-center gap-1.5 text-[9px] text-text-muted">
            <span>{cfg.label}</span>
            {total > 0 && (
              <>
                <span>·</span>
                <span>{done}/{total}</span>
              </>
            )}
          </div>
        </div>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          deleteFlight(flight.id);
        }}
        className="mt-1 p-0.5 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
        title="Delete flight"
      >
        <X size={11} />
      </button>
    </div>
  );
}
