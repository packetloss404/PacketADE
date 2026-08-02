import { useEffect, useMemo, useState } from "react";
import {
  Plane,
  Search,
  Plus,
  Users,
  Check,
  Sparkles,
  Brain,
  Trash2,
  FileCheck2,
  GitCommit,
  ShieldCheck,
  BookmarkPlus,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useFlightStore } from "@/stores/flightStore";
import {
  describeFlightDeleteImpact,
  inspectFlightDeleteImpact,
  summarizeFlightDeleteImpact,
  useAsyncFlightStore,
  type FlightDeleteImpact,
} from "@/stores/asyncFlightStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { useToast } from "@/components/ui/Toast";
import { reassignTargetFromEscalation } from "@/lib/flightCoordination";
import { buildCoordinationMemoryInput } from "@/lib/memoryCapture";
import { getProviderForAgent } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useAppStore } from "@/stores/appStore";
import { LaunchAsyncFlightModal } from "@/components/flights/LaunchAsyncFlightModal";
import { AsyncFlightGrid } from "@/components/flights/AsyncFlightGrid";
import { FlightPlanningCard } from "@/components/flights/FlightPlanningCard";
import { CooperativeFlightCard } from "@/components/flights/CooperativeFlightCard";
import { FlightCoordinationInbox } from "@/components/flights/FlightCoordinationInbox";
import { FlightAutonomyCard } from "@/components/flights/FlightAutonomyCard";
import { PacketAgentHandoffCard } from "@/components/flights/PacketAgentHandoffCard";
import { IssueFlightMirrorCard } from "@/components/flights/IssueFlightMirrorCard";
import { openMonitorWindow } from "@/lib/monitorWindows";
import { relativeTime } from "@/lib/time";
import { summarizeFlightAttention, summarizeFlightReview } from "@/lib/flightReview";
import {
  FLIGHT_STATUS_CONFIG,
  FLIGHT_PRIORITY_COLORS,
  TASK_ROLE_CONFIG,
} from "@/lib/flight-colors";
import type {
  Flight,
  FlightPriority,
  FlightStatus,
  CoordinationEvent,
  CoordinationEventType,
  TaskRole,
} from "@/types/flight";

type ModalKind = null | "async";
// When set alongside modal === "async", the launch modal targets this
// existing flight instead of minting a new one.
type GroupKey = "drafting" | "attention" | "active" | "recent";

type DesignDot = "green" | "blue" | "amber" | "red" | "muted" | "accent" | "purple";

const STATUS_DOT: Record<FlightStatus, DesignDot> = {
  spec: "purple",
  draft: "muted",
  planning: "muted",
  ready: "muted",
  active: "green",
  paused: "amber",
  review: "blue",
  done: "muted",
  failed: "red",
  cancelled: "muted",
};

