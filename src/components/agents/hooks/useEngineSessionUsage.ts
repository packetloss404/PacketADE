import { useEffect, useState } from "react";
import { acpSessionUsage } from "@/lib/tauri";
import type { SessionUsage } from "@/lib/usageStatusline";

/**
 * Session usage for an ACP conversation, QUERIED rather than received.
 *
 * ## Why this hook has to exist
 *
 * Every other transport pushes `api-agent:turn-summary` and the statusline
 * rolls the per-message token counts up with `sessionUsageFor`. The ACP
 * transport deliberately emits no per-turn summary: the engine's usage totals
 * are session-CUMULATIVE, so stamping them onto each turn would make the cost
 * ledger count the whole session again on every turn. The totals are therefore
 * only available by asking — which is what this does.
 *
 * ## Polling policy
 *
 * On mount, and on each turn END (`turnActive` falling). Never on a timer:
 * the numbers cannot move while no turn is running, and a composer that
 * re-queries a subprocess on an interval is exactly the always-mounted live
 * spend chip this pane removed. A query in flight blocks nothing — the
 * statusline keeps its previous line until an answer lands.
 *
 * ## Degradation
 *
 * `null` on rejection, on an engine that predates the extension (the binding
 * itself resolves `null` there), and for every non-engine session (`enabled`
 * false). The caller falls back to `sessionUsageFor`, i.e. today's behavior.
 */
export function useEngineSessionUsage(
  conversationId: string,
  enabled: boolean,
  turnActive: boolean,
): SessionUsage | null {
  const [usage, setUsage] = useState<SessionUsage | null>(null);

  useEffect(() => {
    if (!enabled || !conversationId) {
      setUsage(null);
      return undefined;
    }
    // A turn is running: its totals are not final, and the engine is busy.
    // Wait for the falling edge.
    if (turnActive) return undefined;

    let cancelled = false;
    acpSessionUsage(conversationId)
      .then((next) => {
        if (cancelled) return;
        setUsage(
          next
            ? {
                contextTokens: next.contextTokens,
                totalInput: next.totalInput,
                totalOutput: next.totalOutput,
                costUsd: next.costUsd,
              }
            : null,
        );
      })
      .catch(() => {
        /* Leave whatever was last known on screen rather than blanking the
           statusline because one query failed. */
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, enabled, turnActive]);

  return usage;
}
