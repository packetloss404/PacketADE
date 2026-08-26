/**
 * MCP consent for the packetcode ACP transport — what would run, before
 * anything runs.
 *
 * # Why this surface exists
 *
 * An ACP session's MCP servers are local subprocesses the ENGINE spawns on the
 * user's machine, named by PacketBench at `session/new`. Unlike the Node sidecar,
 * packetcode owns the MCP client and dispatches every tool call itself, so
 * PacketBench cannot filter anything after the fact: the only enforceable
 * question is *may this server run at all*, and it has to be answered before
 * the session starts. This is where it is asked and answered.
 *
 * # One consent model, not a second one
 *
 * Every control here writes to the stores the rest of the app already uses —
 * `mcpTrustStore` for per-server authority and `agentSettingsStore`'s
 * `defaultEnabledMcpServerIds` for the allowlist. `createApiConversation`
 * freezes both into the conversation via `captureMcpTrustSnapshot`, and the
 * backend derives the ACP posture from exactly that pair
 * (`acp::mcp::posture_for_session`). There is deliberately no ACP-only consent
 * record: a decision made here is the same decision every transport honours,
 * and the plan shown here is computed by the same Rust code that builds the
 * wire frame (`acp_mcp_plan`), so the preview and the session cannot diverge.
 *
 * # Safe by default, and honest about it
 *
 * `acp_mcp_plan` refuses on absence: no allowlist or no trust snapshot yields
 * an empty plan, which is `mcpServers: []` — not one subprocess started. This
 * component never papers over that with an optimistic default. With nothing
 * decided it says so plainly and shows every configured server sitting outside
 * the session, each with the reason it is outside.
 *
 * The engine's OWN fleet is a separate disclosure and a separate consent:
 * inheriting it means "run whatever your config.toml lists", which can only be
 * granted wholesale, is scoped to this app run, and is refused outright by an
 * engine that never advertised `mcpDefaults` — reported as `inheritRefused`
 * rather than silently doing nothing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Server, ShieldCheck, ShieldOff } from "lucide-react";
import {
  acpListMcpServers,
  acpMcpPlan,
  type AcpMcpPlan,
  type AcpMcpPlannedServer,
  type AcpMcpReason,
  type AcpMcpServerStatus,
} from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useMcpTrustStore } from "@/stores/mcpTrustStore";
import type { SessionCapabilities } from "@/lib/agentCapabilities";
import type { McpServerEntry } from "@/types/mcp";

interface AcpMcpConsentProps {
  /**
   * The project a prospective session would run in. Both the allowlist and the
   * command resolution are relative to it, so the plan is only meaningful with
   * one — an empty string renders the surface as "pick a project first".
   */
  projectPath: string;
  /**
   * The descriptor for the session (or, on the directory, for the engine
   * itself). MCP disclosure renders only where `caps.mcp` is true — that flag
   * is what says a fleet was sourced or the engine advertised one at all.
   */
  caps: SessionCapabilities;
}

/** How each admission verdict reads to a person. */
const REASON_COPY: Record<AcpMcpReason, string> = {
  trusted: "Allowed — this server will start.",
  disabled: "Disabled in MCP settings.",
  noTrustDecision: "No decision recorded yet, so it stays off.",
  notSelected: "Not allowed for agent sessions.",
  noSnapshotForServer: "Allowed, but no trust record was captured for it.",
  trustDeniesServer: "Its trust profile withholds reads.",
  unsupportedTransport: "packetcode's ACP surface runs stdio servers only.",
  commandNotResolvable: "Its command could not be resolved to an executable.",
};

/**
 * Whether saying yes here would change this verdict.
 *
 * `disabled`, `unsupportedTransport` and `commandNotResolvable` are facts about
 * the configuration, not about consent — offering an Allow that cannot take
 * effect would be exactly the silent no-op this pane forbids.
 */
function consentCanFix(reason: AcpMcpReason): boolean {
  return (
    reason === "noTrustDecision" ||
    reason === "notSelected" ||
    reason === "noSnapshotForServer" ||
    reason === "trustDeniesServer"
  );
}

/**
 * The allowlist as an explicit list of names.
 *
 * `null` means "every non-disabled server", which the sidecar resolves for
 * itself but ACP cannot accept — it is an absence of a decision, and ACP has
 * no way to filter a server it was not told about. Materializing it names the
 * servers that were already included, so the sidecar's behaviour today is
 * unchanged while ACP finally has something affirmative to send.
 */
