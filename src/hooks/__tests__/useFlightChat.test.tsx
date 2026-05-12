import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFlightChat } from "@/hooks/useFlightChat";
import { flightChatChunkEvent, flightChatDoneEvent, flightChatErrorEvent } from "@/lib/events";

type ListenerHandler<T = unknown> = (event: { payload: T }) => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface ListenerRecord {
  event: string;
  handler: ListenerHandler;
  deferred: Deferred<ReturnType<typeof vi.fn>>;
  unlisten: ReturnType<typeof vi.fn>;
}

const records: ListenerRecord[] = [];
let uuidCounter = 0;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: ListenerHandler) => {
    const deferred = createDeferred<ReturnType<typeof vi.fn>>();
    const unlisten = vi.fn();
    records.push({ event, handler, deferred, unlisten });
    return deferred.promise;
  }),
}));

vi.mock("@/lib/tauri", () => ({
  askFlightChatStream: vi.fn(),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({ projectPath: "/project" })),
  },
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "memory context") })),
  },
}));

import { askFlightChatStream } from "@/lib/tauri";

const mockAskFlightChatStream = vi.mocked(askFlightChatStream);

const flightState = {
  title: "",
  objective: "",
  priority: "medium",
};

function resolveListener(index: number) {
  records[index].deferred.resolve(records[index].unlisten);
}

function emit<T>(event: string, payload: T) {
  const record = records.find((r) => r.event === event);
  record?.handler({ payload });
}

describe("useFlightChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    records.length = 0;
    uuidCounter = 0;
    mockAskFlightChatStream.mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        randomUUID: vi.fn(() => `req-${++uuidCounter}`),
      },
    });
  });

  it("awaits all stream listeners before invoking the backend", async () => {
    const { result } = renderHook(() => useFlightChat());

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("plan this", flightState);
      await Promise.resolve();
    });

    expect(records.map((r) => r.event)).toEqual([
      flightChatChunkEvent("req-1"),
      flightChatErrorEvent("req-1"),
      flightChatDoneEvent("req-1"),
    ]);
    expect(mockAskFlightChatStream).not.toHaveBeenCalled();

    await act(async () => {
      resolveListener(0);
      resolveListener(1);
      await Promise.resolve();
    });
    expect(mockAskFlightChatStream).not.toHaveBeenCalled();

    await act(async () => {
      resolveListener(2);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockAskFlightChatStream).toHaveBeenCalledTimes(1));

    await act(async () => {
      emit(flightChatChunkEvent("req-1"), "Done.");
      emit(flightChatDoneEvent("req-1"), true);
      await sendPromise;
    });

    expect(records.every((record) => record.unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("prevents same-tick concurrent sends", async () => {
    const { result } = renderHook(() => useFlightChat());

    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = result.current.sendMessage("first", flightState);
      void result.current.sendMessage("second", flightState);
      records.forEach((_record, index) => resolveListener(index));
      await Promise.resolve();
    });

    await waitFor(() => expect(mockAskFlightChatStream).toHaveBeenCalledTimes(1));

    await act(async () => {
      emit(flightChatChunkEvent("req-1"), "One response.");
      emit(flightChatDoneEvent("req-1"), true);
      await firstSend;
    });

    expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(result.current.messages[0]?.content).toBe("first");
  });

  it("surfaces backend stream errors when done is false", async () => {
    const { result } = renderHook(() => useFlightChat());

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("make a plan", flightState);
      records.forEach((_record, index) => resolveListener(index));
      await Promise.resolve();
    });

    await waitFor(() => expect(mockAskFlightChatStream).toHaveBeenCalledTimes(1));

    await act(async () => {
      emit(flightChatErrorEvent("req-1"), {
        category: "provider",
        message: "Provider rejected the request",
        suggestion: "Pick another model.",
      });
      emit(flightChatDoneEvent("req-1"), false);
      await sendPromise;
    });

    expect(result.current.lastError).toEqual({
      category: "provider",
      message: "Provider rejected the request",
      suggestion: "Pick another model.",
    });
    expect(result.current.messages[result.current.messages.length - 1]?.content).toContain(
      "Provider rejected the request",
    );
  });
});
