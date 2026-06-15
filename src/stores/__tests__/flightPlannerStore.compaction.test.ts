/**
 * E10-UI-TESTS — context-compaction listener wiring.
 *
 * Sibling Rust slices (E10-DETECT / E10-SUMMARIZE / E10-SWAP) emit two
 * scoped Tauri events when a planner session crosses the 150K-token
 * compaction threshold:
 *
 *   flight-planner:compaction-triggered:<flightId>
 *   flight-planner:compaction-completed:<flightId>
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
const startFlightPlannerMock = vi.fn();
const getFlightApprovalsMock = vi.fn().mockResolvedValue([]);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@/lib/tauri", () => ({
  startFlightPlanner: (...args: unknown[]) => startFlightPlannerMock(...args),
  stopFlightPlanner: vi.fn().mockResolvedValue(undefined),
  pauseFlightPlanner: vi.fn().mockResolvedValue(undefined),
  resumeFlightPlanner: vi.fn().mockResolvedValue(undefined),
  injectPlannerTurn: vi.fn().mockResolvedValue(undefined),
  triggerPlannerDecomposition: vi.fn().mockResolvedValue(undefined),
  resolveFlightApproval: vi.fn().mockResolvedValue(undefined),
  getFlightApprovals: (...args: unknown[]) => getFlightApprovalsMock(...args),
}));

vi.mock("@/lib/notifications", () => ({
  notifyFlightPlannerRateLimited: vi.fn().mockResolvedValue(undefined),
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

import { useFlightPlannerStore } from "@/stores/flightPlannerStore";
import { notifyFlightPlannerRateLimited } from "@/lib/notifications";

type EventCallback = (event: { payload: unknown }) => void;
const mockedNotifyFlightPlannerRateLimited = vi.mocked(notifyFlightPlannerRateLimited);

function setupListenCapture(): Map<string, EventCallback> {
  const handlers = new Map<string, EventCallback>();
  listenMock.mockImplementation((eventName: string, callback: EventCallback) => {
    handlers.set(eventName, callback);
    return Promise.resolve(() => {
      handlers.delete(eventName);
    });
  });
  return handlers;
}

describe("flightPlannerStore compaction listeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlightPlannerStore.setState({
      runtimes: new Map(),
      pendingApprovals: new Map(),
    });
    getFlightApprovalsMock.mockResolvedValue([]);
    // Default: every `startFlightPlanner` invocation returns the
    // provisional session id the store sent us, so the store does NOT
    // re-install listeners.
    startFlightPlannerMock.mockImplementation(
      async (_flightId: string, _projectPath: string, provisionalSessionId: string) =>
        provisionalSessionId,
    );
  });

  it("sets isCompacting=true on compaction-triggered event", async () => {
    const handlers = setupListenCapture();
    await useFlightPlannerStore.getState().startPlanner("flight-1", "/tmp/project");

    const triggeredHandler = handlers.get("flight-planner:compaction-triggered:flight-1");
    expect(triggeredHandler).toBeDefined();

    triggeredHandler!({ payload: undefined });

    const runtime = useFlightPlannerStore.getState().runtimes.get("flight-1");
    expect(runtime?.isCompacting).toBe(true);
  });

  it("sets isCompacting=false and re-hydrates flightStore on compaction-completed", async () => {
    const handlers = setupListenCapture();
    await useFlightPlannerStore.getState().startPlanner("flight-2", "/tmp/project");

    // Pre-flip the runtime to `isCompacting: true` so we can observe
    // the listener clearing it — the trigger handler does this in
    // practice, but we don't want to make the second test depend on
    // the first one's wiring.
    useFlightPlannerStore.setState((s) => {
      const runtimes = new Map(s.runtimes);
      const current = runtimes.get("flight-2");
      if (current) {
        runtimes.set("flight-2", { ...current, isCompacting: true });
      }
      return { runtimes };
    });

    hydrateFromBackendMock.mockClear();

    const completedHandler = handlers.get("flight-planner:compaction-completed:flight-2");
    expect(completedHandler).toBeDefined();

    completedHandler!({ payload: undefined });

    const runtime = useFlightPlannerStore.getState().runtimes.get("flight-2");
    expect(runtime?.isCompacting).toBe(false);
    // Wait a microtask so the void-promise hydrate call has a chance
    // to register on the mock.
    await Promise.resolve();
    expect(hydrateFromBackendMock).toHaveBeenCalledTimes(1);
  });

  it("initializes new planner runtimes with isCompacting=false", async () => {
    setupListenCapture();
    await useFlightPlannerStore.getState().startPlanner("flight-3", "/tmp/project");

    const runtime = useFlightPlannerStore.getState().runtimes.get("flight-3");
    expect(runtime?.isCompacting).toBe(false);
  });

  it("hydrates pending approvals without dropping live approval events", async () => {
    const handlers = setupListenCapture();
    const flightId = "flight-approval";
    const persistedApproval = {
      id: "persisted-approval",
      flightId,
      question: "Persisted approval?",
      options: ["Proceed"],
      awaitingSince: 1_000,
    };
    const liveApproval = {
      id: "live-approval",
      flightId,
      question: "Live approval?",
      options: ["Proceed"],
      awaitingSince: 2_000,
    };

    getFlightApprovalsMock.mockImplementation(async () => {
      const handler = handlers.get("flight-planner:approval-request:flight-approval");
      expect(handler).toBeDefined();
      handler!({ payload: liveApproval });
      handler!({ payload: liveApproval });
      return [persistedApproval];
    });

    await useFlightPlannerStore.getState().startPlanner(flightId, "/tmp/project");

    expect(
      useFlightPlannerStore
        .getState()
        .getPendingApprovals(flightId)
        .map((approval) => approval.id),
    ).toEqual(["persisted-approval", "live-approval"]);
  });

  it("hydrates persisted approvals without starting a planner runtime", async () => {
    const flightId = "flight-cold-start-approval";
    getFlightApprovalsMock.mockResolvedValueOnce([
      {
        id: "persisted-cold-start",
        flightId,
        question: "Resume this flight?",
        options: ["Resume", "Cancel"],
        awaitingSince: 1_000,
      },
    ]);

    await useFlightPlannerStore.getState().hydratePendingApprovals(flightId);

    expect(startFlightPlannerMock).not.toHaveBeenCalled();
    expect(
      useFlightPlannerStore
        .getState()
        .getPendingApprovals(flightId)
        .map((approval) => approval.id),
    ).toEqual(["persisted-cold-start"]);
  });

  it("clears stale local approvals during cold-start hydration", async () => {
    const flightId = "flight-stale-approval";
    useFlightPlannerStore.setState({
      pendingApprovals: new Map([
        [
          flightId,
          [
            {
              id: "already-resolved",
              flightId,
              question: "Old question?",
              options: ["OK"],
              awaitingSince: 1_000,
            },
          ],
        ],
      ]),
    });
    getFlightApprovalsMock.mockResolvedValueOnce([]);

    await useFlightPlannerStore.getState().hydratePendingApprovals(flightId);

    expect(useFlightPlannerStore.getState().getPendingApprovals(flightId)).toEqual([]);
  });

  it("mirrors rate-limit events into quota_paused runtime status", async () => {
    const handlers = setupListenCapture();
    const flightId = "flight-rate-limit";

    await useFlightPlannerStore.getState().startPlanner(flightId, "/tmp/project");

    const rateLimitedHandler = handlers.get("flight-planner:rate-limited:flight-rate-limit");
    expect(rateLimitedHandler).toBeDefined();

    rateLimitedHandler!({
      payload: { flightId, retryAfterSeconds: 75 },
    });

    const runtime = useFlightPlannerStore.getState().runtimes.get(flightId);
    expect(runtime?.status).toBe("quota_paused");
    expect(runtime?.isStreaming).toBe(false);
    expect(mockedNotifyFlightPlannerRateLimited).toHaveBeenCalledWith(flightId, "Flight", 75);
  });
});
