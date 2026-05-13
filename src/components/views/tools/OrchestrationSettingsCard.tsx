import { GitBranch, Layers3 } from "lucide-react";
import { useOrchestrationStore } from "@/stores/orchestrationStore";

const MIN_PARALLEL_SESSIONS = 1;
const MAX_PARALLEL_SESSIONS = 12;

export function OrchestrationSettingsCard() {
  const maxParallelSessions = useOrchestrationStore((s) => s.maxParallelSessions);
  const milestoneGating = useOrchestrationStore((s) => s.milestoneGating);
  const setMaxParallelSessions = useOrchestrationStore((s) => s.setMaxParallelSessions);
  const setMilestoneGating = useOrchestrationStore((s) => s.setMilestoneGating);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <GitBranch size={12} className="text-accent-blue" />
        Missions
      </h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-text-secondary">Max parallel sessions</div>
            <div className="text-[10px] text-text-muted">
              Active mission tasks allowed to launch at once.
            </div>
          </div>
          <input
            type="number"
            min={MIN_PARALLEL_SESSIONS}
            max={MAX_PARALLEL_SESSIONS}
            value={maxParallelSessions}
            onChange={(e) => setMaxParallelSessions(Number(e.target.value))}
            className="w-16 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-green"
          />
        </div>

        <label className="flex items-center justify-between gap-3 cursor-pointer group">
          <div className="min-w-0">
            <div className="text-[11px] text-text-secondary group-hover:text-text-primary transition-colors">
              Milestone gating
            </div>
            <div className="text-[10px] text-text-muted">
              Pause between milestones for review before the next batch starts.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMilestoneGating(!milestoneGating)}
            className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
              milestoneGating ? "bg-accent-green" : "bg-bg-elevated"
            }`}
          >
            <span
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                milestoneGating ? "left-[16px]" : "left-[2px]"
              }`}
            />
          </button>
        </label>

        <div className="flex items-center gap-2 text-[10px] text-text-muted bg-bg-primary border border-bg-border rounded px-3 py-2">
          <Layers3 size={11} className="text-accent-amber flex-shrink-0" />
          <span>Range is clamped to {MIN_PARALLEL_SESSIONS}-{MAX_PARALLEL_SESSIONS} sessions.</span>
        </div>
      </div>
    </div>
  );
}
