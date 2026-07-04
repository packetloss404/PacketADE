import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { apiAgentProvider } from "@/stores/agentTaskStore";
import type { AgentCli } from "@/stores/agentTaskStore";
import {
  getProviderAuthStatus,
  type ProviderAuthStatus,
} from "@/lib/tauri";
import { PROVIDER_GROUPS } from "../composer/utils";

export type AuthEntry = ProviderAuthStatus | "loading";

export interface UseProviderAuthStatusResult {
  authStatus: Record<string, AuthEntry>;
  refreshAuthStatuses: () => void;
}

/** Polls + subscribes to provider auth status for every agent in
 * `PROVIDER_GROUPS`. The Rust side watches the claude/codex credential dirs
 * and emits `provider-auth:changed` so badges auto-update after login.
 *
 * Pass `enabled: false` to skip all probing/subscribing (the unified
 * composer's chat variant has no provider picker, so probing ~9 providers
 * per conversation mount would be wasted IPC). */
export function useProviderAuthStatus(enabled = true): UseProviderAuthStatusResult {
  const [authStatus, setAuthStatus] = useState<Record<string, AuthEntry>>({});

  const groupAgents = useMemo<AgentCli[]>(
    () => PROVIDER_GROUPS.flatMap((g) => g.agents),
    [],
  );

  // Per-invocation epoch so overlapping refreshes (e.g. a manual refresh racing
  // a `provider-auth:changed`-triggered one) can't resolve out of order — an
  // older per-agent response must not overwrite a newer one. Bumped again on
  // unmount so late resolutions become no-ops.
  const refreshEpochRef = useRef(0);

  const refreshAuthStatuses = useCallback(() => {
    if (!enabled) return;
    const epoch = ++refreshEpochRef.current;
    setAuthStatus((prev) => {
      const next: Record<string, AuthEntry> = { ...prev };
      for (const a of groupAgents) next[a] = "loading";
      return next;
    });
    for (const agent of groupAgents) {
      const provider = apiAgentProvider(agent);
      getProviderAuthStatus(provider)
        .then((res) => {
          if (refreshEpochRef.current !== epoch) return;
          setAuthStatus((prev) => ({ ...prev, [agent]: res }));
        })
        .catch((err) => {
          if (refreshEpochRef.current !== epoch) return;
          // On failure, show as service_down with the error hint — better
          // than leaving the row stuck in a spinner.
          console.warn(`getProviderAuthStatus(${provider}) failed`, err);
          setAuthStatus((prev) => ({
            ...prev,
            [agent]: { status: "service_down", hint: "Status unavailable" },
          }));
        });
    }
  }, [groupAgents, enabled]);

  useEffect(() => {
    return () => {
      // Invalidate any in-flight refresh so it can't setState after unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: this epoch counter is deliberately bumped in cleanup; it is not a stale DOM ref.
      refreshEpochRef.current++;
    };
  }, []);

  useEffect(() => {
    refreshAuthStatuses();
  }, [refreshAuthStatuses]);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<{ provider: string; status: ProviderAuthStatus }>(
      "provider-auth:changed",
      (event) => {
        const { provider, status } = event.payload;
        const affected = groupAgents.filter(
          (agent) => apiAgentProvider(agent) === provider,
        );
        if (affected.length === 0) return;
        setAuthStatus((prev) => {
          const next = { ...prev };
          for (const agent of affected) next[agent] = status;
          return next;
        });
      },
    )
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.warn("listen(provider-auth:changed) failed", err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [groupAgents, enabled]);

  return { authStatus, refreshAuthStatuses };
}
