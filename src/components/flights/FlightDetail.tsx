import { Target } from "lucide-react";
import { FlightHeaderTile } from "./FlightHeaderTile";
import { FlightStatStrip } from "./FlightStatStrip";
import { MilestonesPanel } from "./MilestonesPanel";
import { LiveAgentsTile } from "./LiveAgentsTile";
import { ApprovalsTile } from "./ApprovalsTile";
import { TimelineTile } from "./TimelineTile";
import type { Flight } from "@/types/flight";

interface FlightDetailProps {
  flight: Flight | null;
}

export function FlightDetail({ flight }: FlightDetailProps) {
  if (!flight) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bg-primary">
        <div className="text-center max-w-sm">
          <Target size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-xs text-text-secondary">Select a flight from the left to see its mission control.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-bg-primary">
      <FlightHeaderTile flight={flight} />
      <FlightStatStrip flight={flight} />

      <div className="flex-1 overflow-y-auto">
        {/* Row 1: Milestones + Live Agents */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 px-4 py-3 border-b border-bg-border">
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
            <MilestonesPanel flight={flight} />
          </div>
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
            <LiveAgentsTile flight={flight} />
          </div>
        </div>

        {/* Row 2: Approvals + Timeline */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 px-4 py-3">
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
            <ApprovalsTile flight={flight} />
          </div>
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
            <TimelineTile flight={flight} />
          </div>
        </div>
      </div>
    </div>
  );
}
