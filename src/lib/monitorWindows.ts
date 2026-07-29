import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MONITOR_WINDOW_QUERY_KEY } from "@/lib/brand";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import type { MonitorLease, MonitorRoute } from "@/types/monitor";

export function isMonitorBoot(): boolean {
  return new URLSearchParams(window.location.search).get(MONITOR_WINDOW_QUERY_KEY) === "monitor";
}

export function monitorLabelFromLocation(): string {
  return new URLSearchParams(window.location.search).get("label") ?? "";
}

export async function openMonitorWindow(route: MonitorRoute): Promise<MonitorLease> {
  return invoke<MonitorLease>("open_monitor_window", { route });
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
      useAgentTaskStore.getState().selectConversation(payload.conversationId);
      useAppStore.getState().setActiveView("workspace");
    }
  });
}
