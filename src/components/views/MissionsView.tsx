import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plane,
  Search,
  Plus,
  Users,
  Pause,
  Play,
  Square,
  Check,
  CheckCircle2,
  Sparkles,
  Target,
  RefreshCw,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useFlightStore } from "@/stores/flightStore";
import { useGoalStore } from "@/stores/goalStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useMissionPlannerStore } from "@/stores/missionPlannerStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { NewFlightModal } from "@/components/flights/NewFlightModal";
import { LaunchAsyncFlightModal } from "@/components/flights/LaunchAsyncFlightModal";
import { MissionSpecPane } from "@/components/missions/MissionSpecPane";
import { JournalTab } from "@/components/missions/JournalTab";
import { PlannerApprovalGate } from "@/components/missions/PlannerApprovalGate";
import { relativeTime } from "@/lib/time";
import {
  FLIGHT_STATUS_CONFIG,
  FLIGHT_PRIORITY_COLORS,
} from "@/lib/flight-colors";
import type {
  Flight,
  FlightPriority,
  FlightStatus,
  CoordinationEvent,
  CoordinationEventType,
} from "@/types/flight";

type ModalKind = null | "async" | "multitask";
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
  const tail = id.replace(/^[a-z]+-/i, "").slice(-4).toUpperCase();
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

