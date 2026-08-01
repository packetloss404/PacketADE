import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Check,
  CircleAlert,
  Cloud,
  LogIn,
  LogOut,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { signOutProvider, type ProviderAuthStatus } from "@/lib/tauri";
import { authStatusKey, useAuthStatusStore } from "@/stores/authStatusStore";

type ProviderId = "claude-oauth" | "openai-codex";

type ProviderEntry = {
  id: ProviderId;
  name: string;
  description: string;
  /** The custom-event name App.tsx listens for to open a PTY with the right
   *  login command. */
  loginEvent: "packetade:open-claude-login" | "packetade:open-codex-login";
  /** Manual fallback command shown if the user prefers to copy/paste. */
  loginCommand: string;
};

const PROVIDERS: ProviderEntry[] = [
  {
    id: "claude-oauth",
    name: "Anthropic (Claude subscription)",
    description:
      "Sign in with your Claude.ai account so terminal Claude Code sessions use your Pro / Max plan.",
    loginEvent: "packetade:open-claude-login",
    loginCommand: "claude login",
  },
  {
    id: "openai-codex",
    name: "OpenAI (ChatGPT Plus/Pro)",
    description:
      "Sign in with your ChatGPT account so terminal Codex CLI sessions use your plan.",
    loginEvent: "packetade:open-codex-login",
    loginCommand: "codex login",
  },
];

type StatusEntry = ProviderAuthStatus | "loading";

/**
 * v0.8.1: Settings → AI Providers → Subscriptions card.
 *
 * Surfaces the two subscription CLI logins — `claude login` and
 * `codex login` — alongside the API-key providers. Live-refreshes on
 * `provider-auth:changed` so a login from another window updates the badge
 * without a manual refresh.
 *
 * SCOPE (2026-07): these credentials serve **PTY / terminal CLI sessions
 * only**, which are ordinary end-user use of the vendors' own tools. No
 * PacketADE API-agent row consumes them: every provider in the Agents
 * picker authenticates with an API key, because Anthropic does not permit
 * third-party developers to route requests through Free/Pro/Max plan
 * credentials on behalf of their users
 * (https://code.claude.com/docs/en/legal-and-compliance).
 *
 * Sign in dispatches the existing per-provider window event that App.tsx
 * picks up to spawn a workspace PTY running `claude login` / `codex login`.
 * Sign out clears the on-disk credential file(s) via the backend (the
 * auth watcher emits the change event so the badge updates).
 */
export function SubscriptionsCard() {
  const [signingOut, setSigningOut] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useAuthStatusStore((s) => s.fetchStatus);
  const ensureListener = useAuthStatusStore((s) => s.ensureListener);

  // This card is the ambient/default login surface — signing in and out here
  // targets `~/.claude` / `~/.codex`, so it reads the account-less slice of
  // the shared cache.
  const status = useAuthStatusStore(
    useShallow((s) => {
      const out = {} as Record<ProviderId, StatusEntry>;
      for (const p of PROVIDERS) {
        out[p.id] = s.entries[authStatusKey(p.id)]?.value ?? "loading";
      }
      return out;
    }),
  );

  const refresh = useCallback(() => {
    for (const p of PROVIDERS) void fetchStatus(p.id, null, { force: true });
  }, [fetchStatus]);

  // Initial probe on mount + live updates from the auth watcher
  // (~/.claude, ~/.codex). Both are shared with every other consumer of the
  // store, so opening Settings while conversation tiles are mounted no
  // longer re-probes or re-subscribes.
  useEffect(() => {
    ensureListener();
    for (const p of PROVIDERS) void fetchStatus(p.id);
  }, [ensureListener, fetchStatus]);

  function handleSignIn(p: ProviderEntry) {
    window.dispatchEvent(new CustomEvent(p.loginEvent));
  }

  async function handleSignOut(p: ProviderEntry) {
    setError(null);
    setSigningOut(p.id);
    try {
      await signOutProvider(p.id);
      // The auth watcher will emit `provider-auth:changed`, but refresh
      // immediately as a belt-and-braces fallback in case the file delete
      // races with the debounced watcher.
      refresh();
    } catch (err) {
      console.error("signOutProvider failed", err);
      setError(`Sign out failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSigningOut(null);
    }
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <Cloud size={12} className="text-accent-blue" />
          Subscriptions
        </h3>
        <button
          onClick={refresh}
          className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          title="Refresh status"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </div>

      <p className="text-[10px] text-text-muted mb-3 leading-relaxed">
        Sign in with your Claude.ai or ChatGPT account to use those models via
        your subscription instead of an API key.
      </p>

      <div className="flex flex-col gap-2">
        {PROVIDERS.map((p) => {
          const s = status[p.id];
          return (
            <div
              key={p.id}
              className="bg-bg-primary border border-bg-border rounded-lg p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-medium text-text-primary">
                      {p.name}
                    </span>
                    <StatusBadge entry={s} />
                  </div>
                  <p className="text-[10px] text-text-muted leading-snug">
                    {p.description}
                  </p>
                  {s !== "loading" && s.hint && (
                    <p className="text-[10px] text-text-muted/80 mt-1 italic">
                      {s.hint}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  {s !== "loading" && s.status === "ready" ? (
                    <button
                      onClick={() => handleSignOut(p)}
                      disabled={signingOut === p.id}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-red border border-accent-red/30 bg-accent-red/10 rounded hover:bg-accent-red/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {signingOut === p.id ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <LogOut size={10} />
                      )}
                      Sign out
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSignIn(p)}
                      disabled={s === "loading"}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green border border-accent-green/30 bg-accent-green/10 rounded hover:bg-accent-green/20 transition-colors disabled:opacity-50"
                    >
                      <LogIn size={10} />
                      Sign in
                    </button>
                  )}
                  <code className="text-[9px] text-text-muted/70 text-right select-text">
                    {p.loginCommand}
                  </code>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-1.5 text-[10px] text-accent-red bg-accent-red/10 border border-accent-red/30 rounded px-2 py-1.5">
          <CircleAlert size={11} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ entry }: { entry: StatusEntry }) {
  if (entry === "loading") {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] rounded bg-bg-elevated text-text-muted">
        <Loader2 size={9} className="animate-spin" />
        Loading
      </span>
    );
  }
  const map: Record<
    ProviderAuthStatus["status"],
    { label: string; className: string }
  > = {
    ready: {
      label: "Ready",
      className: "bg-accent-green/15 text-accent-green",
    },
    login_required: {
      label: "Login required",
      className: "bg-accent-amber/15 text-accent-amber",
    },
    missing_key: {
      label: "Not configured",
      className: "bg-bg-elevated text-text-muted",
    },
    service_down: {
      label: "Unavailable",
      className: "bg-accent-red/15 text-accent-red",
    },
    coming_soon: {
      label: "Coming soon",
      className: "bg-bg-elevated text-text-muted",
    },
    unknown: {
      label: "Unverifiable",
      className: "bg-bg-elevated text-text-muted",
    },
  };
  const meta = map[entry.status] ?? map.service_down;
  return (
    <span
      className={`flex items-center gap-1 px-1.5 py-0.5 text-[9px] rounded ${meta.className}`}
    >
      {entry.status === "ready" ? <Check size={9} /> : <CircleAlert size={9} />}
      {meta.label}
    </span>
  );
}
