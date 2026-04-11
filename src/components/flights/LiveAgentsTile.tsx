import { useMemo } from "react";
import { Activity } from "lucide-react";
import { useActivityStore } from "@/stores/activityStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { ACTIVITY_DOT_COLORS } from "@/lib/flight-colors";
import { relativeTime } from "@/lib/time";
import type { Flight } from "@/types/flight";

interface LiveAgentsTileProps {
  flight: Flight;
}

export function LiveAgentsTile({ flight }: LiveAgentsTileProps) {
  const activities = useActivityStore((s) => s.activities);
  const panes = useLayoutStore((s) => s.panes);

  const entries = useMemo(() => {
    const linkedSet = new Set(flight.linkedSessionIds);
    const out: Array<{
      paneId: string;
      sessionId: string;
      cliCommand: string;
      activity: (typeof activities)[string] | undefined;
    }> = [];
    for (const pane of panes) {
      if (!pane.sessionId || !linkedSet.has(pane.sessionId)) continue;
      out.push({
        paneId: pane.id,
        sessionId: pane.sessionId,
        cliCommand: pane.cliCommand ?? "agent",
        activity: activities[pane.id],
      });
    }
    return out.sort((a, b) => (b.activity?.lastActivityAt ?? 0) - (a.activity?.lastActivityAt ?? 0));
  }, [flight.linkedSessionIds, panes, activities]);

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
            No agents linked. Click Launch Workspace to start.
          </p>
        ) : (
          <div className="space-y-1.5">
            {entries.map(({ paneId, cliCommand, activity }) => {
              const state = activity?.agentState ?? "idle";
              const dotColor = ACTIVITY_DOT_COLORS[state] ?? "bg-text-muted";
              return (
                <div key={paneId} className="flex items-start gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dotColor}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[11px] font-medium text-text-primary">{cliCommand}</span>
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
