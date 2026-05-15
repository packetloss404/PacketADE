/**
 * E10-UI-TESTS — context-compaction listener wiring.
 *
 * Sibling Rust slices (E10-DETECT / E10-SUMMARIZE / E10-SWAP) emit two
 * scoped Tauri events when a planner session crosses the 150K-token
 * compaction threshold:
 *
 *   mission-planner:compaction-triggered:<missionId>
 *   mission-planner:compaction-completed:<missionId>
 *
 * The store flips a transient `runtime.isCompacting` flag so the detail
 * pane can surface a "Compacting" pill, and on completion re-hydrates
 * `flightStore` so any new journal entry / cost bump from the
 * summarization itself shows up immediately.
 *
 * This test stubs `@tauri-apps/api/event::listen` to capture event
 * callbacks by event name, drives `startPlanner` to install the
 * listeners, then synthesizes the two events and asserts the runtime
 * state transitions + the flightStore hydrate side-effect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const hydrateFromBackendMock = vi.fn().mockResolvedValue(undefined);
const updateFlightMock = vi.fn();
const startMissionPlannerMock = vi.fn();
const getMissionApprovalsMock = vi.fn().mockResolvedValue([]);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@/lib/tauri", () => ({
  startMissionPlanner: (...args: unknown[]) =>
    startMissionPlannerMock(...args),
  stopMissionPlanner: vi.fn().mockResolvedValue(undefined),
  pauseMissionPlanner: vi.fn().mockResolvedValue(undefined),
  resumeMissionPlanner: vi.fn().mockResolvedValue(undefined),
  injectPlannerTurn: vi.fn().mockResolvedValue(undefined),
  triggerPlannerDecomposition: vi.fn().mockResolvedValue(undefined),
  resolveMissionApproval: vi.fn().mockResolvedValue(undefined),
  getMissionApprovals: (...args: unknown[]) =>
    getMissionApprovalsMock(...args),
}));

vi.mock("@/lib/notifications", () => ({
  notifyMissionPlannerRateLimited: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: vi.fn(() => ({
      flights: [],
      hydrateFromBackend: hydrateFromBackendMock,
      updateFlight: updateFlightMock,
    })),
  },
}));

import { useMissionPlannerStore } from "@/stores/missionPlannerStore";

type EventCallback = (event: { payload: unknown }) => void;

function setupListenCapture(): Map<string, EventCallback> {
  const handlers = new Map<string, EventCallback>();
  listenMock.mockImplementation(
    (eventName: string, callback: EventCallback) => {
      handlers.set(eventName, callback);
      return Promise.resolve(() => {
        handlers.delete(eventName);
      });
    },
  );
  return handlers;
}

describe("missionPlannerStore compaction listeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMissionPlannerStore.setState({
      runtimes: new Map(),
      pendingApprovals: new Map(),
    });
    // Default: every `startMissionPlanner` invocation returns the
    // provisional session id the store sent us, so the store does NOT
    // re-install listeners.
    startMissionPlannerMock.mockImplementation(
      async (
        _missionId: string,
        _projectPath: string,
        provisionalSessionId: string,
      ) => provisionalSessionId,
    );
  });

  it("sets isCompacting=true on compaction-triggered event", async () => {
    const handlers = setupListenCapture();
    await useMissionPlannerStore
      .getState()
      .startPlanner("mission-1", "/tmp/project");

    const triggeredHandler = handlers.get(
      "mission-planner:compaction-triggered:mission-1",
    );
    expect(triggeredHandler).toBeDefined();

    triggeredHandler!({ payload: undefined });

    const runtime = useMissionPlannerStore
      .getState()
      .runtimes.get("mission-1");
    expect(runtime?.isCompacting).toBe(true);
  });

  it("sets isCompacting=false and re-hydrates flightStore on compaction-completed", async () => {
    const handlers = setupListenCapture();
    await useMissionPlannerStore
      .getState()
      .startPlanner("mission-2", "/tmp/project");

    // Pre-flip the runtime to `isCompacting: true` so we can observe
    // the listener clearing it — the trigger handler does this in
    // practice, but we don't want to make the second test depend on
    // the first one's wiring.
    useMissionPlannerStore.setState((s) => {
      const runtimes = new Map(s.runtimes);
      const current = runtimes.get("mission-2");
      if (current) {
        runtimes.set("mission-2", { ...current, isCompacting: true });
      }
      return { runtimes };
    });

    hydrateFromBackendMock.mockClear();

    const completedHandler = handlers.get(
      "mission-planner:compaction-completed:mission-2",
    );
    expect(completedHandler).toBeDefined();

    completedHandler!({ payload: undefined });

    const runtime = useMissionPlannerStore
      .getState()
      .runtimes.get("mission-2");
    expect(runtime?.isCompacting).toBe(false);
    // Wait a microtask so the void-promise hydrate call has a chance
    // to register on the mock.
    await Promise.resolve();
    expect(hydrateFromBackendMock).toHaveBeenCalledTimes(1);
  });

  it("initializes new planner runtimes with isCompacting=false", async () => {
    setupListenCapture();
    await useMissionPlannerStore
      .getState()
      .startPlanner("mission-3", "/tmp/project");

    const runtime = useMissionPlannerStore
      .getState()
      .runtimes.get("mission-3");
    expect(runtime?.isCompacting).toBe(false);
  });
});
