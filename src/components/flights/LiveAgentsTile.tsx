import { useMemo } from "react";
import { Activity } from "lucide-react";
import { useActivityStore } from "@/stores/activityStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { ACTIVITY_DOT_COLORS } from "@/lib/flight-colors";
import { relativeTime } from "@/lib/time";
import type { Flight } from "@/types/flight";

interface LiveAgentsTileProps {
  flight: Flight;
}

export function LiveAgentsTile({ flight }: LiveAgentsTileProps) {
  const activities = useActivityStore((s) => s.activities);
  const runningTasks = useOrchestrationStore((s) => s.getRunningTasksForFlight(flight.id));
  const allTasks = flight.milestones.flatMap((m) => m.tasks);

  const entries = useMemo(() => {
    return runningTasks
      .map((rt) => {
        const task = allTasks.find((t) => t.id === rt.taskId);
        return {
          paneId: rt.paneId,
          taskId: rt.taskId,
          agentConfigId: rt.agentConfigId,
          taskTitle: task?.title ?? rt.agentConfigId,
          activity: activities[rt.paneId],
        };
      })
      .sort((a, b) => (b.activity?.lastActivityAt ?? 0) - (a.activity?.lastActivityAt ?? 0));
  }, [runningTasks, allTasks, activities]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <Activity size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Live Agents
        </span>
        <span className="text-[10px] text-text-muted">({entries.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {entries.length === 0 ? (
          <p className="text-[10px] text-text-muted py-1">
            No agents linked. Launch the flight to start agents.
          </p>
        ) : (
          <div className="space-y-1.5">
            {entries.map(({ paneId, agentConfigId, taskTitle, activity }) => {
              const state = activity?.agentState ?? "idle";
              const dotColor = ACTIVITY_DOT_COLORS[state] ?? "bg-text-muted";
              return (
                <div key={paneId} className="flex items-start gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dotColor}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[11px] font-medium text-text-primary truncate">{taskTitle}</span>
                      <span className="text-[10px] text-text-muted">{agentConfigId}</span>
                      <span className="text-[10px] text-text-muted">{state}</span>
                    </div>
                    {activity?.currentTool && (
                      <p className="text-[10px] text-text-secondary truncate">
                        tool: {activity.currentTool}
                      </p>
                    )}
                    {activity?.currentFile && (
                      <p className="text-[10px] text-text-muted truncate font-mono">
                        {activity.currentFile}
                      </p>
                    )}
                    {activity?.lastActivityAt && (
                      <p className="text-[10px] text-text-muted">
                        {relativeTime(activity.lastActivityAt)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
