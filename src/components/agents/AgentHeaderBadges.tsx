import { useEffect, useMemo, useRef, useState } from "react";
import { Plane, Plug } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AuthBadge, type AuthStatus } from "@/components/ui/AuthBadge";
import {
  apiAgentProvider,
  useAgentTaskStore,
  type AgentCli,
} from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";
import { useMcpStore } from "@/stores/mcpStore";
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
 *   `linkedSessionIds`, render a clickable badge that jumps to MissionsView
 *   with the flight pre-selected.
 *
 * MCP count and a richer memory-pattern preview are intentionally deferred —
 * the existing right-side action group already exposes a Memory toggle, and
 * MCP enumeration needs an async per-project read that's better folded into
 * the SessionHealthBar slice.
 */
export function AgentHeaderBadges({
  conversationId,
  agent,
}: AgentHeaderBadgesProps) {
  const flights = useFlightStore((s) => s.flights);
  const setActiveFlight = useFlightStore((s) => s.setActiveFlight);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const setEnabledMcpServerIds = useAgentTaskStore(
    (s) => s.setEnabledMcpServerIds,
  );
  const mcpServers = useMcpStore((s) => s.servers);
  const fetchMcpServers = useMcpStore((s) => s.fetchServers);
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false);
  const mcpMenuRef = useRef<HTMLDivElement>(null);

  // Lazy-fetch the MCP server list once when the menu opens — the store is
  // shared with ToolsView so a fresh fetch keeps it current. Best-effort.
  useEffect(() => {
    if (!mcpMenuOpen) return;
    void fetchMcpServers();
    const onClick = (e: MouseEvent) => {
      if (
        mcpMenuRef.current &&
        !mcpMenuRef.current.contains(e.target as Node)
      ) {
        setMcpMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [mcpMenuOpen, fetchMcpServers]);

  const linkedFlight = useMemo(
    () => flights.find((f) => f.linkedSessionIds.includes(conversationId)) ?? null,
    [flights, conversationId],
  );

  // Compute the set of MCP servers active for THIS conversation. Default
  // (undefined filter) = every non-disabled server. Otherwise only the
  // names in the conversation's filter, intersected with non-disabled.
  const eligibleServers = useMemo(
    () => mcpServers.filter((s) => !s.disabled),
    [mcpServers],
  );
  const activeNames = useMemo(() => {
    if (!conversation || conversation.enabledMcpServerIds === undefined)
      return new Set(eligibleServers.map((s) => s.name));
    return new Set(conversation.enabledMcpServerIds);
  }, [conversation, eligibleServers]);
  const activeCount = eligibleServers.filter((s) => activeNames.has(s.name))
    .length;

  function toggleServer(name: string) {
    const current = conversation?.enabledMcpServerIds ?? eligibleServers.map((s) => s.name);
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    setEnabledMcpServerIds(conversationId, next);
  }

  function resetToAll() {
    setEnabledMcpServerIds(conversationId, null);
  }

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
      .catch(() => {});
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
        <span
          className="flex items-center gap-1 text-[10px] bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5"
          title={authHint || `Provider: ${provider}`}
        >
          <AuthBadge status={authStatus} />
          <span className="text-text-muted leading-none">{provider}</span>
        </span>
      )}

      {linkedFlight && (
        <button
          type="button"
          onClick={() => {
            setActiveFlight(linkedFlight.id);
            setActiveView("missions");
          }}
          title={`Linked to mission "${linkedFlight.title}" — click to open`}
          className="flex items-center gap-1 text-[10px] text-accent-purple bg-accent-purple/10 border border-accent-purple/30 rounded px-1.5 py-0.5 hover:bg-accent-purple/20 transition-colors"
        >
          <Plane size={10} />
          <span className="truncate max-w-[120px]">{linkedFlight.title}</span>
        </button>
      )}

      {eligibleServers.length > 0 && (
        <div className="relative" ref={mcpMenuRef}>
          <button
            type="button"
            onClick={() => setMcpMenuOpen((v) => !v)}
            title={
              activeCount === 0
                ? "MCP servers — none active for this conversation. Click to choose."
                : `MCP servers active: ${eligibleServers
                    .filter((s) => activeNames.has(s.name))
                    .map((s) => s.name)
                    .join(", ")}`
            }
            className="flex items-center gap-1 text-[10px] text-accent-blue bg-accent-blue/10 border border-accent-blue/30 rounded px-1.5 py-0.5 hover:bg-accent-blue/20 transition-colors"
          >
            <Plug size={10} />
            <span>
              MCP {activeCount}/{eligibleServers.length}
            </span>
          </button>
          {mcpMenuOpen && (
            <div className="absolute top-full right-0 mt-1 w-72 bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50">
              <div className="px-3 py-2 border-b border-bg-border">
                <div className="text-[10px] uppercase tracking-wider text-text-muted">
                  MCP servers
                </div>
                <div className="text-[9.5px] text-text-faint mt-0.5">
                  Changes apply on next launch (sidecar can't hot-swap MCP).
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {eligibleServers.map((srv) => {
                  const on = activeNames.has(srv.name);
                  return (
                    <label
                      key={srv.name}
                      className="flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-bg-hover cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleServer(srv.name)}
                      />
                      <span className="flex flex-col flex-1 min-w-0">
                        <span className="text-text-primary truncate">
                          {srv.name}
                        </span>
                        <span className="text-[9.5px] text-text-muted truncate">
                          {srv.scope} · {srv.config.command}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="px-3 py-1.5 border-t border-bg-border flex items-center justify-between">
                <button
                  type="button"
                  onClick={resetToAll}
                  className="text-[10px] text-text-muted hover:text-text-secondary"
                  title="Reset to default — every non-disabled server is enabled"
                >
                  Reset to all
                </button>
                <button
                  type="button"
                  onClick={() => setMcpMenuOpen(false)}
                  className="text-[10px] text-accent-green hover:underline"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