const STATUS_LABEL: Record<FlightStatus, string> = {
  spec: "spec",
  draft: "draft",
  planning: "planning",
  ready: "ready",
  active: "running",
  paused: "paused",
  review: "review",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const PRIORITY_LABEL: Record<FlightPriority, string> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

const DOT_BG: Record<DesignDot, string> = {
  green: "bg-accent-green",
  blue: "bg-accent-blue",
  amber: "bg-accent-amber",
  red: "bg-accent-red",
  muted: "bg-text-muted",
  accent: "bg-accent-green",
  purple: "bg-accent-purple",
};

const DOT_TEXT: Record<DesignDot, string> = {
  green: "text-accent-green",
  blue: "text-accent-blue",
  amber: "text-accent-amber",
  red: "text-accent-red",
  muted: "text-text-muted",
  accent: "text-accent-green",
  purple: "text-accent-purple",
};

const PRIORITY_PILL_BG: Record<FlightPriority, string> = {
  critical: "bg-accent-red/10 border-accent-red/30",
  high: "bg-accent-amber/10 border-accent-amber/30",
  medium: "bg-bg-tertiary border-bg-border",
  low: "bg-bg-tertiary border-bg-border",
};

const EVENT_DOT: Record<CoordinationEventType, DesignDot> = {
  task_started: "amber",
  task_completed: "green",
  task_failed: "red",
  handoff: "blue",
  review_requested: "accent",
  review_resolved: "green",
  collision_warning: "amber",
  escalation: "red",
};

function shortId(id: string): string {
  const tail = id
    .replace(/^[a-z]+-/i, "")
    .slice(-4)
    .toUpperCase();
  return `F-${tail}`;
}

function flightAgentCount(flight: Flight): number {
  const ids = new Set<string>();
  for (const m of flight.milestones) {
    for (const t of m.tasks) {
      if (t.agentConfigId) ids.add(t.agentConfigId);
    }
  }
  if (ids.size > 0) return ids.size;
  return flight.linkedSessionIds.length;
}

function flightTasks(flight: Flight): {
  done: number;
  total: number;
  approvals: number;
  hasInProgress: boolean;
} {
  let done = 0;
  let total = 0;
  let approvals = 0;
  let hasInProgress = false;
  for (const m of flight.milestones) {
    for (const t of m.tasks) {
      total += 1;
      if (t.status === "done") done += 1;
      if (t.status === "approval_needed") approvals += 1;
      if (t.status === "running" || t.status === "queued") hasInProgress = true;
    }
  }
  return { done, total, approvals, hasInProgress };
}

function classifyGroup(flight: Flight, status: FlightStatus): GroupKey {
  if (status === "spec") return "drafting";
  const hasApproval = flight.milestones.some((m) =>
    m.tasks.some((t) => t.status === "approval_needed"),
  );
  if (status === "failed" || status === "paused" || hasApproval) return "attention";
  if (status === "active" || status === "review") return "active";
  return "recent";
}

function formatCost(cost: number): string {
  if (!cost && cost !== 0) return "$0.00";
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function eventTimeShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function FlightsView() {
  const { flights, activeFlightId, setActiveFlight, computeFlightStatus } = useFlightStore(
    useShallow((s) => ({
      flights: s.flights,
      activeFlightId: s.activeFlightId,
      setActiveFlight: s.setActiveFlight,
      computeFlightStatus: s.computeFlightStatus,
    })),
  );
  const [modal, setModal] = useState<ModalKind>(null);
  const [launchTargetFlightId, setLaunchTargetFlightId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  function handleStartFlight() {
    setLaunchTargetFlightId(null);
    setModal("async");
  }

  function handleLaunchIntoFlight(flightId: string) {
    setLaunchTargetFlightId(flightId);
    setModal("async");
  }

  const selectedId = useMemo(() => {
    if (activeFlightId && flights.some((f) => f.id === activeFlightId)) {
      return activeFlightId;
    }
    return flights[0]?.id ?? null;
  }, [flights, activeFlightId]);

  useEffect(() => {
    if (selectedId && selectedId !== activeFlightId) {
      setActiveFlight(selectedId);
    }
  }, [selectedId, activeFlightId, setActiveFlight]);

  const selectedFlight = useMemo(
    () => flights.find((f) => f.id === selectedId) ?? null,
    [flights, selectedId],
  );

  const grouped = useMemo(() => {
    const filter = query.trim().toLowerCase();
    const buckets: Record<GroupKey, Flight[]> = {
      drafting: [],
      attention: [],
      active: [],
      recent: [],
    };
    for (const f of flights) {
      if (filter) {
        const hay = `${f.title} ${f.objective ?? ""} ${f.id}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }
      const status = computeFlightStatus(f.id);
      buckets[classifyGroup(f, status)].push(f);
    }
    return buckets;
  }, [flights, query, computeFlightStatus]);

  const closeModal = () => {
    setModal(null);
    setLaunchTargetFlightId(null);
  };

  if (flights.length === 0) {
    return (
      <>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-bg-primary px-6 text-text-muted">
          <Plane size={32} />
          <span className="text-sm font-medium text-text-primary">No flights yet</span>
          <span className="max-w-md text-center text-xs">
            Launch a worktree attempt against a target agent and branch — track progress, review the
            diff, and accept or reject the result.
          </span>
          <div className="mt-2 flex flex-col items-center gap-2">
            <button
              onClick={handleStartFlight}
              className="hover:bg-accent-green/15 flex items-center gap-2 rounded border border-accent-line bg-accent-soft px-4 py-2 text-sm font-medium text-accent-green transition-colors"
            >
              <Sparkles size={14} />
              New flight
            </button>
          </div>
        </div>
        {modal === "async" && (
          <LaunchAsyncFlightModal
            flightId={launchTargetFlightId ?? undefined}
            onLaunched={(id) => setActiveFlight(id)}
            onClose={closeModal}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 bg-bg-primary">
        <FlightSidebar
          flights={flights}
          grouped={grouped}
          selectedId={selectedId}
          onSelect={setActiveFlight}
          query={query}
          onQueryChange={setQuery}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          onCreate={handleStartFlight}
          computeStatus={computeFlightStatus}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedFlight ? (
            <FlightDetailPane
              flight={selectedFlight}
              status={computeFlightStatus(selectedFlight.id)}
              onLaunchAttempt={() => handleLaunchIntoFlight(selectedFlight.id)}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>
      {modal === "async" && (
        <LaunchAsyncFlightModal
          flightId={launchTargetFlightId ?? undefined}
          onLaunched={(id) => setActiveFlight(id)}
          onClose={closeModal}
        />
      )}
    </>
  );
}

function EmptyDetail() {
  return (
    <div className="flex flex-1 items-center justify-center bg-bg-primary">
      <div className="flex flex-col items-center gap-2 text-text-muted">
        <Plane size={28} />
        <span className="text-xs">No flight selected — pick one from the left</span>
      </div>
    </div>
  );
}

interface SidebarProps {
  flights: Flight[];
  grouped: Record<GroupKey, Flight[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onCreate: () => void;
  computeStatus: (id: string) => FlightStatus;
}

function FlightSidebar({
  flights,
  grouped,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  searchOpen,
  onToggleSearch,
  onCreate,
  computeStatus,
}: SidebarProps) {
  const groups: { key: GroupKey; label: string }[] = [
    { key: "drafting", label: "Drafting" },
    { key: "attention", label: "Attention" },
    { key: "active", label: "Active" },
    { key: "recent", label: "Recent" },
  ];

  return (
    <div className="flex min-h-0 w-[320px] flex-shrink-0 flex-col border-r border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <span className="text-[11px] font-semibold text-text-primary">Flights</span>
        <span className="rounded bg-bg-tertiary px-1.5 py-px font-mono text-[10px] text-text-muted">
          {flights.length}
        </span>
        <span className="flex-1" />
        <button
          onClick={onToggleSearch}
          className={`rounded p-1 transition-colors hover:bg-bg-hover ${
            searchOpen ? "bg-bg-hover text-text-primary" : "text-text-muted"
          }`}
          title="Search flights"
        >
          <Search size={12} />
        </button>
        <button
          onClick={onCreate}
          className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-accent-green"
          title="New flight"
        >
          <Plus size={12} />
        </button>
      </div>

      {searchOpen && (
        <div className="border-b border-line-soft px-2.5 py-1.5">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter by title, objective, id…"
            className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-faint focus:border-accent-line"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => {
          const items = grouped[g.key];
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <div className="sticky top-0 z-10 flex items-center justify-between border-y border-line-soft bg-bg-tertiary px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                <span>{g.label}</span>
                <span className="font-mono">{items.length}</span>
              </div>
              {items.map((f) => (
                <FlightRow
                  key={f.id}
                  flight={f}
                  status={computeStatus(f.id)}
                  selected={f.id === selectedId}
                  onSelect={() => onSelect(f.id)}
                />
              ))}
            </div>
          );
        })}
        {grouped.drafting.length === 0 &&
          grouped.attention.length === 0 &&
          grouped.active.length === 0 &&
          grouped.recent.length === 0 && (
            <div className="px-3 py-4 text-[10px] text-text-muted">No flights match.</div>
          )}
      </div>
    </div>
  );
}

function FlightRow({
  flight,
  status,
  selected,
  onSelect,
}: {
  flight: Flight;
  status: FlightStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  const dot = STATUS_DOT[status];
  const pulse = status === "active";
  const agents = flightAgentCount(flight);
  const cost = formatCost(flight.totalCost);
  const priorityClass = FLIGHT_PRIORITY_COLORS[flight.priority];
  const statusLabel = STATUS_LABEL[status];
  const toast = useToast();

  // Delete confirm. The old idiom here was a 3-second armed inline button;
  // it is now the shared ConfirmDeleteModal, because the delete no longer
  // just drops a row — it cancels the flight's running attempts and removes
  // their worktrees, and the user is owed those consequences up front.
  const [confirming, setConfirming] = useState(false);
  const [impact, setImpact] = useState<FlightDeleteImpact | null>(null);

  // Probe the live attempts (and their worktrees) only while the confirm is
  // open. `impact === null` renders as "checking…" rather than as "nothing
  // will be lost".
  useEffect(() => {
    if (!confirming) return;
    let stale = false;
    setImpact(null);
    void inspectFlightDeleteImpact(flight.id)
      .then((next) => {
        if (!stale) setImpact(next);
      })
      .catch((err) => {
        console.warn("[FlightsView] delete impact probe failed", err);
        if (!stale) setImpact(summarizeFlightDeleteImpact([]));
      });
    return () => {
      stale = true;
    };
  }, [confirming, flight.id]);

  // Tasks aren't cancelled by the delete (they have no worktree of their
  // own), but live ones are still work the user is throwing away.
  const liveTaskCount = useMemo(() => {
    let count = 0;
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        if (t.status === "running" || t.status === "queued" || t.status === "approval_needed") {
          count += 1;
        }
      }
    }
    return count;
  }, [flight.milestones]);

  const hasActiveWork = useMemo(
    () =>
      liveTaskCount > 0 ||
      (flight.attempts ?? []).some(
        (a) =>
          a.status === "running" ||
          a.status === "provisioning" ||
          a.status === "queued" ||
          a.status === "reviewing",
      ),
    [flight.attempts, liveTaskCount],
  );

  const deleteWarnings = useMemo(() => {
    const warnings = describeFlightDeleteImpact(impact);
    if (liveTaskCount > 0) {
      warnings.push(
        `${liveTaskCount} task${liveTaskCount === 1 ? "" : "s"} ${liveTaskCount === 1 ? "is" : "are"} still running or awaiting approval.`,
      );
    }
    return warnings;
  }, [impact, liveTaskCount]);

  const runDelete = () => {
    const flightName = flight.title || "Untitled";
    const cancelling = impact?.attemptCount ?? 0;
    setConfirming(false);
    if (cancelling > 0) {
      toast.show(
        `Cancelling ${cancelling} attempt${cancelling === 1 ? "" : "s"} and removing ${cancelling === 1 ? "its worktree" : "their worktrees"}…`,
      );
    }
    void useAsyncFlightStore
      .getState()
      .deleteFlightWithAttemptCleanup(flight.id)
      .then((failures) => {
        if (failures.length === 0) return;
        toast.error(
          `Deleted “${flightName}”, but ${failures.length} attempt cleanup${
            failures.length === 1 ? "" : "s"
          } failed: ${failures.map((f) => `${f.branch || f.attemptId || "flight"} — ${f.message}`).join(" | ")}`,
        );
      })
      .catch((err) => {
        toast.error(
          `Failed to delete “${flightName}”: ${err instanceof Error ? err.message : err}`,
        );
      });
  };
  // v0.8-H — "N patterns extracted" chip on completed flights. We
  // count every `flight_completed` / `task_completed` event tied to
  // this flight (by flightId) and the lessonsLearned bullets they
  // emitted, which are the closest analog to "patterns" in our current
  // schema.
  const memoryHits = useMemoryStore((s) => {
    if (status !== "done") return 0;
    let lessons = 0;
    let flightEvents = 0;
    for (const e of s.events) {
      if (e.type === "flight_completed" && e.payload.flightId === flight.id) {
        flightEvents += 1;
        lessons += e.payload.lessonsLearned.length;
      } else if (e.type === "task_completed" && e.payload.flightId === flight.id) {
        flightEvents += 1;
      }
    }
    return flightEvents > 0 ? lessons + flightEvents : 0;
  });
  const openMemoryView = useAppStore((s) => s.openMemoryView);

  const deleteTitle = hasActiveWork
    ? `Delete "${flight.title || "Untitled"}"? This flight has active work — its attempts will be cancelled and their worktrees removed.`
    : `Delete "${flight.title || "Untitled"}"`;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={`group flex w-full cursor-pointer flex-col gap-1 border-b border-l-2 border-line-soft px-2.5 py-2 text-left transition-colors ${
          selected
            ? "border-l-accent-green bg-bg-elevated"
            : "border-l-transparent hover:bg-bg-tertiary"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
            {pulse && (
              <span
                className={`absolute inset-0 rounded-full ${DOT_BG[dot]} animate-ping opacity-60`}
              />
            )}
            <span className={`relative h-1.5 w-1.5 rounded-full ${DOT_BG[dot]}`} />
          </span>
          <span className="font-mono text-[10px] text-text-muted">{shortId(flight.id)}</span>
          <span className="flex-1" />
          <span className={`font-mono text-[10px] font-semibold ${priorityClass}`}>
            {PRIORITY_LABEL[flight.priority]}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className="hover:bg-accent-red/10 rounded p-0.5 text-text-muted opacity-0 transition-colors hover:text-accent-red focus:opacity-100 group-hover:opacity-100"
            title={deleteTitle}
            aria-label="Delete flight"
          >
            <Trash2 size={11} />
          </button>
        </div>
        <span
          className={`line-clamp-2 text-[12px] leading-snug ${
            selected ? "font-medium text-text-primary" : "text-text-secondary"
          }`}
        >
          {flight.title || "Untitled"}
        </span>
        <div className="flex items-center gap-2 text-[10px] text-text-muted">
          <span className="inline-flex items-center gap-1">
            <Users size={9} />
            <span>{agents}</span>
          </span>
          {memoryHits > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                openMemoryView({ flightId: flight.id });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  openMemoryView({ flightId: flight.id });
                }
              }}
              className="hover:text-accent-green/80 hover:bg-accent-green/10 -mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 text-accent-green transition-colors"
              title={`${memoryHits} memory entr${memoryHits === 1 ? "y" : "ies"} extracted from this flight. Click to view in Memory.`}
            >
              <Brain size={9} />
              <span>{memoryHits}</span>
            </span>
          )}
          <span className="font-mono">{cost}</span>
          <span className="flex-1" />
          <span className={`capitalize ${DOT_TEXT[dot]}`}>{statusLabel}</span>
        </div>
      </div>
      {confirming && (
        <ConfirmDeleteModal
          title="Delete flight?"
          entityName={flight.title || "Untitled"}
          description="is removed along with its attempt history, and any issues linked to it are unassigned. Running attempts are cancelled and their git worktrees removed first."
          warningTitle="Deleting this also destroys"
          warnings={deleteWarnings}
          confirmLabel={impact && impact.attemptCount > 0 ? "Cancel attempts & delete" : "Delete"}
          onConfirm={runDelete}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

interface DetailProps {
  flight: Flight;
  status: FlightStatus;
  onLaunchAttempt: () => void;
}

function FlightDetailPane({ flight, status, onLaunchAttempt }: DetailProps) {
  const toast = useToast();
  const cfg = FLIGHT_STATUS_CONFIG[status];
  const tasks = flightTasks(flight);
  const sessions = flight.linkedSessionIds.length;

  return (
    <div className="flex-1 overflow-y-auto bg-bg-primary">
      <div className="flex min-h-full flex-col gap-3 p-3.5">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-text-muted">{shortId(flight.id)}</span>
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.text}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                {STATUS_LABEL[status]}
              </span>
              <span
                className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${PRIORITY_PILL_BG[flight.priority]} ${FLIGHT_PRIORITY_COLORS[flight.priority]}`}
              >
                {PRIORITY_LABEL[flight.priority]}
              </span>
            </div>
            <h2 className="text-[18px] font-semibold leading-tight tracking-tight text-text-primary">
              {flight.title || "Untitled flight"}
            </h2>
            {flight.objective && (
              <p className="max-w-[600px] text-[11.5px] leading-relaxed text-text-secondary">
                {flight.objective}
              </p>
            )}
          </div>
          <button
            onClick={() =>
              void openMonitorWindow({ kind: "flight", flightId: flight.id }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                toast.error(`Monitor could not be opened: ${message}`);
              })
            }
            className="rounded border border-bg-border px-2.5 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover"
          >
            Send to Monitor
          </button>
        </div>

        <StatGrid flight={flight} tasks={tasks} sessions={sessions} />

        <FlightPlanningCard flight={flight} />

        <FlightAutonomyCard flight={flight} />

        <PacketAgentHandoffCard flight={flight} />

        <IssueFlightMirrorCard flight={flight} />

        <CooperativeFlightCard flight={flight} />

        <FlightCoordinationInbox flight={flight} />

        <AsyncFlightGrid
          flight={flight}
          onLaunch={flight.executionMode === "cooperative" ? undefined : onLaunchAttempt}
        />

        <AttentionCard flight={flight} />

        <OutputReviewCard flight={flight} />

        <div className="grid min-h-[260px] flex-1 grid-cols-1 gap-3 lg:[grid-template-columns:1.4fr_1fr]">
          <MilestonesCard flight={flight} tasks={tasks} />
          <TimelineCard flight={flight} />
        </div>
      </div>
    </div>
  );
}

// E6: single "needs a human" strip — attempts awaiting review or failed.
function AttentionCard({ flight }: { flight: Flight }) {
  const attention = summarizeFlightAttention(flight);
  if (attention.total === 0) return null;
  return (
    <div className="border-accent-amber/30 bg-accent-amber/10 rounded border px-3 py-2">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-accent-amber">
        <span>Needs attention</span>
        <span className="bg-accent-amber/20 rounded-full px-1.5 text-[10px]">
          {attention.total}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-text-secondary">
        {attention.reviewing.length > 0 && (
          <span>
            {attention.reviewing.length} attempt{attention.reviewing.length === 1 ? "" : "s"}{" "}
            awaiting review — accept or reject below.
          </span>
        )}
        {attention.failed.map((a) => (
          <span key={a.id} className="text-text-muted">
            {a.provider} failed
            {a.failureCategory ? ` (${a.failureCategory.replace(/_/g, " ")})` : ""} — review the
            diff, or reassign from the timeline when a suggestion appears.
          </span>
        ))}
      </div>
    </div>
  );
}

function OutputReviewCard({ flight }: { flight: Flight }) {
  const summary = useMemo(() => summarizeFlightReview(flight), [flight]);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof summary.files = [];
    for (const ref of summary.files) {
      const key = `${ref.taskId}:${ref.filePath}:${ref.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
      if (out.length >= 8) break;
    }
    return out;
  }, [summary]);

  const shouldRender =
    summary.taskCount > 0 || flight.status === "review" || summary.pendingApprovalCount > 0;

  if (!shouldRender) return null;

  const reported = summary.reportedFileCount;
  const owned = summary.ownedFileCount;
  const hasFiles = rows.length > 0;

  return (
    <div className="flex flex-col overflow-hidden rounded border border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <ShieldCheck size={11} className="text-accent-amber" />
        <span className="text-[11px] font-semibold text-text-primary">Output review</span>
        <span className="flex-1" />
        {summary.pendingApprovalCount > 0 ? (
          <span className="bg-accent-amber/10 rounded px-1.5 py-0.5 text-[10px] text-accent-amber">
            {summary.pendingApprovalCount} approval
            {summary.pendingApprovalCount === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="bg-accent-green/10 rounded px-1.5 py-0.5 text-[10px] text-accent-green">
            ready
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
          <span className="inline-flex items-center gap-1">
            <FileCheck2 size={10} className="text-accent-amber" />
            {reported} reported file{reported === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitCommit size={10} className="text-accent-green" />
            {owned} owned path{owned === 1 ? "" : "s"}
          </span>
          <span className="text-text-faint">
            Review task output before approve/merge or commit.
          </span>
        </div>

        {!hasFiles ? (
          <div className="mt-2 rounded border border-dashed border-bg-border px-2 py-2 text-[11px] text-text-muted">
            No task file output has been reported yet.
          </div>
        ) : (
          <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
            {rows.map((ref) => (
              <div
                key={`${ref.taskId}-${ref.filePath}-${ref.relation}`}
                className="flex min-w-0 items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-1"
                title={`${ref.taskTitle} / ${ref.filePath}`}
              >
                <FileCheck2
                  size={10}
                  className={
                    ref.relation === "reported"
                      ? "shrink-0 text-accent-amber"
                      : "shrink-0 text-text-muted"
                  }
                />
                <span className="truncate font-mono text-[10px] text-text-secondary">
                  {ref.filePath}
                </span>
                <span className="ml-auto max-w-[160px] truncate rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted">
                  {ref.taskTitle}
                </span>
              </div>
            ))}
          </div>
        )}

        {summary.files.length > rows.length && (
          <div className="mt-1.5 text-[10px] text-text-muted">
            +{summary.files.length - rows.length} more file reference
            {summary.files.length - rows.length === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </div>
  );
}

interface StatGridProps {
  flight: Flight;
  tasks: { done: number; total: number; approvals: number; hasInProgress: boolean };
  sessions: number;
}

function StatGrid({ flight, tasks, sessions }: StatGridProps) {
  const tasksValueClass = tasks.hasInProgress ? "text-accent-green" : "text-text-primary";
  const approvalsValueClass = tasks.approvals > 0 ? "text-accent-amber" : "text-text-primary";

  const cells: {
    label: string;
    value: string;
    valueClass?: string;
  }[] = [
    { label: "Cost", value: formatCost(flight.totalCost ?? 0) },
    { label: "Tokens", value: formatTokens(flight.totalTokens) },
    {
      label: "Tasks",
      value: tasks.total ? `${tasks.done}/${tasks.total}` : "0/0",
      valueClass: tasksValueClass,
    },
    {
      label: "Approvals",
      value: `${tasks.approvals}`,
      valueClass: approvalsValueClass,
    },
    { label: "Sessions", value: `${sessions}` },
    { label: "Updated", value: relativeTime(flight.updatedAt) },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <div
          key={c.label}
          className="flex flex-col gap-0.5 rounded border border-bg-border bg-bg-secondary px-2.5 py-2"
        >
          <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{c.label}</span>
          <span
            className={`font-mono text-[14px] font-semibold leading-tight ${
              c.valueClass ?? "text-text-primary"
            }`}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MilestonesCard({
  flight,
  tasks,
}: {
  flight: Flight;
  tasks: { done: number; total: number };
}) {
  const rows = useMemo(() => {
    const out: {
      id: string;
      title: string;
      done: boolean;
      running: boolean;
      agent: string;
      role?: TaskRole;
    }[] = [];
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        out.push({
          id: t.id,
          title: t.title,
          done: t.status === "done",
          running:
            t.status === "running" || t.status === "queued" || t.status === "approval_needed",
          agent: t.agentConfigId || "—",
          role: t.role,
        });
      }
    }
    return out;
  }, [flight.milestones]);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded border border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <span className="text-[11px] font-semibold text-text-primary">Milestones</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-text-muted">
          {tasks.total > 0 ? `${tasks.done} / ${tasks.total} done` : "—"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-muted">No milestones defined yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5 p-2.5">
            {rows.map((m) => (
              <div key={m.id} className="flex items-center gap-2 text-[11.5px]">
                <span
                  className={`relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded ${
                    m.done
                      ? "border border-accent-green bg-accent-green"
                      : m.running
                        ? "border border-accent-line"
                        : "border border-line-strong"
                  }`}
                >
                  {m.done ? (
                    <Check size={9} className="text-bg-primary" strokeWidth={3} />
                  ) : m.running ? (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inset-0 animate-ping rounded-full bg-accent-amber opacity-60" />
                      <span className="relative h-1.5 w-1.5 rounded-full bg-accent-amber" />
                    </span>
                  ) : null}
                </span>
                <span
                  className={`flex-1 truncate ${
                    m.done ? "text-text-muted line-through" : "text-text-secondary"
                  }`}
                >
                  {m.title}
                </span>
                {m.role && (
                  <span
                    className={`shrink-0 text-[9px] font-medium uppercase tracking-wide ${TASK_ROLE_CONFIG[m.role].color}`}
                  >
                    {TASK_ROLE_CONFIG[m.role].label}
                  </span>
                )}
                <span className="max-w-[140px] shrink-0 truncate text-[10px] text-text-muted">
                  {m.agent}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineCard({ flight }: { flight: Flight }) {
  const events = useMemo<CoordinationEvent[]>(() => {
    const log = flight.coordinationLog ?? [];
    return [...log].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
  }, [flight.coordinationLog]);

  const live = flight.status === "active";

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded border border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2.5 py-2">
        <span className="text-[11px] font-semibold text-text-primary">Live timeline</span>
        <span className="flex-1" />
        {live ? (
          <span className="relative flex h-2 w-2 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent-green opacity-60" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-accent-green" />
          </span>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-muted">No timeline events yet.</div>
        ) : (
          <div className="flex flex-col gap-2 p-2.5 text-[11px]">
            {events.map((e) => (
              <TimelineRow key={e.id} event={e} flight={flight} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({ event, flight }: { event: CoordinationEvent; flight: Flight }) {
  const dot = EVENT_DOT[event.type] ?? "muted";
  const actor = event.agentId || (event.type === "escalation" ? "you" : "system");
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [captured, setCaptured] = useState(false);
  const captureManually = useMemoryStore((s) => s.captureManually);

  const doCapture = () => {
    if (captured) return;
    captureManually(buildCoordinationMemoryInput(event, flight));
    setCaptured(true);
  };

  // E5: an escalation that carries a concrete suggestion becomes a one-click
  // reassignment. Other event types render as display-only text.
  const target = reassignTargetFromEscalation(event, flight.attempts ?? []);
  const showAction = Boolean(target) && !dismissed;
  const agentLabel = target
    ? (getProviderForAgent(target.agentId as AgentCli)?.name ?? target.agentId)
    : "";

  const doReassign = () => {
    if (!target || busy) return;
    setBusy(true);
    setFailed(false);
    void useAsyncFlightStore
      .getState()
      .reassignAttempt(flight.id, target.attemptId, target.agentId)
      .then(() => setDismissed(true))
      .catch((err) => {
        // e.g. the new provider is over its cost guardrail, or the backend
        // launch failed. Surface it and let the user retry rather than leaving
        // an unhandled rejection with a silently re-enabled button.
        console.warn("reassignAttempt failed", err);
        setFailed(true);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="group flex items-start gap-2">
      <span className="w-[32px] shrink-0 pt-px font-mono text-[10px] text-text-muted">
        {eventTimeShort(event.timestamp)}
      </span>
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_BG[dot]}`} />
      <span className="flex-1 leading-snug">
        <span className="font-medium text-text-primary">{actor}</span>{" "}
        <span className="text-text-secondary">{event.summary}</span>{" "}
        <button
          type="button"
          onClick={doCapture}
          disabled={captured}
          title={captured ? "Saved to memory" : "Add this event to project memory"}
          className="ml-0.5 inline-flex items-center gap-0.5 align-baseline text-[10px] text-text-muted opacity-0 transition-opacity hover:text-accent-green disabled:text-accent-green disabled:opacity-100 group-hover:opacity-100"
        >
          <BookmarkPlus size={10} />
          {captured ? "Saved" : "Memory"}
        </button>
        {showAction && (
          <span className="mt-1 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={doReassign}
              className="border-accent-green/40 bg-accent-green/10 hover:bg-accent-green/20 rounded border px-1.5 py-0.5 text-[10px] text-accent-green disabled:opacity-50"
            >
              {busy
                ? "Reassigning…"
                : failed
                  ? `Retry — reassign to ${agentLabel}`
                  : `Reassign to ${agentLabel}`}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded border border-bg-border px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-secondary"
            >
              Dismiss
            </button>
          </span>
        )}
      </span>
    </div>
  );
}
