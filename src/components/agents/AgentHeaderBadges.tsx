import { useEffect, useMemo } from "react";
import { Plane } from "lucide-react";
import { AuthBadge, type AuthStatus } from "@/components/ui/AuthBadge";
import { Tooltip } from "@/components/ui/Tooltip";
import { apiAgentProvider, type AgentCli } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { authStatusKey, useAuthStatusStore } from "@/stores/authStatusStore";

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

  // Shared cache: N mounted panes on the same provider share one probe and
  // one `provider-auth:changed` subscription. The Agents surface is
  // single-account by design, so this reads the ambient slice.
  const fetchStatus = useAuthStatusStore((s) => s.fetchStatus);
  const ensureListener = useAuthStatusStore((s) => s.ensureListener);
  const auth = useAuthStatusStore((s) =>
    provider ? s.entries[authStatusKey(provider)]?.value : undefined,
  );

  useEffect(() => {
    if (!provider) return;
    ensureListener();
    void fetchStatus(provider);
  }, [provider, fetchStatus, ensureListener]);

  const authStatus: AuthStatus =
    !auth || auth === "loading" ? "loading" : auth.status;
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
