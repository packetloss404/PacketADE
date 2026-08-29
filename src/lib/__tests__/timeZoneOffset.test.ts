/**
 * `timeZoneOffsetMinutes` — the numeric companion to `timeZoneOffsetLabel`.
 *
 * The dictation Analytics tab uses it to decide whether its UTC-bucketing
 * disclosure is worth rendering, so the case that matters most is the one the
 * label form cannot answer cleanly: a zone that is exactly UTC has to come
 * back as 0, and a half-hour zone must not round to a whole hour.
 */
import { describe, expect, it } from "vitest";
import { timeZoneOffsetMinutes } from "@/lib/time";

describe("timeZoneOffsetMinutes", () => {
  it("is zero for UTC", () => {
    expect(timeZoneOffsetMinutes("UTC", new Date("2026-08-29T12:00:00Z"))).toBe(0);
  });

  it("is negative west of Greenwich and positive east of it", () => {
    // 2026-08-29 is inside US daylight saving: New York is UTC-4.
    expect(timeZoneOffsetMinutes("America/New_York", new Date("2026-08-29T12:00:00Z"))).toBe(
      -240,
    );
    expect(timeZoneOffsetMinutes("Asia/Tokyo", new Date("2026-08-29T12:00:00Z"))).toBe(540);
  });

  it("keeps sub-hour offsets", () => {
    expect(timeZoneOffsetMinutes("Asia/Kolkata", new Date("2026-08-29T12:00:00Z"))).toBe(330);
  });

  // The offset is per-instant, not per-zone: a fixed offset would put every
  // pre-March timestamp in the wrong day for half the year.
  it("follows daylight saving rather than a nominal offset", () => {
    const summer = timeZoneOffsetMinutes("Europe/London", new Date("2026-07-01T12:00:00Z"));
    const winter = timeZoneOffsetMinutes("Europe/London", new Date("2026-01-01T12:00:00Z"));
    expect(summer).toBe(60);
    expect(winter).toBe(0);
  });

  // A zone name removed or renamed by an IANA release must not throw — every
  // caller is rendering a settings surface, not doing arithmetic that matters.
  it("returns 0 rather than throwing on a zone the runtime rejects", () => {
    expect(timeZoneOffsetMinutes("Not/AZone", new Date("2026-08-29T12:00:00Z"))).toBe(0);
  });
});
