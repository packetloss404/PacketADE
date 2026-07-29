import { afterEach, describe, expect, it } from "vitest";
import { MONITOR_WINDOW_QUERY_KEY } from "@/lib/brand";
import { isMonitorBoot, monitorLabelFromLocation } from "@/lib/monitorWindows";

const originalUrl = window.location.href;

afterEach(() => {
  window.history.replaceState({}, "", originalUrl);
});

describe("Monitor window boot routing", () => {
  it("recognizes only the branded monitor query value", () => {
    window.history.replaceState(
      {},
      "",
      `/index.html?${MONITOR_WINDOW_QUERY_KEY}=monitor&label=monitor-main`,
    );
    expect(isMonitorBoot()).toBe(true);
    expect(monitorLabelFromLocation()).toBe("monitor-main");

    window.history.replaceState(
      {},
      "",
      `/index.html?${MONITOR_WINDOW_QUERY_KEY}=main&label=monitor-main`,
    );
    expect(isMonitorBoot()).toBe(false);
  });

  it("returns an empty label for malformed or ordinary app URLs", () => {
    window.history.replaceState({}, "", "/index.html");
    expect(isMonitorBoot()).toBe(false);
    expect(monitorLabelFromLocation()).toBe("");
  });
});
