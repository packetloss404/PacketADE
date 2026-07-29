import type { ReactNode } from "react";
import {
  Terminal,
  CheckCircle,
  XCircle,
  Plane,
  Trash2,
  Clock,
  StickyNote,
} from "lucide-react";
import { relativeTime } from "@/lib/time";
import type { MemoryEvent } from "@/types/memory";
import type { Flight } from "@/types/flight";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { focusConversationDeepLink } from "@/stores/sessionGlue";
import { ProvenanceChip } from "@/components/common/ProvenanceChip";

interface MemoryEventCardProps {
  event: MemoryEvent;
  onDelete: () => void;
}

/** Navigate to the Flights surface with the given flight selected — the same
 *  pair GitDashboard's openReviewFlight uses (setActiveFlight + flights view). */
function navigateToFlight(flightId: string): void {
  useFlightStore.getState().setActiveFlight(flightId);
  useAppStore.getState().setActiveView("flights");
}

/** The flight that owns a task id, if any lives in the store. Mirrors the
 *  flightStore's own milestone→task walk. */
function findFlightForTask(flights: Flight[], taskId: string): Flight | undefined {
  return flights.find((f) => f.milestones.some((m) => m.tasks.some((t) => t.id === taskId)));
}

/**
 * A compact, keyboard-activatable deep-link rendered inline in place of inert
 * provenance text. Subtle by default; reveals a dotted underline + accent-blue
 * on hover/focus (the app's `text-accent-blue`/hover affordance). Callers only
 * render this when the target is known to resolve — a dangling target is
 * rendered as plain text by the card instead, so there is never a dead link.
 */
