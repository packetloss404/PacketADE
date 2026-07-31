/**
 * UX-09: the window close is intercepted. With live work the user gets a
 * confirmation; with none the window closes immediately; cancel keeps it up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { LiveWorkSummary } from "@/lib/liveWork";

const destroy = vi.fn().mockResolvedValue(undefined);
const unlisten = vi.fn();
const collectLiveWork = vi.fn();
let closeHandler: ((event: { preventDefault: () => void }) => Promise<void>) | null = null;
const onCloseRequested = vi.fn(async (handler: (event: { preventDefault: () => void }) => Promise<void>) => {
  closeHandler = handler;
  return unlisten;
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested, destroy }),
}));
vi.mock("@/lib/liveWork", () => ({
  collectLiveWork: () => collectLiveWork(),
}));

import { useCloseConfirm } from "@/hooks/useCloseConfirm";

const IDLE: LiveWorkSummary = { ptySessions: 0, conversations: 0, attempts: 0, total: 0 };
const BUSY: LiveWorkSummary = { ptySessions: 2, conversations: 1, attempts: 1, total: 4 };

async function requestClose() {
  const preventDefault = vi.fn();
  await act(async () => {
    await closeHandler!({ preventDefault });
  });
  return preventDefault;
}

describe("useCloseConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeHandler = null;
    collectLiveWork.mockResolvedValue(IDLE);
  });

  it("registers a close-requested handler and unlistens on unmount", async () => {
    const { unmount } = renderHook(() => useCloseConfirm());
    await waitFor(() => expect(closeHandler).toBeTypeOf("function"));
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("closes immediately with no prompt when nothing is running", async () => {
    const { result } = renderHook(() => useCloseConfirm());
    await waitFor(() => expect(closeHandler).toBeTypeOf("function"));
    const preventDefault = await requestClose();
    // Always prevents first — the live-work check is async.
    expect(preventDefault).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it("parks the close and surfaces the summary when work is live", async () => {
    collectLiveWork.mockResolvedValue(BUSY);
    const { result } = renderHook(() => useCloseConfirm());
    await waitFor(() => expect(closeHandler).toBeTypeOf("function"));
    const preventDefault = await requestClose();
    expect(preventDefault).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual(BUSY);
  });

  it("cancel keeps the window open", async () => {
    collectLiveWork.mockResolvedValue(BUSY);
    const { result } = renderHook(() => useCloseConfirm());
    await waitFor(() => expect(closeHandler).toBeTypeOf("function"));
    await requestClose();
    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("confirm destroys the window", async () => {
    collectLiveWork.mockResolvedValue(BUSY);
    const { result } = renderHook(() => useCloseConfirm());
    await waitFor(() => expect(closeHandler).toBeTypeOf("function"));
    await requestClose();
    act(() => result.current.confirm());
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it("survives a registration failure outside Tauri", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onCloseRequested.mockRejectedValueOnce(new Error("not tauri"));
    const { result } = renderHook(() => useCloseConfirm());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.pending).toBeNull();
    warn.mockRestore();
  });
});
