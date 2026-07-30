import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MONITOR_WINDOW_QUERY_KEY } from "@/lib/brand";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import type { MonitorLease, MonitorRoute } from "@/types/monitor";
import { openConversationInAgents } from "@/stores/sessionGlue";
import { recordWorkspaceAgentsEvent } from "@/stores/workspaceAgentsDogfoodStore";

export function isMonitorBoot(): boolean {
  return new URLSearchParams(window.location.search).get(MONITOR_WINDOW_QUERY_KEY) === "monitor";
}

export function monitorLabelFromLocation(): string {
  return new URLSearchParams(window.location.search).get("label") ?? "";
}

export async function openMonitorWindow(route: MonitorRoute): Promise<MonitorLease> {
  const lease = await invoke<MonitorLease>("open_monitor_window", { route });
  recordWorkspaceAgentsEvent(
    route.kind === "flight" ? "flight_monitor_opened" : "agent_monitor_opened",
  );
  return lease;
}

export async function getMonitorWindowRoute(label: string): Promise<MonitorLease> {
  return invoke<MonitorLease>("get_monitor_window_route", { label });
}

export async function closeMonitorWindow(label: string): Promise<void> {
  return invoke("close_monitor_window", { label });
}

export async function focusMonitorRouteInMain(label: string): Promise<void> {
  return invoke("focus_monitor_route_in_main", { label });
}

export function installMonitorMainRouter(): Promise<UnlistenFn> {
  return listen<MonitorRoute>("monitor-window:focus-main", ({ payload }) => {
    if (payload.kind === "flight") {
      useFlightStore.getState().setActiveFlight(payload.flightId);
      useAppStore.getState().setActiveView("flights");
    } else {
      openConversationInAgents(payload.conversationId);
    }
  });
}