function ProvenanceLink({
  children,
  title,
  onClick,
  className = "",
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-sm underline-offset-2 transition-colors hover:text-accent-blue hover:underline hover:decoration-dotted focus-visible:text-accent-blue focus-visible:underline focus-visible:decoration-dotted focus-visible:outline-none ${className}`}
    >
      {children}
    </button>
  );
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
    <div className="bg-bg-secondary border border-bg-border rounded-md hover:border-line-strong transition-colors group overflow-hidden">
      <div className="px-3 py-2.5">
        {event.type === "session_completed" && <SessionCard event={event} />}
        {event.type === "task_completed" && <TaskCard event={event} />}
        {event.type === "flight_completed" && <FlightCard event={event} />}
        {event.type === "manual_note" && <ManualNoteCard event={event} />}
      </div>
      <div className="flex items-center justify-between px-3 py-1 bg-bg-primary border-t border-bg-border text-[9.5px] text-text-faint">
        <span className="inline-flex items-center gap-1">
          <Clock size={9} />
          {relativeTime(event.timestamp)}
        </span>
        <span className="inline-flex items-center gap-2">
          <ProvenanceChip envelope={event.provenance} force />
          <span className="font-mono text-text-faint">{event.id}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-0.5 text-text-faint hover:text-accent-red opacity-0 group-hover:opacity-100 transition-all rounded"
            title="Delete event"
          >
            <Trash2 size={9} />
          </button>
        </span>
      </div>
    </div>
  );
}

function TypeChip({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "accent";
}) {
  const cls =
    tone === "accent"
      ? "bg-accent-soft text-accent-green"
      : "bg-bg-elevated text-text-faint";
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "green" | "red" | "muted";
}) {
  const cls =
    tone === "green"
      ? "bg-accent-green/15 text-accent-green"
      : tone === "red"
        ? "bg-accent-red/15 text-accent-red"
        : "bg-bg-elevated text-text-muted";
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>
      {label}
    </span>
  );
}

function FilesRow({ files }: { files: string[] }) {
  if (!files?.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {files.slice(0, 6).map((f, i) => (
        <span
          key={i}
          className="font-mono text-[9.5px] px-1.5 py-0.5 rounded bg-bg-primary border border-bg-border text-text-faint"
        >
          {f}
        </span>
      ))}
      {files.length > 6 && (
        <span className="text-[9.5px] text-text-faint px-1 py-0.5">
          +{files.length - 6}
        </span>
      )}
    </div>
  );
}

function SessionCard({
  event,
}: {
  event: Extract<MemoryEvent, { type: "session_completed" }>;
}) {
  const p = event.payload;
  const tone =
    p.status === "done" ? "green" : p.status === "error" ? "red" : "muted";
  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        <Terminal size={11} className="text-accent-green flex-shrink-0" />
        {p.sessionId ? (
          // sessionId === conversationId for API agents. focusConversationDeepLink
          // existence-checks the conversation: if it vanished it skips the tile
          // focus and just switches to the workspace view (no crash, no dead
          // link), so the link is always safe to offer when a sessionId exists.
          <ProvenanceLink
            title="Open conversation"
            onClick={() => focusConversationDeepLink(p.sessionId)}
            className="text-[11px] font-semibold text-text-primary"
          >
            {p.agentId}
          </ProvenanceLink>
        ) : (
          <span className="text-[11px] font-semibold text-text-primary">
            {p.agentId}
          </span>
        )}
        <StatusPill label={p.status} tone={tone} />
        <span className="text-[10px] text-text-faint">
          {formatDuration(p.durationMs)}
        </span>
        <div className="flex-1" />
        <TypeChip label="session" />
      </div>
      {p.summary && (
        <p className="text-[11px] text-text-secondary leading-relaxed">
          {p.summary}
        </p>
      )}
      <FilesRow files={p.filesModified} />
    </>
  );
}

// M10: read-compat only. Nothing emits `task_completed` anymore (the autonomous
// task scheduler that did was removed in July 2026), and the Timeline no longer
// offers a "Tasks" filter chip — but this renderer stays so any events persisted
// before that removal still display under the "All" filter instead of vanishing.
function TaskCard({
  event,
}: {
  event: Extract<MemoryEvent, { type: "task_completed" }>;
}) {
  const p = event.payload;
  const flights = useFlightStore((s) => s.flights);
  // taskId → the flight that owns it (search milestones[].tasks). No owning
  // flight in the store ⇒ render inert (no dead link).
  const owningFlight = findFlightForTask(flights, p.taskId);
  // flightId guard: only link the flight line when the flight still exists.
  const flightExists = flights.some((f) => f.id === p.flightId);
  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        {p.success ? (
          <CheckCircle
            size={11}
            className="text-accent-green flex-shrink-0"
          />
        ) : (
          <XCircle size={11} className="text-accent-red flex-shrink-0" />
        )}
        {owningFlight ? (
          <ProvenanceLink
            title="Open flight for this task"
            onClick={() => navigateToFlight(owningFlight.id)}
            className="text-[11px] font-semibold text-text-primary truncate"
          >
            {p.taskTitle}
          </ProvenanceLink>
        ) : (
          <span className="text-[11px] font-semibold text-text-primary truncate">
            {p.taskTitle}
          </span>
        )}
        <StatusPill
          label={p.success ? "passed" : "failed"}
          tone={p.success ? "green" : "red"}
        />
        <span className="text-[10px] text-text-faint">
          {formatDuration(p.durationMs)}
        </span>
        <div className="flex-1" />
        <TypeChip label="task" />
      </div>
      <div className="text-[10px] text-text-faint mb-1">
        Flight:{" "}
        {flightExists ? (
          <ProvenanceLink
            title="Open flight"
            onClick={() => navigateToFlight(p.flightId)}
            className="text-text-muted"
          >
            {p.flightTitle}
          </ProvenanceLink>
        ) : (
          <span className="text-text-muted">{p.flightTitle}</span>
        )}
      </div>
      {p.summary && (
        <p className="text-[11px] text-text-secondary leading-relaxed">
          {p.summary}
        </p>
      )}
      {p.errors.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {p.errors.slice(0, 3).map((err, i) => (
            <p
              key={i}
              className="font-mono text-[10px] text-accent-red line-clamp-1"
            >
              {err}
            </p>
          ))}
        </div>
      )}
      <FilesRow files={p.filesChanged} />
    </>
  );
}

function ManualNoteCard({
  event,
}: {
  event: Extract<MemoryEvent, { type: "manual_note" }>;
}) {
  const p = event.payload;
  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        <StickyNote size={11} className="text-accent-amber flex-shrink-0" />
        <span className="text-[11px] font-semibold text-text-primary truncate">
          {p.summary}
        </span>
        <div className="flex-1" />
        <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-accent-amber/15 text-accent-amber">
          {p.source}
        </span>
      </div>
      {p.body && (
        <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-6 whitespace-pre-wrap">
          {p.body}
        </p>
      )}
      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.tags.map((t, i) => (
            <span
              key={i}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-bg-elevated text-text-faint"
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function FlightCard({
  event,
}: {
  event: Extract<MemoryEvent, { type: "flight_completed" }>;
}) {
  const p = event.payload;
  const flightExists = useFlightStore((s) => s.flights.some((f) => f.id === p.flightId));
  return (
    <>
      <div className="flex items-center gap-2 mb-1.5">
        <Plane size={11} className="text-accent-green flex-shrink-0" />
        {flightExists ? (
          <ProvenanceLink
            title="Open flight"
            onClick={() => navigateToFlight(p.flightId)}
            className="text-[11px] font-semibold text-text-primary"
          >
            {p.flightTitle}
          </ProvenanceLink>
        ) : (
          <span className="text-[11px] font-semibold text-text-primary">
            {p.flightTitle}
          </span>
        )}
        <div className="flex-1" />
        <TypeChip label="flight" tone="accent" />
      </div>
      <p className="text-[11px] text-text-secondary leading-relaxed mb-2">
        {p.summary}
      </p>
      {p.lessonsLearned.length > 0 && (
        <div className="mb-1.5">
          <div className="text-[9.5px] font-semibold tracking-[0.05em] uppercase text-text-secondary mb-1">
            Lessons
          </div>
          <ul className="m-0 p-0 list-none flex flex-col gap-1">
            {p.lessonsLearned.map((l, i) => (
              <li
                key={i}
                className="text-[10.5px] text-text-secondary leading-relaxed pl-2 border-l-2 border-accent-line"
              >
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.whatWorked.length > 0 && (
        <div className="mb-1">
          <span className="text-[9.5px] font-semibold tracking-[0.05em] uppercase text-accent-green">
            Worked
          </span>
          <span className="text-[10.5px] text-text-faint ml-2">
            {p.whatWorked.slice(0, 4).join(" · ")}
          </span>
        </div>
      )}
      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.tags.map((t, i) => (
            <span
              key={i}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent-soft text-accent-green"
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
