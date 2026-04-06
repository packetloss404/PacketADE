import { Plus } from "lucide-react";
import { FLIGHT_STATUS_CONFIG } from "@/lib/flight-colors";
import type { FlightStatus } from "@/types/flight";

interface StatusStripProps {
  statusCounts: Record<FlightStatus, number>;
  total: number;
  onNewFlight?: () => void;
}

const DISPLAY_STATUSES: FlightStatus[] = ["active", "paused", "review", "done", "draft", "failed", "cancelled"];

export function StatusStrip({ statusCounts, total, onNewFlight }: StatusStripProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-bg-secondary border-b border-bg-border">
      <span className="text-[11px] text-text-muted mr-1">
        {total} flight{total !== 1 ? "s" : ""}
      </span>
      <div className="w-px h-4 bg-bg-border" />
      {DISPLAY_STATUSES.map((s) => {
        const cfg = FLIGHT_STATUS_CONFIG[s];
        if (statusCounts[s] === 0) return null;
        return (
          <span key={s} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${cfg.bg} ${cfg.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            {cfg.label} {statusCounts[s]}
          </span>
        );
      })}
      {onNewFlight && (
        <>
          <div className="flex-1" />
          <button
            onClick={onNewFlight}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
          >
            <Plus size={12} />
            New Flight
          </button>
        </>
      )}
    </div>
  );
}