export function MissionsView() {
  const flights = useFlightStore((s) => s.flights);
  const activeFlightId = useFlightStore((s) => s.activeFlightId);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const addFlight = useFlightStore((s) => s.addFlight);
  const updateFlight = useFlightStore((s) => s.updateFlight);
  const computeFlightStatus = useFlightStore((s) => s.computeFlightStatus);
  const pauseFlight = useOrchestrationStore((s) => s.pauseFlight);
  const resumeFlight = useOrchestrationStore((s) => s.resumeFlight);
  const startPlanner = useMissionPlannerStore((s) => s.startPlanner);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  );
  const projectPath = useLayoutStore((s) => s.projectPath);

  const [modal, setModal] = useState<ModalKind>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  function handleStartMission() {
    const resolvedPath = activeWorkspace?.projectPath || projectPath || "";
    const flight = addFlight({
      title: "Untitled mission",
      objective: "",
      priority: "medium",
      projectPath: resolvedPath,
      workspaceId: activeWorkspace?.id ?? null,
      issueIds: [],
    });
    // `addFlight` hardcodes status: "draft"; flip it to spec mode so the
    // detail pane mounts the MissionSpecPane and the sidebar groups this
    // mission under "Drafting".
    updateFlight(flight.id, { status: "spec" });
    setActiveFlight(flight.id);
    // Fire-and-forget — MissionSpecPane handles streaming state once mounted.
    void startPlanner(flight.id, resolvedPath);
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

  const closeModal = () => setModal(null);

  if (flights.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-text-muted bg-bg-primary px-6">
          <Plane size={32} />
          <span className="text-sm font-medium text-text-primary">
            No missions yet
          </span>
          <span className="text-xs max-w-md text-center">
            Start a conversation with the planner. Describe what you want to
            build, and the planner will help scope it, decompose it into
            milestones, and run it in parallel.
          </span>
          <div className="flex flex-col items-center gap-2 mt-2">
            <button
              onClick={handleStartMission}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent-green border border-accent-line bg-accent-soft rounded hover:bg-accent-green/15 transition-colors"
            >
              <Sparkles size={14} />
              Start a mission
            </button>
            <button
              onClick={() => setModal("async")}
              className="text-[11px] text-text-muted hover:text-text-secondary transition-colors mt-1"
            >
              Or &rarr; Quick async launch (existing flow)
            </button>
          </div>
        </div>
        {modal === "async" && (
          <LaunchAsyncFlightModal
            onLaunched={(id) => setActiveFlight(id)}
            onClose={closeModal}
          />
        )}
        {modal === "multitask" && (
          <NewFlightModal
            onCreated={(id) => setActiveFlight(id)}
            onClose={closeModal}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-1 min-h-0 bg-bg-primary">
        <FlightSidebar
          flights={flights}
          grouped={grouped}
          selectedId={selectedId}
          onSelect={setActiveFlight}
          query={query}
          onQueryChange={setQuery}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          onCreate={() => setModal("async")}
          computeStatus={computeFlightStatus}
        />
        {selectedFlight ? (
          <FlightDetailPane
            flight={selectedFlight}
            status={computeFlightStatus(selectedFlight.id)}
            onPause={() => void pauseFlight(selectedFlight.id)}
            onResume={() => void resumeFlight(selectedFlight.id)}
          />
        ) : (
          <EmptyDetail />
        )}
      </div>
      {modal === "async" && (
        <LaunchAsyncFlightModal
          onLaunched={(id) => setActiveFlight(id)}
          onClose={closeModal}
        />
      )}
      {modal === "multitask" && (
        <NewFlightModal
          onCreated={(id) => setActiveFlight(id)}
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
        <span className="text-xs">
          No mission selected — pick one from the left
        </span>
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
    <div className="w-[320px] flex-shrink-0 flex flex-col bg-bg-secondary border-r border-bg-border min-h-0">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-line-soft">
        <span className="text-[11px] font-semibold text-text-primary">
          Flights
        </span>
        <span className="text-[10px] px-1.5 py-px rounded bg-bg-tertiary text-text-muted font-mono">
          {flights.length}
        </span>
        <span className="flex-1" />
        <button
          onClick={onToggleSearch}
          className={`p-1 rounded hover:bg-bg-hover transition-colors ${
            searchOpen ? "text-text-primary bg-bg-hover" : "text-text-muted"
          }`}
          title="Search flights"
        >
          <Search size={12} />
        </button>
        <button
          onClick={onCreate}
          className="p-1 text-text-muted hover:text-accent-green hover:bg-bg-hover rounded transition-colors"
          title="New flight"
        >
          <Plus size={12} />
        </button>
      </div>

      {searchOpen && (
        <div className="px-2.5 py-1.5 border-b border-line-soft">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter by title, objective, id…"
            className="w-full bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-faint outline-none focus:border-accent-line"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => {
          const items = grouped[g.key];
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <div className="sticky top-0 z-10 flex items-center justify-between px-2.5 py-1.5 bg-bg-tertiary border-y border-line-soft text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
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
            <div className="px-3 py-4 text-[10px] text-text-muted">
              No flights match.
            </div>
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
  // B5 — show how many persistent goals are bound to this mission so
  // users see at a glance whether long-running work is parked here.
  const goalCount = useGoalStore(
    (s) => s.getGoalsForMission(flight.id).length,
  );

  return (
    <button
      onClick={onSelect}
      className={`flex flex-col gap-1 w-full px-2.5 py-2 text-left border-b border-line-soft transition-colors border-l-2 ${
        selected
          ? "bg-bg-elevated border-l-accent-green"
          : "border-l-transparent hover:bg-bg-tertiary"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="relative flex items-center justify-center w-2 h-2 shrink-0">
          {pulse && (
            <span
              className={`absolute inset-0 rounded-full ${DOT_BG[dot]} opacity-60 animate-ping`}
            />
          )}
          <span className={`relative w-1.5 h-1.5 rounded-full ${DOT_BG[dot]}`} />
        </span>
        <span className="font-mono text-[10px] text-text-muted">
          {shortId(flight.id)}
        </span>
        <span className="flex-1" />
        <span
          className={`font-mono text-[10px] font-semibold ${priorityClass}`}
        >
          {PRIORITY_LABEL[flight.priority]}
        </span>
      </div>
      <span
        className={`text-[12px] leading-snug line-clamp-2 ${
          selected
            ? "text-text-primary font-medium"
            : "text-text-secondary"
        }`}
      >
        {flight.title || "Untitled"}
      </span>
      <div className="flex items-center gap-2 text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Users size={9} />
          <span>{agents}</span>
        </span>
        {goalCount > 0 && (
          <span
            className="inline-flex items-center gap-1 text-accent-blue"
            title={`${goalCount} persistent goal${goalCount === 1 ? "" : "s"} bound to this mission`}
          >
            <Target size={9} />
            <span>{goalCount}</span>
          </span>
        )}
        <span className="font-mono">{cost}</span>
        <span className="flex-1" />
        <span className={`capitalize ${DOT_TEXT[dot]}`}>{statusLabel}</span>
      </div>
    </button>
  );
}

interface DetailProps {
  flight: Flight;
  status: FlightStatus;
  onPause: () => void;
  onResume: () => void;
}

function FlightDetailPane({ flight, status, onPause, onResume }: DetailProps) {
  const cfg = FLIGHT_STATUS_CONFIG[status];
  const dot = STATUS_DOT[status];
  const tasks = flightTasks(flight);
  const sessions = flight.linkedSessionIds.length;
  const isSpec = status === "spec";
  // E7-INTEGRATE — tab strip state. "overview" renders the existing
  // detail body (or MissionSpecPane in spec status); "journal" renders
  // the markdown journal for this mission.
  const [activeTab, setActiveTab] = useState<"overview" | "journal">(
    "overview",
  );
  const [unreadJournal, setUnreadJournal] = useState(false);

  // Reset tab + unread dot when switching between missions so a new
  // mission doesn't inherit stale UI state.
  useEffect(() => {
    setActiveTab("overview");
    setUnreadJournal(false);
  }, [flight.id]);

  // FIX 3 (E7 polish) — keep the latest `activeTab` reachable from inside
  // the journal-listener effect without naming it as a dep. Listing
  // `activeTab` as a dependency below tore down + re-subscribed the Tauri
  // listener on every tab flip (cheap but a real source of churn during
  // rapid Overview/Journal toggles). A ref reads the freshest value at
  // event time and the effect only runs when the mission identity changes.
  const activeTabRef = useRef<"overview" | "journal">("overview");
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // Subscribe to journal-append events for this mission. If the user is
  // already viewing the Journal tab, we don't need to flag anything; the
  // JournalTab itself will refresh. Otherwise show a small dot.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen(`mission-planner:journal-appended:${flight.id}`, () => {
      if (cancelled) return;
      // Read `activeTab` off the ref so this effect doesn't need to
      // resubscribe when the tab changes.
      if (activeTabRef.current !== "journal") {
        setUnreadJournal(true);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [flight.id]);
  const canPause = !isSpec && status === "active";
  const canResume = !isSpec && (status === "paused" || status === "review");
  const showApprove = !isSpec && (status === "review" || tasks.approvals > 0);
  // E6-KILL-AWAKE: subscribe to planner runtime so the Stop button reactively
  // appears/disappears when the planner starts/stops. We watch the runtime
  // status itself (not just `isPlannerRunning(...)`) so Zustand's referential
  // selector triggers a re-render when status flips.
  const plannerStatus = useMissionPlannerStore(
    (s) => s.runtimes.get(flight.id)?.status,
  );
  // E10 — surface context-compaction state next to the status pill so
  // the user understands why the planner is briefly unresponsive while
  // the conversation gets summarized + the session is swapped.
  const isCompacting = useMissionPlannerStore(
    (s) => s.runtimes.get(flight.id)?.isCompacting === true,
  );
  // FIX 4 — include `quota_paused` so the user can manually stop a planner
  // stuck on auto-resume backoff without waiting for the timer to fire.
  // (The runtime status itself is preserved across the stop; the planner's
  // session is the thing that gets torn down.)
  const plannerRunning =
    plannerStatus === "awake" ||
    plannerStatus === "idle" ||
    plannerStatus === "quota_paused";
  const showStopPlanner =
    plannerRunning &&
    (status === "spec" ||
      status === "planning" ||
      status === "active" ||
      status === "review" ||
      status === "paused");

  return (
    <div className="flex-1 overflow-y-auto bg-bg-primary">
      <div className="flex flex-col gap-3 p-3.5 min-h-full">
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[11px] text-text-muted">
                {shortId(flight.id)}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${cfg.bg} ${cfg.text}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                {STATUS_LABEL[status]}
              </span>
              <span
                className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border ${PRIORITY_PILL_BG[flight.priority]} ${FLIGHT_PRIORITY_COLORS[flight.priority]}`}
              >
                {PRIORITY_LABEL[flight.priority]}
              </span>
              {isCompacting && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] text-accent-amber bg-accent-amber/10 border border-accent-amber/30 rounded"
                  title="Planner context compaction in progress — summarizing the conversation and restarting the session to stay under the 200K context limit."
                >
                  <RefreshCw size={9} className="animate-spin" />
                  Compacting
                </span>
              )}
            </div>
            <h2 className="text-[18px] font-semibold tracking-tight text-text-primary leading-tight">
              {flight.title || "Untitled mission"}
            </h2>
            {flight.objective && (
              <p className="text-[11.5px] text-text-secondary max-w-[600px] leading-relaxed">
                {flight.objective}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {canPause && (
              <button
                onClick={onPause}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary border border-bg-border rounded hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <Pause size={11} />
                Pause
              </button>
            )}
            {showStopPlanner && (
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      "Stop the autonomous planner for this mission? The mission stays alive — milestones, tasks, and in-flight executor work continue. You can restart the planner manually later.",
                    )
                  ) {
                    void useMissionPlannerStore
                      .getState()
                      .stopPlanner(flight.id);
                  }
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-accent-red bg-bg-secondary border border-accent-red/30 rounded hover:bg-accent-red/10 transition-colors"
              >
                <Square size={11} />
                Stop planner
              </button>
            )}
            {canResume && (
              <button
                onClick={onResume}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary border border-bg-border rounded hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <Play size={11} />
                Resume
              </button>
            )}
            {showApprove && (
              <button
                onClick={onResume}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-accent-green bg-accent-soft border border-accent-line rounded hover:bg-accent-green/20 transition-colors"
              >
                <CheckCircle2 size={11} />
                Approve &amp; merge
              </button>
            )}
          </div>
        </div>

        <PlannerApprovalGate missionId={flight.id} />

        {/* E7-INTEGRATE — tab strip: Overview / Journal */}
        <div className="flex items-center gap-0 border-b border-line-soft -mx-3.5 px-3.5">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-3 py-2 text-[11px] border-b-2 transition-colors ${
              activeTab === "overview"
                ? "text-text-primary border-accent-green"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => {
              setActiveTab("journal");
              setUnreadJournal(false);
            }}
            className={`inline-flex items-center gap-1 px-3 py-2 text-[11px] border-b-2 transition-colors ${
              activeTab === "journal"
                ? "text-text-primary border-accent-green"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            Journal
            {unreadJournal && (
              <span
                className="ml-0.5 w-1.5 h-1.5 rounded-full bg-accent-green inline-block"
                aria-label="New journal entry"
              />
            )}
          </button>
        </div>

        {activeTab === "overview" ? (
          isSpec ? (
            <MissionSpecPane missionId={flight.id} />
          ) : (
            <>
              <StatGrid
                flight={flight}
                tasks={tasks}
                sessions={sessions}
                dot={dot}
              />

              <div className="grid grid-cols-1 gap-3 lg:[grid-template-columns:1.4fr_1fr] flex-1 min-h-[260px]">
                <MilestonesCard flight={flight} tasks={tasks} />
                <TimelineCard flight={flight} />
              </div>
            </>
          )
        ) : (
          <JournalTab missionId={flight.id} />
        )}
      </div>
    </div>
  );
}

interface StatGridProps {
  flight: Flight;
  tasks: { done: number; total: number; approvals: number; hasInProgress: boolean };
  sessions: number;
  dot: DesignDot;
}

function StatGrid({ flight, tasks, sessions }: StatGridProps) {
  const tasksValueClass = tasks.hasInProgress
    ? "text-accent-green"
    : "text-text-primary";
  const approvalsValueClass =
    tasks.approvals > 0 ? "text-accent-amber" : "text-text-primary";

  // E8-UI — split the single "Cost" cell into Planner + Exec. The executor
  // cost is derived as `totalCost - plannerCost` so we don't need a new
  // backend field. The Planner cell carries a sub-line: on OAuth
  // subscriptions the dollar value is best-effort (no public quota
  // endpoint), so we surface the cumulative token count as the
  // authoritative measure; on API providers we just note "(API)".
  //
  // `plannerProvider` is now a first-class optional field on the Flight
  // interface (added alongside E8-ACCUM in `src/types/flight.ts`), so we
  // can read it directly without a narrowing cast.
  const plannerCost = flight.plannerCost ?? 0;
  const plannerTokens = flight.plannerTokens ?? 0;
  const executorCost = Math.max(0, (flight.totalCost ?? 0) - plannerCost);
  const plannerProvider = flight.plannerProvider;
  const isOAuth = plannerProvider === "claude-oauth";
  const plannerTitle =
    "Cumulative tokens spent by the planner session. On OAuth " +
    "subscriptions the dollar cost is best-effort (no public quota " +
    "endpoint); use the token count as the authoritative measure.";

  const cells: {
    label: string;
    value: string;
    sub?: string;
    valueClass?: string;
    title?: string;
  }[] = [
    {
      label: "Planner",
      value: formatCost(plannerCost),
      // On OAuth the dollar amount is best-effort, so the sub-line surfaces
      // the cumulative token count as the authoritative measure. When the
      // counter is still 0 (e.g. immediately after `start_mission_planner`
      // before any turn has settled) "≈0 tokens" reads weirdly, so fall
      // back to a plain provider label instead.
      sub: isOAuth
        ? plannerTokens > 0
          ? `≈${formatTokens(plannerTokens)} tokens`
          : "(OAuth)"
        : "(API)",
      title: plannerTitle,
    },
    { label: "Exec", value: formatCost(executorCost) },
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
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
      {cells.map((c) => (
        <div
          key={c.label}
          title={c.title}
          className="flex flex-col gap-0.5 px-2.5 py-2 bg-bg-secondary border border-bg-border rounded"
        >
          <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">
            {c.label}
          </span>
          <span
            className={`text-[14px] font-semibold font-mono leading-tight ${
              c.valueClass ?? "text-text-primary"
            }`}
          >
            {c.value}
          </span>
          {c.sub && (
            <span className="text-[9px] text-text-muted font-mono">
              {c.sub}
            </span>
          )}
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
    }[] = [];
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        out.push({
          id: t.id,
          title: t.title,
          done: t.status === "done",
          running:
            t.status === "running" ||
            t.status === "queued" ||
            t.status === "approval_needed",
          agent: t.agentConfigId || "—",
        });
      }
    }
    return out;
  }, [flight.milestones]);

  return (
    <div className="flex flex-col bg-bg-secondary border border-bg-border rounded overflow-hidden min-h-0">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-line-soft">
        <span className="text-[11px] font-semibold text-text-primary">
          Milestones
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-text-muted">
          {tasks.total > 0 ? `${tasks.done} / ${tasks.total} done` : "—"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-muted">
            No milestones defined yet.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 p-2.5">
            {rows.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 text-[11.5px]"
              >
                <span
                  className={`relative flex items-center justify-center w-3.5 h-3.5 rounded shrink-0 ${
                    m.done
                      ? "bg-accent-green border border-accent-green"
                      : m.running
                        ? "border border-accent-line"
                        : "border border-line-strong"
                  }`}
                >
                  {m.done ? (
                    <Check size={9} className="text-bg-primary" strokeWidth={3} />
                  ) : m.running ? (
                    <span className="relative flex w-1.5 h-1.5">
                      <span className="absolute inset-0 rounded-full bg-accent-amber opacity-60 animate-ping" />
                      <span className="relative w-1.5 h-1.5 rounded-full bg-accent-amber" />
                    </span>
                  ) : null}
                </span>
                <span
                  className={`flex-1 truncate ${
                    m.done
                      ? "text-text-muted line-through"
                      : "text-text-secondary"
                  }`}
                >
                  {m.title}
                </span>
                <span className="text-[10px] text-text-muted shrink-0 truncate max-w-[140px]">
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
    <div className="flex flex-col bg-bg-secondary border border-bg-border rounded overflow-hidden min-h-0">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-line-soft">
        <span className="text-[11px] font-semibold text-text-primary">
          Live timeline
        </span>
        <span className="flex-1" />
        {live ? (
          <span className="relative flex items-center justify-center w-2 h-2">
            <span className="absolute inset-0 rounded-full bg-accent-green opacity-60 animate-ping" />
            <span className="relative w-1.5 h-1.5 rounded-full bg-accent-green" />
          </span>
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-muted">
            No timeline events yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-2.5 text-[11px]">
            {events.map((e) => (
              <TimelineRow key={e.id} event={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({ event }: { event: CoordinationEvent }) {
  const dot = EVENT_DOT[event.type] ?? "muted";
  const actor = event.agentId || (event.type === "escalation" ? "you" : "system");
  return (
    <div className="flex items-start gap-2">
      <span className="font-mono text-[10px] text-text-muted w-[32px] shrink-0 pt-px">
        {eventTimeShort(event.timestamp)}
      </span>
      <span
        className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${DOT_BG[dot]}`}
      />
      <span className="flex-1 leading-snug">
        <span className="text-text-primary font-medium">{actor}</span>{" "}
        <span className="text-text-secondary">{event.summary}</span>
      </span>
    </div>
  );
}
