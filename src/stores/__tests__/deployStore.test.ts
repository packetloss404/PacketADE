import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployConfig, DeployValidation } from "@/types/deploy";

type EventListener = (event: { payload: unknown }) => void;

const listenMock = vi.fn();
const unlistenMock = vi.fn();

const mocks = vi.hoisted(() => ({
  validateDeploy: vi.fn(),
  runDeploy: vi.fn(),
  readDeployConfig: vi.fn(),
  createDeployConfig: vi.fn(),
}));

// Capture every registered Tauri event handler keyed by event name so tests can
// drive the store by invoking handlers directly (deterministic, no timers).
let listeners: Map<string, EventListener>;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, callback: EventListener) => {
    listenMock(eventName, callback);
    listeners.set(eventName, callback);
    // The unlisten fn is shared so a single spy verifies cleanup happened.
    return Promise.resolve(() => unlistenMock(eventName));
  },
}));

vi.mock("@/lib/tauri", () => ({
  readDeployConfig: (...args: unknown[]) => mocks.readDeployConfig(...args),
  createDeployConfig: (...args: unknown[]) => mocks.createDeployConfig(...args),
  validateDeploy: (...args: unknown[]) => mocks.validateDeploy(...args),
  runDeploy: (...args: unknown[]) => mocks.runDeploy(...args),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: () => ({ projectPath: "D:/projects/example" }),
  },
}));

import { useDeployStore } from "@/stores/deployStore";

const VALID_VALIDATION: DeployValidation = {
  valid: true,
  warnings: [],
  errors: [],
  gitBranch: "main",
  hasUncommitted: false,
};

function config(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    name: "prod",
    command: "echo deploy",
    ...overrides,
  };
}

function resetStore() {
  useDeployStore.setState({
    configs: [],
    configSource: "none",
    loading: false,
    error: null,
    runs: [],
    activeRunId: null,
    lastValidation: null,
    validating: false,
  });
}

function activeRun() {
  const state = useDeployStore.getState();
  return state.runs.find((r) => r.id === state.activeRunId);
}

function exitEventName(): string {
  const id = useDeployStore.getState().activeRunId;
  return `deploy:exit:${id}`;
}

