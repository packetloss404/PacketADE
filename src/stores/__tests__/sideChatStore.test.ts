import { beforeEach, describe, expect, it, vi } from "vitest";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, EventCallback>(),
  listen: vi.fn(),
  ask: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(true),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, callback: EventCallback) => mocks.listen(event, callback),
}));

vi.mock("@/lib/tauri", () => ({
  askSideChatStream: (...args: unknown[]) => mocks.ask(...args),
  cancelSideChatStream: (...args: unknown[]) => mocks.cancel(...args),
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: () => ({ conversations: [], selectedConversationId: null }),
  },
}));

import { useSideChatStore } from "@/stores/sideChatStore";

describe("sideChatStore request ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.listen.mockImplementation((event: string, callback: EventCallback) => {
      mocks.listeners.set(event, callback);
      return Promise.resolve(vi.fn());
    });
    mocks.ask.mockResolvedValue(undefined);
    mocks.cancel.mockResolvedValue(true);
    useSideChatStore.setState({
      open: true,
      question: "What changed?",
      answer: "",
      isStreaming: false,
      isStopping: false,
      activeRequestId: null,
    });
  });

  it("accepts only events carrying the active request ID", async () => {
    useSideChatStore.getState().ask();
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const requestId = mocks.ask.mock.calls[0]?.[0] as string;

    mocks.listeners.get("side-chat:chunk")?.({
      payload: { requestId: "stale-request", delta: "wrong" },
    });
    expect(useSideChatStore.getState().answer).toBe("");

    mocks.listeners.get("side-chat:chunk")?.({
      payload: { requestId, delta: "right" },
    });
    expect(useSideChatStore.getState().answer).toBe("right");

    mocks.listeners.get("side-chat:done")?.({
      payload: { requestId, cancelled: false },
    });
    expect(useSideChatStore.getState().isStreaming).toBe(false);
    expect(useSideChatStore.getState().activeRequestId).toBeNull();
  });

  it("keeps Stop pending until the request-scoped cancelled terminal event", async () => {
    useSideChatStore.getState().ask();
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const requestId = mocks.ask.mock.calls[0]?.[0] as string;
    const chunk = mocks.listeners.get("side-chat:chunk");

    useSideChatStore.getState().cancel();

    expect(mocks.cancel).toHaveBeenCalledWith(requestId);
    expect(useSideChatStore.getState().isStreaming).toBe(true);
    expect(useSideChatStore.getState().isStopping).toBe(true);
    expect(useSideChatStore.getState().activeRequestId).toBe(requestId);

    mocks.listeners.get("side-chat:done")?.({
      payload: { requestId, cancelled: true },
    });
    expect(useSideChatStore.getState().isStreaming).toBe(false);
    expect(useSideChatStore.getState().isStopping).toBe(false);
    expect(useSideChatStore.getState().activeRequestId).toBeNull();

    chunk?.({ payload: { requestId, delta: "late" } });
    expect(useSideChatStore.getState().answer).toBe("");
  });

  it("retries Stop after ask registration when the first cancel arrives too early", async () => {
    let finishAsk!: () => void;
    mocks.ask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAsk = resolve;
        }),
    );
    mocks.cancel.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    useSideChatStore.getState().ask();
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const requestId = mocks.ask.mock.calls[0]?.[0] as string;

    useSideChatStore.getState().cancel();
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1));
    expect(useSideChatStore.getState().isStopping).toBe(true);

    finishAsk();
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(2));
    expect(mocks.cancel).toHaveBeenNthCalledWith(1, requestId);
    expect(mocks.cancel).toHaveBeenNthCalledWith(2, requestId);
    expect(useSideChatStore.getState().isStopping).toBe(true);

    mocks.listeners.get("side-chat:done")?.({
      payload: { requestId, cancelled: true },
    });
    expect(useSideChatStore.getState().isStopping).toBe(false);
  });

  it("surfaces a rejected Stop and leaves the live request stoppable", async () => {
    mocks.cancel.mockRejectedValueOnce(new Error("cancel transport unavailable"));
    useSideChatStore.getState().ask();
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const requestId = mocks.ask.mock.calls[0]?.[0] as string;

    useSideChatStore.getState().cancel();

    await vi.waitFor(() => expect(useSideChatStore.getState().isStopping).toBe(false));
    expect(useSideChatStore.getState().isStreaming).toBe(true);
    expect(useSideChatStore.getState().activeRequestId).toBe(requestId);
    expect(useSideChatStore.getState().answer).toContain(
      "Error: Stop failed: cancel transport unavailable",
    );
  });

  it("does not start the backend if the overlay closes during listener setup", async () => {
    let releaseFirstListener!: (unlisten: () => void) => void;
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          releaseFirstListener = resolve;
        }),
    );

    useSideChatStore.getState().ask();
    const requestId = useSideChatStore.getState().activeRequestId;
    expect(requestId).not.toBeNull();

    useSideChatStore.getState().close();
    releaseFirstListener(vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.cancel).toHaveBeenCalledWith(requestId);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(useSideChatStore.getState().open).toBe(false);
  });

  it("cancels the active request when toggle closes the overlay", async () => {
    useSideChatStore.getState().ask();
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const requestId = useSideChatStore.getState().activeRequestId;

    useSideChatStore.getState().toggle();

    expect(mocks.cancel).toHaveBeenCalledWith(requestId);
    expect(useSideChatStore.getState().open).toBe(false);
    expect(useSideChatStore.getState().isStreaming).toBe(false);
    expect(useSideChatStore.getState().activeRequestId).toBeNull();
  });

  it("a stale listener registration cannot detach the replacement request", async () => {
    let releaseStaleListener!: (unlisten: () => void) => void;
    const staleUnlisten = vi.fn();
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          releaseStaleListener = resolve;
        }),
    );

    useSideChatStore.getState().ask();
    useSideChatStore.getState().close();

    useSideChatStore.setState({ open: true, question: "Replacement" });
    useSideChatStore.getState().ask();
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const replacementId = useSideChatStore.getState().activeRequestId;

    releaseStaleListener(staleUnlisten);
    await Promise.resolve();
    expect(staleUnlisten).toHaveBeenCalledTimes(1);

    mocks.listeners.get("side-chat:chunk")?.({
      payload: { requestId: replacementId, delta: "replacement survived" },
    });
    expect(useSideChatStore.getState().answer).toBe("replacement survived");
  });
});
