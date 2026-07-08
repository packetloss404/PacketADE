import { useSidecarStatus } from "@/hooks/useSidecarStatus";

/**
 * Compact lifecycle-state chip for the Node agent-sidecar.
 *
 * Mount flow:
 *   1. Poll `getSidecarStatus` once to seed initial state.
 *   2. Subscribe to `sidecar-status:changed` for reactive updates.
 *   3. Unsubscribe on unmount.
 *
 * Rendering:
 *   - `restarting`  → yellow dot + "sidecar restarting (N/3)"
 *   - `down`        → red dot + "sidecar down" (tooltip = last_error)
 *   - `ready` / `not_started` → nothing. A permanently green chip trains the
 *     eye to ignore the slot, so the chip only appears when the sidecar is
 *     degraded; full health detail (version/pid/lifetime) remains available
 *     while it is visible via the tooltip.
 */
export function SidecarStatusChip() {
  const status = useSidecarStatus();

  if (!status || status.state === "not_started" || status.state === "ready") {
    // Quiet when healthy: surface only degraded states.
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

  if (status.state === "restarting") {
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
