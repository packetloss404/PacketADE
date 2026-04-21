import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSidecarStatus, type SidecarStatus } from "@/lib/tauri";

/**
 * Compact lifecycle-state chip for the Node agent-sidecar.
 *
 * Mount flow:
 *   1. Poll `getSidecarStatus` once to seed initial state.
 *   2. Subscribe to `sidecar-status:changed` for reactive updates.
 *   3. Unsubscribe on unmount.
 *
 * Rendering:
 *   - `ready`       → green dot + "sidecar ready"
 *   - `restarting`  → yellow dot + "sidecar restarting (N/3)"
 *   - `down`        → red dot + "sidecar down" (tooltip = last_error)
 *   - `not_started` → nothing (chip is omitted until the supervisor has
 *                     actually done something)
 */
export function SidecarStatusChip() {
  const [status, setStatus] = useState<SidecarStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Seed with a one-shot poll so the chip renders before any transition
    // event fires.
    getSidecarStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // If the backend isn't ready yet (Tauri harness still booting) the
        // listener below will pick up the first real transition.
      });

    const unlistenPromise = listen<SidecarStatus>("sidecar-status:changed", (evt) => {
      if (!cancelled) setStatus(evt.payload);
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((off) => off()).catch(() => {});
    };
  }, []);

  if (!status || status.state === "not_started") {
    // Don't clutter the bar before the supervisor has emitted anything.
    return null;
  }

  let dotClass = "text-text-muted";
  let label = "sidecar";
  let tooltip: string | undefined;

  // Cross-restart counters (v2 Tier 4 slice A). Folded into every tooltip
  // so a glance at the chip shows long-term sidecar health, not just the
  // current run. `last_version` is used as a fallback when the live
  // `status.version` hasn't been populated yet (e.g. during `restarting`).
  const lifetime = status.lifetime;
  const lifetimeLine = [
    `${lifetime.total_starts} starts`,
    `${lifetime.total_crashes} crashes`,
    lifetime.last_version ?? status.version ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (status.state === "ready") {
    dotClass = "text-accent-green";
    label = "sidecar ready";
    const head =
      [
        status.version ? `version ${status.version}` : null,
        status.pid != null ? `pid ${status.pid}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "sidecar ready";
    tooltip = `${head}\n${lifetimeLine}`;
  } else if (status.state === "restarting") {
    dotClass = "text-accent-amber";
    label = `sidecar restarting (${status.restart_count}/3)`;
    tooltip = `${status.last_error ?? label}\n${lifetimeLine}`;
  } else if (status.state === "down") {
    dotClass = "text-accent-red";
    label = "sidecar down";
    tooltip = `${status.last_error ?? "Sidecar is down"}\n${lifetimeLine}`;
  }

  return (
    <div
      className="flex items-center gap-1 px-1.5 text-text-muted text-[10px] select-none"
      title={tooltip}
    >
      <span className={`${dotClass} leading-none`} aria-hidden>
        ●
      </span>
      <span>{label}</span>
    </div>
  );
}