describe("deployStore.startRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners = new Map();
    resetStore();
    mocks.validateDeploy.mockResolvedValue(JSON.stringify(VALID_VALIDATION));
    mocks.runDeploy.mockResolvedValue("session-1");
  });

  describe("deploy:exit is the sole authority for terminal status (#4)", () => {
    it("sets status 'success' on a numeric exit payload of 0", async () => {
      await useDeployStore.getState().startRun(config());
      expect(activeRun()?.status).toBe("running");

      listeners.get(exitEventName())?.({ payload: 0 });

      const run = activeRun();
      expect(run?.status).toBe("success");
      expect(run?.finishedAt).not.toBeNull();
    });

    it("sets status 'failed' on a nonzero numeric exit payload", async () => {
      await useDeployStore.getState().startRun(config());

      listeners.get(exitEventName())?.({ payload: 1 });

      expect(activeRun()?.status).toBe("failed");
    });

    it("fail-closed: a non-numeric/garbage payload sets status 'failed'", async () => {
      await useDeployStore.getState().startRun(config());
      const name = exitEventName();

      // A malformed payload (string) must NOT be treated as success.
      listeners.get(name)?.({ payload: "boom" });

      expect(activeRun()?.status).toBe("failed");
    });

    it("fail-closed: undefined/null payload also sets status 'failed'", async () => {
      await useDeployStore.getState().startRun(config());

      listeners.get(exitEventName())?.({ payload: undefined });

      expect(activeRun()?.status).toBe("failed");
    });

    it("fail-closed: NaN payload (typeof number, but not 0) sets status 'failed'", async () => {
      await useDeployStore.getState().startRun(config());

      // NaN is `typeof === "number"` so it skips the non-numeric guard, but
      // `NaN === 0` is false → it must still resolve to 'failed', not 'success'.
      listeners.get(exitEventName())?.({ payload: Number.NaN });

      expect(activeRun()?.status).toBe("failed");
    });
  });

  describe("listener-before-invoke ordering (#11)", () => {
    it("registers the deploy:exit listener before runDeploy resolves", async () => {
      // runDeploy resolution is gated; the exit listener must already exist
      // when we (synchronously, before resolving) check the registry.
      let exitListenerExistedAtInvoke = false;
      mocks.runDeploy.mockImplementation((_p: string, _c: string, runId: string) => {
        exitListenerExistedAtInvoke = listeners.has(`deploy:exit:${runId}`);
        return Promise.resolve("session-late");
      });

      await useDeployStore.getState().startRun(config());

      expect(exitListenerExistedAtInvoke).toBe(true);
    });

    it("does not stay stuck 'running' when exit fires at/just-before invoke resolution", async () => {
      // Simulate a near-instant deploy: the backend emits deploy:exit while
      // runDeploy is still in flight, BEFORE it resolves. Because the listener
      // is attached up front, the run still transitions out of 'running'.
      mocks.runDeploy.mockImplementation((_p: string, _c: string, runId: string) => {
        listeners.get(`deploy:exit:${runId}`)?.({ payload: 0 });
        return Promise.resolve("session-instant");
      });

      await useDeployStore.getState().startRun(config());

      const run = activeRun();
      expect(run?.status).toBe("success");
      expect(run?.status).not.toBe("running");
      // The sessionId from the resolved invoke is still applied after the early exit.
      expect(run?.sessionId).toBe("session-instant");
    });
  });

  describe("runDeploy rejection (#11 failed-launch path)", () => {
    it("ends the run 'failed' (not stuck 'running'), surfaces the error, and cleans up listeners", async () => {
      mocks.runDeploy.mockRejectedValue(new Error("spawn ENOENT"));

      await useDeployStore.getState().startRun(config());

      const run = activeRun();
      expect(run?.status).toBe("failed");
      expect(run?.status).not.toBe("running");
      expect(run?.finishedAt).not.toBeNull();
      expect(run?.output.some((line) => line.includes("spawn ENOENT"))).toBe(true);
      expect(useDeployStore.getState().error).toContain("spawn ENOENT");

      // Both listeners (output + exit) were torn down — no leak.
      expect(unlistenMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("deployStore.finishRun idempotency (#4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners = new Map();
    resetStore();
    mocks.validateDeploy.mockResolvedValue(JSON.stringify(VALID_VALIDATION));
    mocks.runDeploy.mockResolvedValue("session-1");
  });

  it("does not regress a 'failed' run to 'success' on a late/duplicate event", async () => {
    await useDeployStore.getState().startRun(config());
    const id = useDeployStore.getState().activeRunId!;

    useDeployStore.getState().finishRun(id, "failed");
    expect(activeRun()?.status).toBe("failed");
    const firstFinishedAt = activeRun()?.finishedAt;

    // A late / duplicate exit event arrives claiming success — must be ignored.
    useDeployStore.getState().finishRun(id, "success");

    const run = activeRun();
    expect(run?.status).toBe("failed");
    expect(run?.finishedAt).toBe(firstFinishedAt);
  });

  it("does not regress a 'success' run to 'failed' on a late/duplicate event", async () => {
    await useDeployStore.getState().startRun(config());
    const id = useDeployStore.getState().activeRunId!;

    useDeployStore.getState().finishRun(id, "success");
    expect(activeRun()?.status).toBe("success");

    useDeployStore.getState().finishRun(id, "failed");

    expect(activeRun()?.status).toBe("success");
  });

  it("ignores a duplicate exit event delivered through the captured handler", async () => {
    await useDeployStore.getState().startRun(config());
    const name = exitEventName();

    listeners.get(name)?.({ payload: 0 }); // success
    expect(activeRun()?.status).toBe("success");

    // Duplicate/late delivery of a failing exit must not flip the terminal state.
    listeners.get(name)?.({ payload: 1 });
    expect(activeRun()?.status).toBe("success");
  });
});
