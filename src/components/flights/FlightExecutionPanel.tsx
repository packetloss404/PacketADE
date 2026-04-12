import { useState, useCallback, useRef, useEffect } from "react";
import { Activity, Terminal as TerminalIcon } from "lucide-react";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useActivityStore } from "@/stores/activityStore";
import { TerminalPane } from "@/components/session/TerminalPane";
import { ACTIVITY_DOT_COLORS } from "@/lib/flight-colors";
import type { Flight } from "@/types/flight";

interface FlightExecutionPanelProps {
  flight: Flight;
}

export function FlightExecutionPanel({ flight }: FlightExecutionPanelProps) {
  const runningTasks = useOrchestrationStore((s) => s.getRunningTasksForFlight(flight.id));
  const panes = useLayoutStore((s) => s.panes);
  const activities = useActivityStore((s) => s.activities);
  const allTasks = flight.milestones.flatMap((m) => m.tasks);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const prevRunningRef = useRef<string[]>([]);

  // Auto-select the first running task tab if none selected
  useEffect(() => {
    const runningIds = runningTasks.map((rt) => rt.taskId);
    if (runningIds.length > 0 && (!activeTab || !runningIds.includes(activeTab))) {
      setActiveTab(runningIds[0]);
    }
    // Auto-select newly spawned tasks
    const newTasks = runningIds.filter((id) => !prevRunningRef.current.includes(id));
    if (newTasks.length > 0) {
      setActiveTab(newTasks[0]);
    }
    prevRunningRef.current = runningIds;
  }, [runningTasks, activeTab]);

  const getPane = useCallback(
    (paneId: string) => panes.find((p) => p.id === paneId),
    [panes],
  );

  if (runningTasks.length === 0) {
    const doneTasks = allTasks.filter((t) => t.status === "done").length;
    const totalTasks = allTasks.length;
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <Activity size={20} className="text-text-muted" />
        <p className="text-[11px] text-text-muted">
          {flight.status === "active"
            ? "Waiting for tasks to be scheduled..."
            : flight.status === "done"
              ? `All ${totalTasks} tasks completed`
              : totalTasks > 0
                ? `${doneTasks}/${totalTasks} tasks completed`
                : "No tasks defined yet"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-bg-border bg-bg-secondary overflow-x-auto">
        <Activity size={11} className="text-accent-blue mr-1.5 flex-shrink-0" />
        {runningTasks.map((rt) => {
          const task = allTasks.find((t) => t.id === rt.taskId);
          const activity = activities[rt.paneId];
          const state = activity?.agentState ?? "idle";
          const dotColor = ACTIVITY_DOT_COLORS[state] ?? "bg-text-muted";
          const isActive = activeTab === rt.taskId;

          return (
            <button
              key={rt.taskId}
              onClick={() => setActiveTab(rt.taskId)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium rounded transition-colors flex-shrink-0 ${
                isActive
                  ? "bg-bg-primary text-text-primary border border-bg-border"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
              <span className="truncate max-w-[120px]">
                {task?.title ?? rt.agentConfigId}
              </span>
              <span className="text-[9px] text-text-muted">
                {rt.agentConfigId}
              </span>
            </button>
          );
        })}
      </div>

      {/* Terminal area */}
      <div className="flex-1 relative min-h-0">
        {runningTasks.map((rt) => {
          const pane = getPane(rt.paneId);
          if (!pane) return null;
          const isVisible = activeTab === rt.taskId;

          return (
            <div
              key={rt.taskId}
              className="absolute inset-0"
              style={{ display: isVisible ? "flex" : "none", flexDirection: "column" }}
            >
              <TerminalPane
                paneId={rt.paneId}
                cliCommand={pane.cliCommand}
                cliArgs={pane.cliArgs}
                initialPrompt={pane.initialPrompt}
                projectPath={pane.projectPath}
                taskId={rt.taskId}
                showCloseButton={false}
                onSessionCreated={(sessionId) => {
                  useOrchestrationStore.getState().attachSessionToTask(rt.taskId, sessionId);
                }}
                renderHeader={() => (
                  <div className="flex items-center gap-2 px-3 py-1 bg-bg-secondary border-b border-bg-border">
                    <TerminalIcon size={10} className="text-accent-green" />
                    <span className="text-[10px] text-text-secondary font-medium truncate">
                      {pane.cliCommand}
                    </span>
                    <span className="text-[9px] text-text-muted">
                      {allTasks.find((t) => t.id === rt.taskId)?.type}
                    </span>
                  </div>
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
