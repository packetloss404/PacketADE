import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Target,
  ChevronDown,
  ChevronRight,
  Rocket,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Activity,
  Terminal as TerminalIcon,
  ShieldX,
  Check,
  X,
  LayoutList,
  Plus,
} from "lucide-react";
import { FlightHeaderTile } from "./FlightHeaderTile";
import { FlightStatStrip } from "./FlightStatStrip";
import { MilestonesPanel } from "./MilestonesPanel";
import { useDeployStore } from "@/stores/deployStore";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useActivityStore } from "@/stores/activityStore";
import { useIssueStore, type Issue, type IssueStatus } from "@/stores/issueStore";
import { TerminalPane } from "@/components/session/TerminalPane";
import { ACTIVITY_DOT_COLORS, ISSUE_STATUS_COLORS, ISSUE_STATUS_LABELS } from "@/lib/flight-colors";
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

// Slim per-operation approval banner — mirrors FlightDeck's overlay
function ApprovalBanner({ flight }: { flight: Flight }) {
  const pending = useMemo(() => {
    const out: { taskId: string; milestoneId: string; title: string; startedAt?: number }[] = [];
    for (const m of flight.milestones) {
      for (const t of m.tasks) {
        if (t.status === "approval_needed") {
          out.push({ taskId: t.id, milestoneId: m.id, title: t.title, startedAt: t.startedAt });
        }
      }
    }
    return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }, [flight.milestones]);

  if (pending.length === 0) return null;

  function approve(taskId: string) {
    void useOrchestrationStore.getState().onTaskApprovalResolved(taskId);
  }
  function deny(milestoneId: string, taskId: string) {
    useFlightStore.getState().updateTask(flight.id, milestoneId, taskId, { status: "cancelled" });
  }

  return (
    <div className="border border-accent-amber/40 bg-accent-amber/5 rounded">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-accent-amber/30">
        <ShieldX size={12} className="text-accent-amber" />
        <span className="text-[11px] font-semibold text-accent-amber uppercase tracking-wide">
          Pending Approval
        </span>
        <span className="text-[10px] text-text-muted">({pending.length})</span>
      </div>
      <div className="divide-y divide-bg-border">
        {pending.map((p) => (
          <div key={p.taskId} className="flex items-center gap-2 px-3 py-1.5">
            <span className="flex-1 text-[11px] text-text-primary truncate">{p.title}</span>
            <button
              onClick={() => approve(p.taskId)}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
            >
              <Check size={10} /> Approve
            </button>
            <button
              onClick={() => deny(p.milestoneId, p.taskId)}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-accent-red hover:bg-accent-red/10 border border-bg-border rounded transition-colors"
            >
              <X size={10} /> Deny
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Linked Issues — issues with flightId === flight.id
function LinkedIssuesPanel({ flight }: { flight: Flight }) {
  const issues = useIssueStore((s) => s.issues);
  const assignToFlight = useIssueStore((s) => s.assignToFlight);
  const moveIssue = useIssueStore((s) => s.moveIssue);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const linked = useMemo(
    () => issues.filter((i) => i.flightId === flight.id),
    [issues, flight.id],
  );

  const unlinkedCount = useMemo(
    () => issues.filter((i) => i.flightId === null).length,
    [issues],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <LayoutList size={12} className="text-accent-purple" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Linked Issues
        </span>
        <span className="text-[10px] text-text-muted">({linked.length})</span>
        <button
          onClick={() => setActiveView("issues")}
          className="ml-auto flex items-center gap-1 text-[10px] text-accent-purple hover:text-accent-purple/80 transition-colors"
          title="Open the Issues board to create or assign issues"
        >
          <Plus size={11} />
          Manage in Issues
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {linked.length === 0 ? (
          <p className="text-[10px] text-text-muted px-1 py-1">
            No issues linked to this mission.{" "}
            {unlinkedCount > 0 ? (
              <button
                onClick={() => setActiveView("issues")}
                className="text-accent-purple hover:underline"
              >
                Assign one of the {unlinkedCount} unassigned issues
              </button>
            ) : (
              <span>Create issues in the Issues view and assign them here.</span>
            )}
          </p>
        ) : (
          linked.map((i) => (
            <LinkedIssueRow
              key={i.id}
              issue={i}
              onUnlink={() => assignToFlight(i.id, null)}
              onChangeStatus={(status) => moveIssue(i.id, status)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LinkedIssueRow({
  issue,
  onUnlink,
  onChangeStatus,
}: {
  issue: Issue;
  onUnlink: () => void;
  onChangeStatus: (status: IssueStatus) => void;
}) {
  const dot = ISSUE_STATUS_COLORS[issue.status] ?? "bg-text-muted";
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-elevated border border-bg-border rounded text-[11px] group">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      <span className="font-mono text-[10px] text-text-muted shrink-0">{issue.ticketId}</span>
      <span className="flex-1 text-text-primary truncate">{issue.title}</span>
      <select
        value={issue.status}
        onChange={(e) => onChangeStatus(e.target.value as IssueStatus)}
        className="text-[10px] bg-bg-primary text-text-secondary border border-bg-border rounded px-1 py-0.5 outline-none focus:border-accent-purple"
        title="Change status"
      >
        {(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((s) => (
          <option key={s} value={s}>
            {ISSUE_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <button
        onClick={onUnlink}
        className="p-0.5 text-text-muted hover:text-accent-red transition-colors opacity-0 group-hover:opacity-100"
        title="Unlink from mission"
      >
        <X size={11} />
      </button>
    </div>
  );
}

// Live execution — terminal tabs for running tasks
function ExecutionPanel({ flight }: { flight: Flight }) {
  const runningTasksMap = useOrchestrationStore((s) => s.runningTasks);
  const runningTasks = useMemo(
    () => Array.from(runningTasksMap.values()).filter((rt) => rt.flightId === flight.id),
    [runningTasksMap, flight.id],
  );
  const panes = useLayoutStore((s) => s.panes);
  const activities = useActivityStore((s) => s.activities);
  const allTasks = flight.milestones.flatMap((m) => m.tasks);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const prevRunningRef = useRef<string[]>([]);

  useEffect(() => {
    const runningIds = runningTasks.map((rt) => rt.taskId);
    if (runningIds.length > 0 && (!activeTab || !runningIds.includes(activeTab))) {
      setActiveTab(runningIds[0]);
    }
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
              <span className="truncate max-w-[120px]">{task?.title ?? rt.agentConfigId}</span>
              <span className="text-[9px] text-text-muted">{rt.agentConfigId}</span>
            </button>
          );
        })}
      </div>

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

function DeploySection({ flight }: { flight: Flight }) {
  const { configs, runs, fetchConfigs, startRun } = useDeployStore();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

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
          <p className="text-xs text-text-secondary">
            Select a mission from the left to see its mission control.
          </p>
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

      {isPlanning && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <ApprovalBanner flight={flight} />
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary">
            <MilestonesPanel flight={flight} />
          </div>
          <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px]">
            <LinkedIssuesPanel flight={flight} />
          </div>
          <DeploySection flight={flight} />
        </div>
      )}

      {isExecuting && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 min-h-[200px]">
            <ExecutionPanel flight={flight} />
          </div>
          <div className="px-4 py-2 space-y-2 overflow-y-auto max-h-[40%] border-t border-bg-border">
            <ApprovalBanner flight={flight} />
            <CollapsibleSection title="Milestones" defaultOpen={false}>
              <MilestonesPanel flight={flight} />
            </CollapsibleSection>
            <CollapsibleSection title="Linked Issues" defaultOpen={false}>
              <LinkedIssuesPanel flight={flight} />
            </CollapsibleSection>
            <DeploySection flight={flight} />
          </div>
        </div>
      )}

      {isReview && (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 space-y-3">
            <ApprovalBanner flight={flight} />
            <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px] max-h-[320px]">
              <MilestonesPanel flight={flight} />
            </div>
            <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px]">
              <LinkedIssuesPanel flight={flight} />
            </div>
            <DeploySection flight={flight} />
          </div>
        </div>
      )}

      {isTerminal && (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 space-y-3">
            <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px]">
              <MilestonesPanel flight={flight} />
            </div>
            <div className="border border-bg-border rounded overflow-hidden bg-bg-primary min-h-[180px]">
              <LinkedIssuesPanel flight={flight} />
            </div>
            <DeploySection flight={flight} />
          </div>
        </div>
      )}
    </div>
  );
}
