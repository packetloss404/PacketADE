import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { authProbeProvider } from "@/stores/agentTaskStore";
import type { AgentCli } from "@/stores/agentTaskStore";
import {
  authStatusKey,
  useAuthStatusStore,
  type AuthEntry,
} from "@/stores/authStatusStore";
import { PROVIDER_GROUPS } from "../composer/utils";

export type { AuthEntry } from "@/stores/authStatusStore";

export interface UseProviderAuthStatusResult {
  authStatus: Record<string, AuthEntry>;
  refreshAuthStatuses: () => void;
}

/** Polls + subscribes to provider auth status for every agent in
 * `PROVIDER_GROUPS`. Probes go through `authProbeProvider`, not
 * `apiAgentProvider`: every picker row is API-key authenticated now, so the
 * Agent SDK row (`api-claude-oauth`) reports its Anthropic *keyring* status
 * rather than the `claude-oauth` OAuth-file probe, which belongs to the PTY
 * CLI launch gate. The Rust side still emits `provider-auth:changed` so the
 * badges refresh when a key or credential changes.
 *
 * Pass `enabled: false` to skip all probing/subscribing (the unified
 * composer's chat variant has no provider picker, so probing ~9 providers
 * per conversation mount would be wasted IPC).
 *
 * State lives in `authStatusStore`, keyed by `(provider, accountId)`. This
 * hook reads the ambient (`accountId === undefined`) slice, because the
 * provider picker is the Agents surface, which stays single-account by
 * design. Sharing the store means N mounted tiles issue one probe per
 * provider between them and share a single `provider-auth:changed`
 * subscription, instead of N of each.
 */
export function useProviderAuthStatus(enabled = true): UseProviderAuthStatusResult {
  const groupAgents = useMemo<AgentCli[]>(
    () => PROVIDER_GROUPS.flatMap((g) => g.agents),
    [],
  );

  const fetchStatus = useAuthStatusStore((s) => s.fetchStatus);
  const ensureListener = useAuthStatusStore((s) => s.ensureListener);

  // Project the shared cache back onto the agent-keyed shape this hook has
  // always returned. `useShallow` keeps the identity stable so consumers
  // don't re-render on unrelated keys landing in the cache.
  const authStatus = useAuthStatusStore(
    useShallow((s) => {
      const out: Record<string, AuthEntry> = {};
      for (const agent of groupAgents) {
        const entry = s.entries[authStatusKey(authProbeProvider(agent))];
        if (entry) out[agent] = entry.value;
      }
      return out;
    }),
  );

  const refreshAuthStatuses = useCallback(() => {
    if (!enabled) return;
    for (const agent of groupAgents) {
      void fetchStatus(authProbeProvider(agent), null, { force: true });
    }
  }, [groupAgents, enabled, fetchStatus]);

  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    for (const agent of groupAgents) {
      void fetchStatus(authProbeProvider(agent));
    }
  }, [groupAgents, enabled, fetchStatus, ensureListener]);

  return { authStatus, refreshAuthStatuses };
}
