import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorRoute } from "@/types/monitor";

const mocks = vi.hoisted(() => ({
  listener: null as
    | ((event: { payload: MonitorRoute }) => void)
    | null,
  openConversationInAgents: vi.fn(),
  setActiveFlight: vi.fn(),
  setActiveView: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (
      _event: string,
      listener: (event: { payload: MonitorRoute }) => void,
    ) => {
      mocks.listener = listener;
      return Promise.resolve(() => {});
    },
  ),
}));
vi.mock("@/stores/sessionGlue", () => ({
  openConversationInAgents: mocks.openConversationInAgents,
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({ setActiveFlight: mocks.setActiveFlight }),
  },
}));
vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ setActiveView: mocks.setActiveView }),
  },
}));

import { installMonitorMainRouter } from "@/lib/monitorWindows";

describe("Monitor main-window routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listener = null;
  });

  it("returns agent projections to the first-class Agents route", async () => {
    await installMonitorMainRouter();

    mocks.listener?.({
      payload: {
        kind: "agent_conversation",
        conversationId: "conv-1",
      },
    });

    expect(mocks.openConversationInAgents).toHaveBeenCalledWith("conv-1");
    expect(mocks.setActiveView).not.toHaveBeenCalledWith("workspace");
  });

  it("keeps Flight projections routed to Flight Deck", async () => {
    await installMonitorMainRouter();

    mocks.listener?.({
      payload: { kind: "flight", flightId: "flight-1" },
    });

    expect(mocks.setActiveFlight).toHaveBeenCalledWith("flight-1");
    expect(mocks.setActiveView).toHaveBeenCalledWith("flights");
  });
});
