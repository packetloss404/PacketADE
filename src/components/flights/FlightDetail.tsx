import { useState, useEffect } from "react";
import { Target, ChevronDown, ChevronRight, Rocket, Play, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { FlightHeaderTile } from "./FlightHeaderTile";
import { FlightStatStrip } from "./FlightStatStrip";
import { MilestonesPanel } from "./MilestonesPanel";
import { FlightExecutionPanel } from "./FlightExecutionPanel";
import { ApprovalsTile } from "./ApprovalsTile";
import { TimelineTile } from "./TimelineTile";
import { CoordinationFeed } from "./CoordinationFeed";
import { useDeployStore } from "@/stores/deployStore";
import { useAppStore } from "@/stores/appStore";
import { relativeTime } from "@/lib/time";
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

function DeploySection({ flight }: { flight: Flight }) {
  const { configs, runs, fetchConfigs, startRun } = useDeployStore();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // Find the latest run (runs are newest-first)
  const latestRun = runs.length > 0 ? runs[0] : null;
  const isDone = flight.status === "done";

  const handleDeploy = async (config: typeof configs[0]) => {
    setDeploying(true);
    try {
      await startRun(config);
    } finally {
      setDeploying(false);
    }
  };

  return (
    <CollapsibleSection title="Deploy" defaultOpen={isDone}>
      <div className={`p-3 space-y-2.5 ${isDone ? "border-l-2 border-accent-green" : ""}`}>
        {/* Latest run status */}
        {latestRun && (
          <div className="flex items-center gap-2 text-[11px]">
            {latestRun.status === "running" && (
              <>
                <Loader2 size={12} className="text-accent-blue animate-spin" />
                <span className="text-accent-blue font-medium">Deploying...</span>
              </>
            )}
            {latestRun.status === "success" && (
              <>
                <CheckCircle2 size={12} className="text-accent-green" />
                <span className="text-accent-green font-medium">Deploy succeeded</span>
              </>
            )}
            {latestRun.status === "failed" && (
              <>
                <XCircle size={12} className="text-accent-red" />
                <span className="text-accent-red font-medium">Deploy failed</span>
              </>
            )}
            {latestRun.status === "idle" && (
              <>
                <Clock size={12} className="text-text-muted" />
                <span className="text-text-muted">Idle</span>
              </>
            )}
            <span className="text-text-muted ml-auto">
              {latestRun.configName} &middot; {relativeTime(latestRun.startedAt)}
            </span>
          </div>
        )}

        {!latestRun && (
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <Rocket size={12} />
            <span>No deploys yet</span>
          </div>
        )}

        {/* Deploy action */}
        {configs.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {configs.map((config) => (
              <button
                key={config.name}
                onClick={() => handleDeploy(config)}
                disabled={deploying || latestRun?.status === "running"}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-accent-green/15 text-accent-green hover:bg-accent-green/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Play size={10} />
                Deploy {configs.length > 1 ? config.name : ""}
              </button>
            ))}
          </div>
        ) : (
          <button
            onClick={() => setActiveView("deploy")}
            className="text-[11px] text-accent-blue hover:underline cursor-pointer"
          >
            Configure deploy in Deploy view
          </button>
        )}
      </div>
    </CollapsibleSection>
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
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary">
            <MilestonesPanel flight={flight} />
          </div>
          <DeploySection flight={flight} />
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
            <CollapsibleSection title="Coordination" defaultOpen={false}>
              <CoordinationFeed flight={flight} />
            </CollapsibleSection>
            <DeploySection flight={flight} />
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
            <CollapsibleSection title="Coordination" defaultOpen={false}>
              <CoordinationFeed flight={flight} />
            </CollapsibleSection>
            <DeploySection flight={flight} />
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
            <CollapsibleSection title="Coordination" defaultOpen={false}>
              <CoordinationFeed flight={flight} />
            </CollapsibleSection>
            <DeploySection flight={flight} />
          </div>
        </div>
      )}
    </div>
  );
}
