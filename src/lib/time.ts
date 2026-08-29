import { useAppStore } from "@/stores/appStore";

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * The zone every date in the app should be rendered in.
 *
 * `appStore.timeZone` is an IANA zone name, or `null` to follow the host. We
 * store the *name*, never a fixed offset: an offset is wrong for half the year
 * anywhere DST applies, and `Intl` resolves a name against the correct offset
 * for each individual timestamp.
 *
 * Falls back to the host zone if the stored name is not one this runtime knows
 * — a zone can be removed or renamed by an IANA release, and a stale persisted
 * value must not make every date in the app throw.
 */
export function resolvedTimeZone(): string {
  const stored = useAppStore.getState().timeZone;
  if (stored && isValidTimeZone(stored)) return stored;
  return hostTimeZone();
}

/** The host system's IANA zone, or `"UTC"` if the runtime will not say. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Whether this runtime accepts `zone` as an IANA zone name. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone list offered in Settings. `Intl.supportedValuesOf` is the real tz
 * database and is present in every runtime this app ships on (Chromium 99+ /
 * WebView2); the short fallback exists only so an older embedded webview
 * degrades to a usable picker rather than an empty one.
 */
export function availableTimeZones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    if (typeof supported === "function") {
      const zones = supported("timeZone");
      if (Array.isArray(zones) && zones.length > 0) return zones;
    }
  } catch {
    // fall through
  }
  const host = hostTimeZone();
  const fallback = [
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
  return fallback.includes(host) ? fallback : [host, ...fallback];
}

/** `UTC−05:00` style label for `zone` at `at`, so a picker can show the offset
 *  that actually applies today rather than a nominal standard-time one. */
export function timeZoneOffsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    // Intl renders a whole-hour zero offset as bare "GMT".
    return name === "GMT" ? "UTC+00:00" : (name ?? "").replace("GMT", "UTC");
  } catch {
    return "";
  }
}

/**
 * `zone`'s UTC offset in whole minutes at `at`, or `0` when the runtime will
 * not say.
 *
 * Exists so a surface can ask "does this zone actually differ from UTC?"
 * numerically rather than by string-matching {@link timeZoneOffsetLabel}. The
 * dictation Analytics tab uses it to decide whether its UTC-bucketing
 * disclosure is worth showing at all — under a zero offset the buckets and the
 * displayed timestamps agree and the note is just noise.
 */
export function timeZoneOffsetMinutes(zone: string, at: Date = new Date()): number {
  try {
    // Format the instant as if it were in `zone`, re-read it as UTC, and diff.
    // `longOffset` parsing would be simpler but does not survive the runtimes
    // that render a bare "GMT" for zero.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      // Intl renders midnight as hour 24 in some locales/runtimes.
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    if (!Number.isFinite(asUtc)) return 0;
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function fmt(ts: number | string | Date, options: Intl.DateTimeFormatOptions): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...options,
      timeZone: resolvedTimeZone(),
    }).format(date);
  } catch {
    return "";
  }
}

/** `Mar 4` — short date in the configured zone. */
export function formatDate(ts: number | string | Date): string {
  return fmt(ts, { month: "short", day: "numeric" });
}

/** `Mar 4, 2026` — short date with year, for anything that can be old. */
export function formatDateWithYear(ts: number | string | Date): string {
  return fmt(ts, { month: "short", day: "numeric", year: "numeric" });
}

/** `14:32` / `2:32 PM` — time in the configured zone, locale-shaped. */
export function formatTime(ts: number | string | Date): string {
  return fmt(ts, { hour: "2-digit", minute: "2-digit" });
}

/** `Mar 4, 14:32` — the combined form most lists want. */
export function formatDateTime(ts: number | string | Date): string {
  const date = formatDate(ts);
  const time = formatTime(ts);
  return date && time ? `${date}, ${time}` : date || time;
}

/**
 * `YYYY-MM-DD` for `ts` **in the configured zone**.
 *
 * This is the bucketing key. `Date#toISOString` would key by UTC, which is what
 * makes a 9pm entry at UTC−05:00 land on tomorrow's row. `en-CA` is used only
 * because it formats as ISO; the zone does the real work.
 */
export function dayKey(ts: number | string | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: resolvedTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}
