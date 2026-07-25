import { describe, expect, it } from "vitest";
import { isPollStale, shouldPollNotifications } from "@/lib/notificationPoll";

describe("isPollStale (GP2)", () => {
  it("is stale when never polled", () => {
    expect(isPollStale(null, 1000, 60_000)).toBe(true);
  });
  it("is fresh within the interval, stale after", () => {
    expect(isPollStale(1000, 1000 + 59_999, 60_000)).toBe(false);
    expect(isPollStale(1000, 1000 + 60_000, 60_000)).toBe(true);
  });
});

describe("shouldPollNotifications (GP2)", () => {
  const base = { connected: true, visible: true, lastPolledAt: null, now: 0, intervalMs: 60_000 };
  it("polls when connected, visible, and stale", () => {
    expect(shouldPollNotifications(base)).toBe(true);
  });
  it("never polls while disconnected", () => {
    expect(shouldPollNotifications({ ...base, connected: false })).toBe(false);
  });
  it("pauses while hidden", () => {
    expect(shouldPollNotifications({ ...base, visible: false })).toBe(false);
  });
  it("skips when a recent poll is still fresh", () => {
    expect(
      shouldPollNotifications({ ...base, lastPolledAt: 1000, now: 1000 + 30_000 }),
    ).toBe(false);
  });
});
