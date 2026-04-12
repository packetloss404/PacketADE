import { useState } from "react";
import { Target, ChevronDown, ChevronRight } from "lucide-react";
import { FlightHeaderTile } from "./FlightHeaderTile";
import { FlightStatStrip } from "./FlightStatStrip";
import { MilestonesPanel } from "./MilestonesPanel";
import { FlightExecutionPanel } from "./FlightExecutionPanel";
import { ApprovalsTile } from "./ApprovalsTile";
import { TimelineTile } from "./TimelineTile";
import type { Flight } from "@/types/flight";

interface FlightDetailProps {
  flight: Flight | null;
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-bg-border rounded overflow-hidden bg-bg-primary">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 bg-bg-secondary border-b border-bg-border text-[11px] font-semibold text-text-secondary uppercase tracking-wide hover:bg-bg-hover transition-colors"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {title}
      </button>
      {open && <div className="max-h-[280px] overflow-y-auto">{children}</div>}
    </div>
  );
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

  const status = flight.status;
  const isExecuting = status === "active" || status === "paused";
  const isPlanning = status === "draft" || status === "planning" || status === "ready";
  const isReview = status === "review";
  const isTerminal = status === "done" || status === "failed" || status === "cancelled";

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-bg-primary">
      <FlightHeaderTile flight={flight} />
      <FlightStatStrip flight={flight} />

      {/* Planning phase: full-width milestones */}
      {isPlanning && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary">
            <MilestonesPanel flight={flight} />
          </div>
        </div>
      )}

      {/* Execution phase: terminals dominate, collapsible panels below */}
      {isExecuting && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 min-h-[200px]">
            <FlightExecutionPanel flight={flight} />
          </div>
          <div className="px-4 py-2 space-y-2 overflow-y-auto max-h-[40%] border-t border-bg-border">
            <CollapsibleSection title="Milestones" defaultOpen={false}>
              <MilestonesPanel flight={flight} />
            </CollapsibleSection>
            <CollapsibleSection title="Approvals" defaultOpen={true}>
              <ApprovalsTile flight={flight} />
            </CollapsibleSection>
            <CollapsibleSection title="Timeline" defaultOpen={false}>
              <TimelineTile flight={flight} />
            </CollapsibleSection>
          </div>
        </div>
      )}

      {/* Review phase: approvals prominent */}
      {isReview && (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 space-y-3">
            <div className="border border-accent-amber/30 rounded overflow-hidden bg-bg-primary">
              <ApprovalsTile flight={flight} />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
                <MilestonesPanel flight={flight} />
              </div>
              <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
                <TimelineTile flight={flight} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Terminal phase: summary */}
      {isTerminal && (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 space-y-3">
            <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px]">
              <TimelineTile flight={flight} />
            </div>
            <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px]">
              <MilestonesPanel flight={flight} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