function materialize(enabled: string[] | null, servers: McpServerEntry[]): string[] {
  if (enabled !== null) return enabled;
  return servers.filter((server) => !server.disabled).map((server) => server.name);
}

export function AcpMcpConsent({ projectPath, caps }: AcpMcpConsentProps) {
  const servers = useMcpStore((state) => state.servers);
  const mcpError = useMcpStore((state) => state.error);
  const fetchServers = useMcpStore((state) => state.fetchServers);
  const profiles = useMcpTrustStore((state) => state.profiles);
  const setProfile = useMcpTrustStore((state) => state.setProfile);
  const snapshot = useMcpTrustStore((state) => state.snapshot);
  const enabledIds = useAgentSettingsStore((state) => state.defaultEnabledMcpServerIds);
  const setEnabledIds = useAgentSettingsStore((state) => state.setDefaultEnabledMcpServerIds);
  const inherit = useAgentTaskStore((state) => state.acpInheritEngineMcp);
  const setInherit = useAgentTaskStore((state) => state.setAcpInheritEngineMcp);

  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<AcpMcpPlan | null>(null);
  const [planStatus, setPlanStatus] = useState<"idle" | "loading" | "ready" | "unavailable">(
    "idle",
  );
  const [fleetOpen, setFleetOpen] = useState(false);
  const [fleet, setFleet] = useState<AcpMcpServerStatus[]>([]);
  const [fleetStatus, setFleetStatus] = useState<"idle" | "loading" | "ready" | "unavailable">(
    "idle",
  );

  // Reading the configuration is what the whole surface is about, so it starts
  // when the user opens it — not on every sidebar render.
  useEffect(() => {
    if (!open || servers.length > 0) return;
    void fetchServers().catch(logSwallowed("AcpMcpConsent.fetchServers"));
  }, [fetchServers, open, servers.length]);

  /**
   * The trust snapshot this decision WOULD freeze, built by the same store
   * call `captureMcpTrustSnapshot` makes at session start. Previewing with
   * anything else would show a plan for a session nobody is going to start.
   */
  const previewSnapshot = useMemo(() => {
    // `profiles` is a dependency rather than an argument: `snapshot` reads the
    // store's current profiles itself, so the memo has to re-run when they
    // change or an Allow click would leave the plan showing the old verdict.
    void profiles;
    if (servers.length === 0) return [];
    return snapshot(servers, enabledIds, projectPath || null);
  }, [enabledIds, profiles, projectPath, servers, snapshot]);

  const refreshPlan = useCallback(() => {
    if (!projectPath) {
      setPlan(null);
      setPlanStatus("idle");
      return () => {};
    }
    let cancelled = false;
    setPlanStatus((current) => (current === "ready" ? current : "loading"));
    acpMcpPlan({
      projectPath,
      enabledMcpServerIds: enabledIds,
      // An empty preview is a REAL answer (nothing configured, or nothing
      // selected) and must reach the backend as `[]`, which yields the
      // refusing plan. Sending `null` instead would be indistinguishable from
      // "we never asked".
      mcpTrustSnapshot: previewSnapshot,
      inheritEngineDefaults: inherit,
    })
      .then((next) => {
        if (cancelled) return;
        setPlan(next);
        setPlanStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        // Degrade, never throw into render: an unanswerable plan means the
        // surface says it cannot show one, and the backend's own refusal
        // (start nothing) still stands.
        logSwallowed("AcpMcpConsent.acpMcpPlan")(e);
        setPlan(null);
        setPlanStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [enabledIds, inherit, previewSnapshot, projectPath]);

  useEffect(() => {
    if (!open) return;
    return refreshPlan();
  }, [open, refreshPlan]);

  const loadFleet = useCallback(() => {
    setFleetStatus("loading");
    acpListMcpServers(null)
      .then((rows) => {
        setFleet(rows);
        setFleetStatus("ready");
      })
      .catch((e) => {
        logSwallowed("AcpMcpConsent.acpListMcpServers")(e);
        setFleet([]);
        setFleetStatus("unavailable");
      });
  }, []);

  useEffect(() => {
    if (!fleetOpen || fleetStatus !== "idle") return;
    loadFleet();
  }, [fleetOpen, fleetStatus, loadFleet]);

  const entryFor = useCallback(
    (candidate: AcpMcpPlannedServer): McpServerEntry | undefined =>
      servers.find(
        (server) => server.name === candidate.name && server.scope === candidate.scope,
      ) ?? servers.find((server) => server.name === candidate.name),
    [servers],
  );

  const decide = useCallback(
    (candidate: AcpMcpPlannedServer, allowed: boolean) => {
      const entry = entryFor(candidate);
      if (!entry) return;
      // Both halves of the existing model, written together: the allowlist
      // says whether the server is in scope for agent sessions, the trust
      // profile says whether it may read at all. ACP needs both to be
      // affirmative; every other transport reads the same two fields.
      setProfile(entry, { allowReads: allowed }, projectPath || null);
      const named = materialize(enabledIds, servers);
      setEnabledIds(
        allowed
          ? named.includes(entry.name)
            ? named
            : [...named, entry.name]
          : named.filter((name) => name !== entry.name),
      );
    },
    [enabledIds, entryFor, projectPath, servers, setEnabledIds, setProfile],
  );

  // The governing gate. `caps.mcp` is false where no fleet was sourced and the
  // engine advertised neither `mcpList` nor `mcpDefaults` — there is then
  // nothing truthful to disclose, so nothing is shown.
  if (!caps.mcp) return null;

  const selected = plan?.selected ?? [];
  const startsNothing = planStatus === "ready" && selected.length === 0;

  return (
    <section className="mt-3 border-t border-line-soft pt-2">
      <div className="flex items-center gap-2 rounded-lg px-2 py-[4.5px]">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title="What MCP servers a new packetcode session would start"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-ui font-semibold text-text-primary"
        >
          {open ? (
            <ChevronDown size={10} className="shrink-0 text-text-muted" />
          ) : (
            <ChevronRight size={10} className="shrink-0 text-text-muted" />
          )}
          <span className="min-w-0 flex-1 truncate">MCP for new sessions</span>
        </button>
        {open && planStatus === "ready" && (
          <span className="shrink-0 font-mono text-meta text-text-faint">
            {selected.length}
          </span>
        )}
        {open && (
          <button
            type="button"
            onClick={() => refreshPlan()}
            disabled={planStatus === "loading"}
            title="Re-read the MCP configuration"
            className="rounded p-0.5 text-text-muted hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw
              size={10}
              className={
                planStatus === "loading" ? "animate-spin motion-reduce:animate-none" : undefined
              }
            />
          </button>
        )}
      </div>

      {open && (
        <>
          <p className="px-2 pb-1.5 text-meta leading-snug text-text-muted">
            Each allowed server is a program the packetcode engine starts on this machine.
            Nothing starts unless it is allowed here — and an answer given here applies to
            every agent transport, not just packetcode.
          </p>

          {!projectPath && (
            <p className="px-2 py-1 text-meta text-text-faint">
              Open a project to see what a session in it would start.
            </p>
          )}

          {projectPath && planStatus === "loading" && plan === null && (
            <p className="px-2 py-1 text-meta text-text-faint">Reading the configuration…</p>
          )}

          {projectPath && planStatus === "unavailable" && (
            <p className="px-2 py-1 text-meta text-text-faint">
              Could not work out what a session would start, so nothing is claimed here. A
              session started now would run no MCP servers.
            </p>
          )}

          {mcpError && (
            <p className="px-2 py-1 text-meta text-text-faint">
              MCP configuration could not be read: {mcpError}
            </p>
          )}

          {plan && (
            <>
              <div
                className={`mx-2 mb-1.5 rounded-md border px-2 py-1 text-meta leading-snug ${
                  startsNothing
                    ? "border-bg-border bg-bg-tertiary text-text-muted"
                    : "border-accent-line bg-accent-soft text-text-secondary"
                }`}
              >
                {startsNothing ? (
                  <>No MCP servers will start. That is the default until something is allowed.</>
                ) : (
                  <>
                    {selected.length} server{selected.length === 1 ? "" : "s"} will start:{" "}
                    <span className="font-mono text-text-primary">{selected.join(", ")}</span>
                  </>
                )}
              </div>

              {plan.inheritRefused && (
                <div className="mx-2 mb-1.5 rounded-md border border-accent-amber bg-bg-tertiary px-2 py-1 text-meta leading-snug text-text-secondary">
                  You allowed this session to inherit the engine's own servers, but this engine
                  never advertised that it understands the request — so it was refused and no
                  engine servers will start. Nothing was silently substituted.
                </div>
              )}

              {plan.servers.length === 0 && (
                <p className="px-2 py-1 text-meta text-text-faint">
                  PacketBench has no MCP servers configured for this project.
                </p>
              )}

              {plan.servers.map((candidate) => {
                const known = entryFor(candidate) !== undefined;
                const fixable = known && consentCanFix(candidate.reason);
                return (
                  <div
                    key={`${candidate.scope}:${candidate.name}`}
                    className="mx-2 mb-1 rounded-md border border-bg-border bg-bg-primary px-2 py-1.5"
                  >
                    <div className="flex items-center gap-1.5">
                      {candidate.included ? (
                        <ShieldCheck size={11} className="shrink-0 text-accent-green" />
                      ) : (
                        <ShieldOff size={11} className="shrink-0 text-text-faint" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-ui text-text-primary">
                        {candidate.name}
                      </span>
                      <span className="shrink-0 text-meta text-text-faint">
                        {candidate.scope} · {candidate.transport}
                      </span>
                    </div>
                    <p
                      className="mt-0.5 truncate font-mono text-meta text-text-muted"
                      title={[candidate.command, ...candidate.args].join(" ")}
                    >
                      {candidate.command || "(no command configured)"}
                    </p>
                    <p className="mt-0.5 text-meta leading-snug text-text-secondary">
                      {REASON_COPY[candidate.reason]}
                    </p>
                    {(candidate.included || fixable) && (
                      <div className="mt-1 flex items-center gap-1">
                        {!candidate.included && fixable && (
                          <button
                            type="button"
                            onClick={() => decide(candidate, true)}
                            className="rounded border border-accent-line bg-accent-soft px-1.5 py-0.5 text-meta text-text-primary hover:bg-bg-hover"
                          >
                            Allow
                          </button>
                        )}
                        {candidate.included && (
                          <button
                            type="button"
                            onClick={() => decide(candidate, false)}
                            className="rounded border border-bg-border bg-bg-tertiary px-1.5 py-0.5 text-meta text-text-secondary hover:bg-bg-hover"
                          >
                            Don&apos;t allow
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* The engine's own fleet: a different set of servers, disclosed
              separately because consenting to it is a different promise. */}
          <div className="mt-1.5 flex items-center gap-2 rounded-lg px-2 py-[4.5px]">
            <button
              type="button"
              onClick={() => setFleetOpen((value) => !value)}
              aria-expanded={fleetOpen}
              title="Servers the packetcode engine has configured for itself"
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-ui font-medium text-text-secondary"
            >
              {fleetOpen ? (
                <ChevronDown size={10} className="shrink-0 text-text-muted" />
              ) : (
                <ChevronRight size={10} className="shrink-0 text-text-muted" />
              )}
              <Server size={10} className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate">The engine&apos;s own servers</span>
            </button>
          </div>

          {fleetOpen && (
            <>
              <p className="px-2 pb-1 text-meta leading-snug text-text-muted">
                These are configured in the engine, not in PacketBench. Inheriting them means
                running whatever its configuration lists at the time — it cannot be granted
                server by server, and it applies only to sessions started in this run of the
                app. Where PacketBench has servers of its own allowed above, those are sent by
                name instead and this has no effect.
              </p>
              <label className="mx-2 mb-1 flex items-start gap-1.5 rounded-md border border-bg-border bg-bg-primary px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={inherit}
                  onChange={(event) => setInherit(event.target.checked)}
                  className="mt-px shrink-0 accent-accent-green"
                />
                <span className="min-w-0 flex-1 text-meta leading-snug text-text-secondary">
                  Let a session inherit the engine&apos;s configured servers
                </span>
              </label>
              {fleetStatus === "loading" && (
                <p className="px-2 py-1 text-meta text-text-faint">Asking the engine…</p>
              )}
              {fleetStatus === "unavailable" && (
                <p className="px-2 py-1 text-meta text-text-faint">
                  Could not reach the packetcode engine, so its own servers are unknown.
                </p>
              )}
              {fleetStatus === "ready" && fleet.length === 0 && (
                <p className="px-2 py-1 text-meta text-text-faint">
                  The engine reports no MCP servers of its own.
                </p>
              )}
              {fleet.map((row) => (
                <div
                  key={`${row.source}:${row.name}`}
                  className="mx-2 mb-1 rounded-md border border-bg-border bg-bg-primary px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-ui text-text-primary">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-meta text-text-faint">
                      {row.status} · {row.toolCount} tool{row.toolCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-meta text-text-muted" title={row.command}>
                    {row.command || "(command not disclosed)"}
                  </p>
                  {row.error && (
                    <p className="mt-0.5 text-meta leading-snug text-accent-red">{row.error}</p>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}
