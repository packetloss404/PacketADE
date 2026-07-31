import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import {
  getProviderAuthStatus,
  getProviderAuthStatusForDir,
  type ProviderAuthStatus,
} from "@/lib/tauri";

/**
 * Shared provider-auth status cache, keyed by `(provider, accountId)`.
 *
 * Before this store there were four independent fetch + `provider-auth:changed`
 * listen implementations (`useProviderAuthStatus`, `AgentHeaderBadges`,
 * `SubscriptionsCard`, `PlanPanel`) with no shared cache — mounting a few
 * conversation tiles fired the same probe once per tile and installed one
 * Tauri listener per component instance. This store gives all of them one
 * cache, one in-flight request per key, and one global event subscription.
 *
 * `accountId` is the multi-account CLI account whose `configDir` the probe
 * should target. `undefined`/`null` means the **ambient default** login —
 * exactly the single-account behaviour that existed before, and the only
 * thing the API-key providers ever have.
 */

export type AuthEntry = ProviderAuthStatus | "loading";

/** Status shown when the probe itself fails (IPC error, backend rejection). */
export const AUTH_PROBE_FAILED: ProviderAuthStatus = {
  status: "service_down",
  hint: "Status unavailable",
};

/**
 * How long a cached entry is reused before a fresh probe is issued.
 *
 * Deliberately short: the fs watcher pushes `provider-auth:changed` for the
 * cases that matter (a login completing), so the TTL only has to absorb the
 * burst of duplicate probes when several components mount at once.
 */
export const AUTH_STATUS_TTL_MS = 10_000;

export function authStatusKey(
  provider: string,
  accountId?: string | null,
): string {
  return accountId ? `${provider}::${accountId}` : provider;
}

interface CachedEntry {
  value: AuthEntry;
  /** `null` while a probe is in flight and no value has landed yet. */
  fetchedAt: number | null;
}

interface AuthStatusState {
  entries: Record<string, CachedEntry>;
  /** Read the cached value without triggering a fetch. */
  getStatus: (provider: string, accountId?: string | null) => AuthEntry | undefined;
  /**
   * Probe `(provider, accountId)`, reusing a cached value inside the TTL and
   * coalescing concurrent callers onto one in-flight request.
   *
   * `force` skips both the TTL and the cache but still coalesces — a manual
   * refresh from two components at once is still a single IPC call.
   */
  fetchStatus: (
    provider: string,
    accountId?: string | null,
    options?: {
      force?: boolean;
      /**
       * Config dir to probe. Defaults to looking `accountId` up in the
       * CLI-account store; pass it explicitly when you already have the
       * account record (or are probing a dir that isn't registered yet).
       */
      configDir?: string;
    },
  ) => Promise<AuthEntry>;
  /**
   * Drop cached values. With no arguments, drops everything; with a provider,
   * drops every account under it; with both, drops exactly that key.
   */
  invalidate: (provider?: string, accountId?: string | null) => void;
  /** Apply a status pushed by the backend watcher. */
  applyEvent: (
    provider: string,
    accountId: string | null | undefined,
    status: ProviderAuthStatus,
  ) => void;
  /** Idempotently install the single global `provider-auth:changed` listener. */
  ensureListener: () => void;
  /** Test-only escape hatch: drop cache, in-flight map, and listener. */
  reset: () => void;
}

/**
 * In-flight probes, keyed identically to the cache. Kept outside zustand
 * state because promises are not renderable state — subscribers must not
 * re-render when a request starts, only when its result lands.
 */
const inFlight = new Map<string, Promise<AuthEntry>>();

let listenerHandle: UnlistenFn | undefined;
let listenerRequested = false;

