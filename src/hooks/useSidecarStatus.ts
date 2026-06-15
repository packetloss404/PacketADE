import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSidecarStatus, type SidecarStatus } from "@/lib/tauri";

/**
 * Shared subscription to the Node agent-sidecar's lifecycle state.
 *
 * Implementation notes:
 *   1. One-shot poll on mount seeds the initial value so consumers can
 *      render before the supervisor emits its first transition.
 *   2. Listens for `sidecar-status:changed` events for reactive updates.
 *   3. Returns `null` until the first poll resolves (or fails silently).
 *
 * Two consumers exist today — the toolbar's {@link SidecarStatusChip} and
 * the bottom {@link StatusStrip}'s persistent status dot — and they read
 * the same Tauri command, so any future consolidation (e.g., a Zustand
 * mirror with a single subscriber) would happen here.
 */
export function useSidecarStatus(): SidecarStatus | null {
  const [status, setStatus] = useState<SidecarStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    getSidecarStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // Backend not ready yet (Tauri harness still booting) — the
        // event listener below will pick up the first real transition.
      });

    const unlistenPromise = listen<SidecarStatus>(
      "sidecar-status:changed",
      (evt) => {
        if (!cancelled) setStatus(evt.payload);
      },
    );

    return () => {
      cancelled = true;
      unlistenPromise.then((off) => off()).catch(() => {});
    };
  }, []);

  return status;
}
