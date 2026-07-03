import { useEffect, useMemo, useState } from "react";
import { Plane } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AuthBadge, type AuthStatus } from "@/components/ui/AuthBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { apiAgentProvider, type AgentCli } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import {
  getProviderAuthStatus,
  type ProviderAuthStatus,
} from "@/lib/tauri";

type AuthEntry = ProviderAuthStatus | "loading";

interface AgentHeaderBadgesProps {
  conversationId: string;
  agent: AgentCli;
}

/**
 * Compact, read-only context badges that live in the AgentChatPane title row.
 *
 * - Auth chip: live provider-auth status (re-fetched on `provider-auth:changed`).
 *   Only shown for API-mode agents — PTY agents get their auth surfaced
 *   elsewhere (the legacy launch flow has its own status bar).
 * - Flight chip: when this conversation's id appears in any flight's
 *   `linkedSessionIds`, render a clickable badge that jumps to FlightsView
 *   with the flight pre-selected.
 *
 * The MCP server-selection popover that used to live here moved to Settings
 * (ToolsView's McpServersCard) — a per-conversation checkbox popover was the
 * wrong home for a setting whose caption admitted it only applies "on next
 * launch"; a project-level default belongs in Settings.
 */
export function AgentHeaderBadges({
  conversationId,
  agent,
}: AgentHeaderBadgesProps) {
  const flights = useFlightStore((s) => s.flights);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const linkedFlight = useMemo(
    () => flights.find((f) => f.linkedSessionIds.includes(conversationId)) ?? null,
    [flights, conversationId],
  );

  const isApi = agent.startsWith("api-");
  const provider = isApi ? apiAgentProvider(agent) : null;

  const [auth, setAuth] = useState<AuthEntry>("loading");

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    setAuth("loading");
    getProviderAuthStatus(provider)
      .then((res) => {
        if (!cancelled) setAuth(res);
      })
      .catch(() => {
        if (!cancelled)
          setAuth({ status: "service_down", hint: "Status unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Live updates from the auth-watcher (claude/codex credential file changes).
  useEffect(() => {
    if (!provider) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<{ provider: string; status: ProviderAuthStatus }>(
      "provider-auth:changed",
      (event) => {
        if (event.payload.provider !== provider) return;
        setAuth(event.payload.status);
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.warn(
          "[AgentHeaderBadges.listenProviderAuth] subscribe failed:",
          err,
        ),
      );
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [provider]);

  const authStatus: AuthStatus =
    auth === "loading" || !auth ? "loading" : auth.status;
  const authHint = auth && auth !== "loading" ? auth.hint : "";

  return (
    <>
      {provider && (
        <Tooltip content={authHint || `Provider: ${provider}`}>
          <span className="flex items-center gap-1 text-meta bg-bg-secondary rounded px-1.5 py-0.5">
            <AuthBadge status={authStatus} />
            <span className="text-text-muted leading-none">{provider}</span>
          </span>
        </Tooltip>
      )}

      {linkedFlight && (
        <Tooltip content={`Linked to flight "${linkedFlight.title}" — click to open`}>
          <button
            type="button"
            onClick={() => {
              setActiveFlight(linkedFlight.id);
              setActiveView("flights");
            }}
            className="flex items-center gap-1 text-meta text-accent-purple bg-accent-purple/10 border border-accent-purple/30 rounded px-1.5 py-0.5 hover:bg-accent-purple/20 transition-colors"
          >
            <Plane size={10} />
            <span className="truncate max-w-[120px]">{linkedFlight.title}</span>
          </button>
        </Tooltip>
      )}
    </>
  );
}
