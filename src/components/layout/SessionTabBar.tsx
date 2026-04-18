import { Plus, X, Link } from "lucide-react";
import { useTabStore, type SessionTab } from "@/stores/tabStore";
import { useActivityStore, type PaneActivity } from "@/stores/activityStore";

interface SessionTabBarProps {
  cliType?: "claude" | "codex";
}

export function SessionTabBar({ cliType = "claude" }: SessionTabBarProps) {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const removeTab = useTabStore((s) => s.removeTab);

  const eventName = cliType === "codex" ? "packetade:new-codex-session" : "packetade:new-session";

  return (
    <div className="flex items-center h-8 bg-bg-secondary border-b border-bg-border overflow-x-auto">
      <div className="flex items-center h-full min-w-0">
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onActivate={() => setActiveTab(tab.id)}
            onClose={() => removeTab(tab.id)}
            closable={tabs.length > 1}
          />
        ))}
      </div>
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent(eventName));
        }}
        className="flex items-center justify-center w-7 h-7 ml-1 text-text-muted hover:text-accent-green hover:bg-bg-hover rounded transition-colors flex-shrink-0"
        title="New session"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function TabItem({
  tab,
  isActive,
  onActivate,
  onClose,
  closable,
}: {
  tab: SessionTab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  closable: boolean;
}) {
  const activity = useActivityStore((s) => s.activities[tab.id]);

  // Build rich tooltip
  const tooltipParts: string[] = [tab.name];
  if (activity?.agentState && activity.agentState !== "idle") {
    if (activity.agentState === "thinking" || activity.agentState === "responding") {
      tooltipParts.push(activity.agentState);
    } else if (activity.agentState === "tool_use" && activity.currentTool) {
      tooltipParts.push(
        `${activity.currentTool.toLowerCase()}${activity.currentFile ? ` ${activity.currentFile}` : ""}`
      );
    } else if (activity.agentState === "approval_needed") {
      tooltipParts.push("needs approval");
    }
  }
  if (tab.durationMs > 0) {
    const mins = Math.floor(tab.durationMs / 60000);
    const secs = Math.floor((tab.durationMs % 60000) / 1000);
    tooltipParts.push(`${mins}m ${secs}s`);
  }
  const tooltip = tooltipParts.join(" — ");

  // Determine dot color from activity state (prefer granular agent state over tab status)
  const dotColor = activity?.agentState
    ? getActivityDotColor(activity.agentState)
    : getStatusColor(tab.status);
  const shouldPulse =
    activity?.agentState === "thinking" ||
    activity?.agentState === "tool_use" ||
    activity?.agentState === "responding" ||
    activity?.agentState === "approval_needed" ||
    tab.status === "thinking" ||
    tab.status === "running" ||
    tab.status === "waiting_approval";

  return (
    <div
      className={`group flex items-center gap-2 h-full px-3 border-r border-bg-border cursor-pointer transition-colors min-w-0 max-w-[220px] ${
        isActive
          ? "bg-bg-primary text-text-primary border-b-2 border-b-accent-green"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }`}
      onClick={onActivate}
      title={tooltip}
    >
      {/* Status dot */}
      <div
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor} ${shouldPulse ? "animate-pulse" : ""}`}
      />

      {/* Session name */}
      <span className="text-[11px] truncate">{tab.name}</span>

      {/* Ticket badge */}
      {tab.ticketId && (
        <span className="flex items-center gap-0.5 text-[9px] px-1 py-0 bg-accent-purple/20 text-accent-purple rounded flex-shrink-0">
          <Link size={8} />
          {tab.ticketId}
        </span>
      )}

      {/* Status label */}
      <span className="text-[10px] text-text-muted truncate flex-shrink-0">
        {tab.statusLabel}
      </span>

      {/* Close button */}
      {closable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          title="Close session"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

function getActivityDotColor(state: PaneActivity["agentState"]): string {
  switch (state) {
    case "tool_use":
    case "responding":
      return "bg-accent-green";
    case "thinking":
      return "bg-accent-blue";
    case "approval_needed":
      return "bg-accent-amber";
    case "idle":
    default:
      return "bg-text-muted";
  }
}

function getStatusColor(status: SessionTab["status"]): string {
  switch (status) {
    case "idle":
      return "bg-text-muted";
    case "starting":
      return "bg-accent-amber";
    case "thinking":
      return "bg-accent-blue";
    case "running":
      return "bg-accent-green";
    case "waiting_approval":
      return "bg-accent-amber";
    case "waiting_input":
      return "bg-accent-amber";
    case "done":
      return "bg-accent-purple";
    case "error":
      return "bg-accent-red";
    default:
      return "bg-text-muted";
  }
}