export const useAuthStatusStore = create<AuthStatusState>((set, get) => ({
  entries: {},

  getStatus: (provider, accountId) =>
    get().entries[authStatusKey(provider, accountId)]?.value,

  fetchStatus: (provider, accountId, options) => {
    const key = authStatusKey(provider, accountId);
    const force = options?.force ?? false;

    const existing = inFlight.get(key);
    if (existing) return existing;

    if (!force) {
      const cached = get().entries[key];
      if (
        cached &&
        cached.value !== "loading" &&
        cached.fetchedAt !== null &&
        Date.now() - cached.fetchedAt < AUTH_STATUS_TTL_MS
      ) {
        return Promise.resolve(cached.value);
      }
    }

    // An account selection means "probe that account's config dir". No
    // account means the ambient login, which is the zero-arg command — the
    // exact call every pre-multi-account caller already made.
    let probe: Promise<ProviderAuthStatus>;
    if (accountId) {
      const configDir =
        options?.configDir ??
        useCliAccountStore.getState().getAccount(accountId)?.configDir ??
        "";
      if (!configDir) {
        // A dangling account reference. Answering with the AMBIENT status
        // here would be actively dangerous — it is exactly the silent
        // fallback that would run one account's work under another's login.
        const value: AuthEntry = {
          status: "service_down",
          hint: "Account not found",
        };
        set((s) => ({
          entries: { ...s.entries, [key]: { value, fetchedAt: Date.now() } },
        }));
        return Promise.resolve(value);
      }
      probe = getProviderAuthStatusForDir(provider, configDir);
    } else {
      probe = getProviderAuthStatus(provider);
    }

    set((s) => ({
      entries: {
        ...s.entries,
        // A forced refresh shows a spinner (it is user-initiated and the
        // user asked to see it re-check); a background refresh keeps the
        // last known value on screen rather than flashing.
        [key]: {
          value: force ? "loading" : (s.entries[key]?.value ?? "loading"),
          fetchedAt: null,
        },
      },
    }));

    const request = probe
      .then((status): AuthEntry => status)
      .catch((err): AuthEntry => {
        console.warn(`[authStatusStore] probe failed for ${key}`, err);
        return AUTH_PROBE_FAILED;
      })
      .then((value) => {
        inFlight.delete(key);
        set((s) => ({
          entries: { ...s.entries, [key]: { value, fetchedAt: Date.now() } },
        }));
        return value;
      });

    inFlight.set(key, request);
    return request;
  },

  invalidate: (provider, accountId) => {
    if (!provider) {
      inFlight.clear();
      set({ entries: {} });
      return;
    }
    if (accountId !== undefined) {
      const key = authStatusKey(provider, accountId);
      inFlight.delete(key);
      set((s) => {
        const next = { ...s.entries };
        delete next[key];
        return { entries: next };
      });
      return;
    }
    // Provider-wide: the bare provider key plus every `provider::accountId`.
    const prefix = `${provider}::`;
    for (const key of [...inFlight.keys()]) {
      if (key === provider || key.startsWith(prefix)) inFlight.delete(key);
    }
    set((s) => {
      const next: Record<string, CachedEntry> = {};
      for (const [key, entry] of Object.entries(s.entries)) {
        if (key === provider || key.startsWith(prefix)) continue;
        next[key] = entry;
      }
      return { entries: next };
    });
  },

  applyEvent: (provider, accountId, status) => {
    const key = authStatusKey(provider, accountId);
    // The watcher already re-probed on the trailing edge, so this IS the
    // settled value — record it as freshly fetched rather than triggering
    // another round trip.
    set((s) => ({
      entries: { ...s.entries, [key]: { value: status, fetchedAt: Date.now() } },
    }));
  },

  ensureListener: () => {
    if (listenerRequested) return;
    listenerRequested = true;
    listen<{
      provider: string;
      /** Absent for the ambient default — see auth_watcher.rs. */
      accountId?: string | null;
      status: ProviderAuthStatus;
    }>("provider-auth:changed", (event) => {
      const { provider, accountId, status } = event.payload;
      get().applyEvent(provider, accountId ?? null, status);
    })
      .then((fn) => {
        if (!listenerRequested) {
          // reset() ran while we were subscribing.
          fn();
          return;
        }
        listenerHandle = fn;
      })
      .catch((err) => {
        // Allow a later retry (e.g. non-Tauri test env, or a transient
        // failure during startup).
        listenerRequested = false;
        console.warn("[authStatusStore] listen(provider-auth:changed) failed", err);
      });
  },

  reset: () => {
    inFlight.clear();
    listenerRequested = false;
    if (listenerHandle) {
      listenerHandle();
      listenerHandle = undefined;
    }
    set({ entries: {} });
  },
}));

