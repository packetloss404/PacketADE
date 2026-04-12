import { useState, useEffect, useRef } from "react";
import {
  Target,
  Pause,
  Play,
  XCircle,
  MoreVertical,
  Trash2,
  Rocket,
} from "lucide-react";
import { useFlightStore } from "@/stores/flightStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { FLIGHT_STATUS_CONFIG, FLIGHT_PRIORITY_COLORS } from "@/lib/flight-colors";
import type { Flight, FlightStatus, FlightPriority } from "@/types/flight";

const ALL_STATUSES: FlightStatus[] = ["draft", "planning", "ready", "active", "paused", "review", "done", "failed", "cancelled"];
const ALL_PRIORITIES: FlightPriority[] = ["low", "medium", "high", "critical"];

interface FlightHeaderTileProps {
  flight: Flight;
}

export function FlightHeaderTile({ flight }: FlightHeaderTileProps) {
  const updateFlight = useFlightStore((s) => s.updateFlight);
  const deleteFlight = useFlightStore((s) => s.deleteFlight);
  const launchFlight = useOrchestrationStore((s) => s.launchFlight);
  const pauseFlight = useOrchestrationStore((s) => s.pauseFlight);
  const resumeFlight = useOrchestrationStore((s) => s.resumeFlight);
  const cancelFlight = useOrchestrationStore((s) => s.cancelFlight);

  const [editingTitle, setEditingTitle] = useState(false);
  const [editingObjective, setEditingObjective] = useState(false);
  const [titleDraft, setTitleDraft] = useState(flight.title);
  const [objectiveDraft, setObjectiveDraft] = useState(flight.objective);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Reset drafts when flight changes
  useEffect(() => {
    setTitleDraft(flight.title);
    setObjectiveDraft(flight.objective);
    setEditingTitle(false);
    setEditingObjective(false);
  }, [flight.id, flight.title, flight.objective]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  function commitTitle() {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft !== flight.title) {
      updateFlight(flight.id, { title: titleDraft.trim() });
    } else {
      setTitleDraft(flight.title);
    }
  }

  function commitObjective() {
    setEditingObjective(false);
    if (objectiveDraft !== flight.objective) {
      updateFlight(flight.id, { objective: objectiveDraft });
    }
  }

  function handleDelete() {
    if (!window.confirm(`Delete flight "${flight.title}"? This cannot be undone.`)) return;
    deleteFlight(flight.id);
    setMenuOpen(false);
  }

  function handleLaunch() {
    void launchFlight(flight.id);
  }

  const status = flight.status;
  const cfg = FLIGHT_STATUS_CONFIG[status];
  const priorityColor = FLIGHT_PRIORITY_COLORS[flight.priority];
  const isLifecycleActive = status === "active" || status === "paused";
  const hasTasks = flight.milestones.some((m) => m.tasks.length > 0);
  const canLaunch = (status === "draft" || status === "ready") && hasTasks;

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-bg-border bg-bg-secondary">
      <Target size={16} className="text-accent-green shrink-0 mt-0.5" />

      <div className="flex flex-col min-w-0 flex-1 gap-1">
        {/* Title row */}
        <div className="flex items-center gap-2 flex-wrap">
          {editingTitle ? (
            <input
              autoFocus
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setTitleDraft(flight.title);
                  setEditingTitle(false);
                }
              }}
              className="flex-1 text-sm font-semibold text-text-primary bg-transparent border-b border-accent-green focus:outline-none min-w-[160px]"
              placeholder="Flight title"
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="text-sm font-semibold text-text-primary hover:text-accent-green transition-colors truncate text-left"
              title="Click to edit"
            >
              {flight.title || "Untitled Mission"}
            </button>
          )}

          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded ${cfg.bg} ${cfg.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            {cfg.label}
          </span>

          <select
            value={flight.status}
            onChange={(e) => updateFlight(flight.id, { status: e.target.value as FlightStatus })}
            className="bg-bg-primary text-[10px] text-text-secondary border border-bg-border rounded px-1.5 py-0.5 outline-none focus:border-accent-green"
            title="Change status"
          >
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>{FLIGHT_STATUS_CONFIG[s].label}</option>
            ))}
          </select>

          <select
            value={flight.priority}
            onChange={(e) => updateFlight(flight.id, { priority: e.target.value as FlightPriority })}
            className={`bg-bg-primary text-[10px] border border-bg-border rounded px-1.5 py-0.5 outline-none focus:border-accent-green ${priorityColor}`}
            title="Change priority"
          >
            {ALL_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        </div>

        {/* Editable objective */}
        {editingObjective ? (
          <textarea
            autoFocus
            value={objectiveDraft}
            onChange={(e) => setObjectiveDraft(e.target.value)}
            onBlur={commitObjective}
            rows={2}
            className="w-full text-[11px] text-text-secondary bg-transparent border border-accent-green rounded px-1 py-0.5 resize-none focus:outline-none"
            placeholder="Objective (optional)"
          />
        ) : (
          <button
            onClick={() => setEditingObjective(true)}
            className="text-[11px] text-text-secondary hover:text-text-primary text-left"
            title="Click to edit"
          >
            {flight.objective || <span className="text-text-muted italic">Add an objective…</span>}
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {canLaunch && (
          <button
            onClick={handleLaunch}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
            title="Launch this flight — the orchestrator will assign agents and begin execution"
          >
            <Rocket size={11} />
            Launch Flight
          </button>
        )}

        {status === "review" && (
          <button
            onClick={() => void resumeFlight(flight.id)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
            title="Approve milestone and continue to the next"
          >
            <Play size={11} />
            Approve &amp; Continue
          </button>
        )}

        {isLifecycleActive && status === "active" && (
          <button
            onClick={() => void pauseFlight(flight.id)}
            className="p-1.5 text-text-muted hover:text-accent-amber hover:bg-bg-hover rounded transition-colors"
            title="Pause flight"
          >
            <Pause size={12} />
          </button>
        )}
        {isLifecycleActive && status === "paused" && (
          <button
            onClick={() => void resumeFlight(flight.id)}
            className="p-1.5 text-text-muted hover:text-accent-green hover:bg-bg-hover rounded transition-colors"
            title="Resume flight"
          >
            <Play size={12} />
          </button>
        )}
        {isLifecycleActive && (
          <button
            onClick={() => void cancelFlight(flight.id)}
            className="p-1.5 text-text-muted hover:text-accent-red hover:bg-bg-hover rounded transition-colors"
            title="Cancel flight"
          >
            <XCircle size={12} />
          </button>
        )}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            title="More actions"
          >
            <MoreVertical size={12} />
          </button>
          {menuOpen && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-bg-elevated border border-bg-border rounded shadow-xl z-30 py-1">
              <button
                onClick={handleDelete}
                className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[11px] text-accent-red hover:bg-accent-red/10 transition-colors"
              >
                <Trash2 size={12} />
                Delete flight
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
