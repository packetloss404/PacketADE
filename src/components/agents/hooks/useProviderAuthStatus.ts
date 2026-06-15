import { useCallback, useEffect, useMemo, useState } from "react";
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
 * and emits `provider-auth:changed` so badges auto-update after login. */
export function useProviderAuthStatus(): UseProviderAuthStatusResult {
  const [authStatus, setAuthStatus] = useState<Record<string, AuthEntry>>({});

  const groupAgents = useMemo<AgentCli[]>(
    () => PROVIDER_GROUPS.flatMap((g) => g.agents),
    [],
  );

  const refreshAuthStatuses = useCallback(() => {
    setAuthStatus((prev) => {
      const next: Record<string, AuthEntry> = { ...prev };
      for (const a of groupAgents) next[a] = "loading";
      return next;
    });
    for (const agent of groupAgents) {
      const provider = apiAgentProvider(agent);
      getProviderAuthStatus(provider)
        .then((res) => {
          setAuthStatus((prev) => ({ ...prev, [agent]: res }));
        })
        .catch((err) => {
          // On failure, show as service_down with the error hint — better
          // than leaving the row stuck in a spinner.
          console.warn(`getProviderAuthStatus(${provider}) failed`, err);
          setAuthStatus((prev) => ({
            ...prev,
            [agent]: { status: "service_down", hint: "Status unavailable" },
          }));
        });
    }
  }, [groupAgents]);

  useEffect(() => {
    refreshAuthStatuses();
  }, [refreshAuthStatuses]);

  useEffect(() => {
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
  }, [groupAgents]);

  return { authStatus, refreshAuthStatuses };
}
