/**
 * `@` file mentions served by the ACP engine.
 *
 * The three properties that matter here are all about NOT trusting the
 * subprocess: one call per typing pause (not per keystroke), never more rows
 * than the backend's own cap, and a rejection that hands the caller a
 * `failed` flag instead of an empty list it would render as "no files".
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acpSearchFiles = vi.fn();

vi.mock("@/lib/tauri", () => ({
  acpSearchFiles: (...args: unknown[]) => acpSearchFiles(...args),
}));

import {
  FILE_MENTION_LIMIT,
  FILE_SEARCH_DEBOUNCE_MS,
  useEngineFileSearch,
} from "../useEngineFileSearch";

beforeEach(() => {
  vi.useFakeTimers();
  acpSearchFiles.mockReset();
  acpSearchFiles.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance past the debounce and let the resolved promise flush. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(FILE_SEARCH_DEBOUNCE_MS);
    // Flush the binding promise chain (.then + .catch hops). Fake timers are
    // active, so waitFor would never tick — microtask flushes are the way.
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe("useEngineFileSearch", () => {
  it("never calls the engine while disabled", async () => {
    renderHook(() => useEngineFileSearch("/repo", "comp", false));
    await settle();
    expect(acpSearchFiles).not.toHaveBeenCalled();
  });

  it("never calls the engine without a project path", async () => {
    renderHook(() => useEngineFileSearch("", "comp", true));
    await settle();
    expect(acpSearchFiles).not.toHaveBeenCalled();
  });

  it("debounces a burst of keystrokes into ONE round trip", async () => {
    const { rerender } = renderHook(
      ({ q }: { q: string }) => useEngineFileSearch("/repo", q, true),
      { initialProps: { q: "c" } },
    );
    // Three more keystrokes, each inside the debounce window.
    for (const q of ["co", "com", "comp"]) {
      act(() => {
        vi.advanceTimersByTime(FILE_SEARCH_DEBOUNCE_MS - 20);
      });
      rerender({ q });
    }
    expect(acpSearchFiles).not.toHaveBeenCalled();

    await settle();
    expect(acpSearchFiles).toHaveBeenCalledTimes(1);
    expect(acpSearchFiles).toHaveBeenCalledWith("/repo", "comp");
  });

  it("issues a fresh query once the user pauses again", async () => {
    const { rerender } = renderHook(
      ({ q }: { q: string }) => useEngineFileSearch("/repo", q, true),
      { initialProps: { q: "a" } },
    );
    await settle();
    rerender({ q: "ab" });
    await settle();
    expect(acpSearchFiles).toHaveBeenCalledTimes(2);
    expect(acpSearchFiles.mock.calls.map((c) => c[1])).toEqual(["a", "ab"]);
  });

  it("caps results at the backend's FILE_MENTION_LIMIT", async () => {
    // A future engine returning more must not be able to grow this menu.
    acpSearchFiles.mockResolvedValue(
      Array.from({ length: FILE_MENTION_LIMIT + 12 }, (_, i) => `src/f${i}.ts`),
    );
    const { result } = renderHook(() => useEngineFileSearch("/repo", "f", true));
    await settle();
    expect(result.current.paths).toHaveLength(FILE_MENTION_LIMIT);
    expect(result.current.paths[0]).toBe("src/f0.ts");
    expect(result.current.failed).toBe(false);
  });

  it("reports failure instead of an empty list, and stops asking", async () => {
    acpSearchFiles.mockRejectedValue(new Error("engine not started"));
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useEngineFileSearch("/repo", q, true),
      { initialProps: { q: "a" } },
    );
    await settle();
    expect(result.current.failed).toBe(true);
    expect(result.current.paths).toEqual([]);
    expect(result.current.loading).toBe(false);

    // Latched: the caller has fallen back to its local scan, so further
    // keystrokes must not keep paying for a round trip that cannot succeed.
    rerender({ q: "ab" });
    await settle();
    expect(acpSearchFiles).toHaveBeenCalledTimes(1);
  });

  it("tolerates a non-array answer without throwing", async () => {
    acpSearchFiles.mockResolvedValue(null);
    const { result } = renderHook(() => useEngineFileSearch("/repo", "f", true));
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.paths).toEqual([]);
    expect(result.current.failed).toBe(false);
  });
});
