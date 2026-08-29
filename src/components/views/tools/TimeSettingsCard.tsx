import { useMemo } from "react";
import { Clock } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import {
  availableTimeZones,
  formatDateTime,
  hostTimeZone,
  isValidTimeZone,
  timeZoneOffsetLabel,
} from "@/lib/time";

const SYSTEM = "__system__";

export function TimeSettingsCard() {
  const timeZone = useAppStore((s) => s.timeZone);
  const setTimeZone = useAppStore((s) => s.setTimeZone);

  const host = hostTimeZone();
  const zones = useMemo(() => availableTimeZones(), []);
  // A zone persisted by an older IANA release can vanish from the runtime's
  // list. Keep it selectable so the picker shows what is actually stored
  // instead of silently snapping to the top entry.
  const stored = timeZone ?? null;
  const storedIsUnknown = stored !== null && !zones.includes(stored);
  const effective = stored && isValidTimeZone(stored) ? stored : host;

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Clock size={12} className="text-accent-green" aria-hidden="true" />
        Date &amp; Time
      </h3>

      <p className="mb-3 text-[10px] text-text-muted leading-snug">
        The zone every date and time in PacketBench is displayed in. Stored as a
        zone name, so daylight saving is applied correctly to each timestamp
        rather than a single fixed offset.
      </p>

      <label
        htmlFor="tz-select"
        className="mb-1 block text-[10px] font-medium text-text-secondary"
      >
        Time zone
      </label>
      <select
        id="tz-select"
        className="w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary focus-visible:ring-2 focus-visible:ring-accent-green"
        value={stored ?? SYSTEM}
        onChange={(e) => setTimeZone(e.target.value === SYSTEM ? null : e.target.value)}
      >
        <option value={SYSTEM}>
          System default — {host} ({timeZoneOffsetLabel(host)})
        </option>
        {storedIsUnknown && (
          <option value={stored}>{stored} — not known to this system</option>
        )}
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone} ({timeZoneOffsetLabel(zone)})
          </option>
        ))}
      </select>

      <p className="mt-2 text-[10px] text-text-muted" role="status">
        Now in {effective}: <span className="text-text-secondary">{formatDateTime(Date.now())}</span>
      </p>

      {storedIsUnknown && (
        <p className="mt-2 text-[10px] text-accent-amber leading-snug" role="alert">
          The saved zone <span className="font-mono">{stored}</span> is not one this
          system recognises, so dates are being shown in {host} instead. Pick a
          zone from the list to clear this.
        </p>
      )}

      <p className="mt-3 border-t border-bg-border pt-2 text-[10px] text-text-muted leading-snug">
        Dictation analytics — streaks, hourly activity, and the daily and weekly
        totals — are still grouped by <span className="font-mono">UTC</span> days
        in the backend and do not yet follow this setting. Away from UTC they can
        disagree with the timestamps shown elsewhere for entries near midnight.
        The Analytics tab says so inline rather than leaving it to this card.
      </p>
    </div>
  );
}
