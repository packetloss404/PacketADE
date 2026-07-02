/**
 * reviewStore — the persisted per-file Viewed slice that replaced
 * useReviewedDiffs' hand-rolled pub/sub + unbounded localStorage map
 * (consensus P1-8, moderator-ruled: keep the GitHub-style Viewed concept,
 * kill the implementation).
 *
 * Covers: persistence across a module reload, the signature reset (a new
 * edit to a viewed file drops it back to unviewed), un-viewing, and the
 * bounded-map guarantee (clearConversation prunes the persisted entry).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIEWED_STORAGE_KEY = "packetade:review-viewed-v1";

async function freshStore() {
  vi.resetModules();
  return await import("@/stores/reviewStore");
}

beforeEach(() => {
  localStorage.clear();
});

describe("editSignature", () => {
  it("changes when the edit chain grows or the content changes", async () => {
    const { editSignature } = await freshStore();
    const base = editSignature({ writeCount: 1, content: "abc\n" });
    expect(editSignature({ writeCount: 2, content: "abc\n" })).not.toBe(base);
    expect(editSignature({ writeCount: 1, content: "abcd\n" })).not.toBe(base);
    expect(editSignature({ writeCount: 1, content: "abc\n" })).toBe(base);
  });
});

describe("reviewStore viewed slice", () => {
  it("persists Viewed marks and restores them on a fresh load", async () => {
    const first = await freshStore();
    first.useReviewStore
      .getState()
      .setViewed("conv-1", "src/a.ts", "1:10", true);

    expect(
      first.useReviewStore.getState().isViewed("conv-1", "src/a.ts", "1:10"),
    ).toBe(true);
    // Written through to localStorage…
    expect(
      JSON.parse(localStorage.getItem(VIEWED_STORAGE_KEY) ?? "{}"),
    ).toEqual({ "conv-1": { "src/a.ts": "1:10" } });

    // …and read back by a brand-new store instance (module reload).
    const second = await freshStore();
    expect(
      second.useReviewStore.getState().isViewed("conv-1", "src/a.ts", "1:10"),
    ).toBe(true);
  });

  it("treats a changed signature as unviewed (GitHub-style reset on new edits)", async () => {
    const { useReviewStore } = await freshStore();
    useReviewStore.getState().setViewed("conv-1", "src/a.ts", "1:10", true);
    expect(
      useReviewStore.getState().isViewed("conv-1", "src/a.ts", "2:14"),
    ).toBe(false);
  });

  it("un-viewing removes the entry and the persisted map stays clean", async () => {
    const { useReviewStore } = await freshStore();
    useReviewStore.getState().setViewed("conv-1", "src/a.ts", "1:10", true);
    useReviewStore.getState().setViewed("conv-1", "src/a.ts", "1:10", false);
    expect(
      useReviewStore.getState().isViewed("conv-1", "src/a.ts", "1:10"),
    ).toBe(false);
    expect(
      JSON.parse(localStorage.getItem(VIEWED_STORAGE_KEY) ?? "{}"),
    ).toEqual({});
  });

  it("clearConversation prunes the persisted entry and closes an open panel", async () => {
    const { useReviewStore } = await freshStore();
    useReviewStore.getState().setViewed("conv-1", "src/a.ts", "1:10", true);
    useReviewStore.getState().setViewed("conv-2", "src/b.ts", "3:7", true);
    useReviewStore.getState().openForConversation("conv-1", "src/a.ts");

    useReviewStore.getState().clearConversation("conv-1");

    const s = useReviewStore.getState();
    expect(s.open).toBe(false);
    expect(s.conversationId).toBeNull();
    expect(s.isViewed("conv-1", "src/a.ts", "1:10")).toBe(false);
    // Unrelated conversations survive.
    expect(s.isViewed("conv-2", "src/b.ts", "3:7")).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(VIEWED_STORAGE_KEY) ?? "{}"),
    ).toEqual({ "conv-2": { "src/b.ts": "3:7" } });
  });

  it("ignores malformed persisted payloads on load", async () => {
    localStorage.setItem(
      VIEWED_STORAGE_KEY,
      JSON.stringify({ "conv-1": ["not", "a", "map"], "conv-2": { ok: "1:1" } }),
    );
    const { useReviewStore } = await freshStore();
    expect(useReviewStore.getState().viewed).toEqual({
      "conv-2": { ok: "1:1" },
    });
  });
});
