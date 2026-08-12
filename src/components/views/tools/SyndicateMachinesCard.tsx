import { useState } from "react";
import { Cpu, KeyRound, Loader2, Plus, RefreshCw, ServerCog, Trash2 } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { useSyndicateStore } from "@/stores/syndicateStore";
import { useServerStore } from "@/stores/serverStore";
import type { SyndicateMachine } from "@/types/syndicate";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

function memoryLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown RAM";
  return `${Math.round(bytes / 1024 ** 3)} GB RAM`;
}

export function relayEndpointFromPairingPackage(input: string): string | undefined {
  try {
    const trimmed = input.trim();
    const json = trimmed.startsWith("syndicate-pair-v1:")
      ? atob(trimmed.slice("syndicate-pair-v1:".length).replace(/-/g, "+").replace(/_/g, "/"))
      : trimmed;
    const value = JSON.parse(json) as { relayEndpoint?: unknown };
    return typeof value.relayEndpoint === "string" && value.relayEndpoint.trim()
      ? value.relayEndpoint.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function SyndicateMachinesCard() {
  const machines = useSyndicateStore((state) => state.machines);
  const servers = useServerStore((state) => state.servers);
  const connectionErrors = useSyndicateStore((state) => state.connectionErrors);
  const pair = useSyndicateStore((state) => state.pair);
  const refresh = useSyndicateStore((state) => state.refresh);
  const revoke = useSyndicateStore((state) => state.revoke);
  const forgetOffline = useSyndicateStore((state) => state.forgetOffline);
  const [showPair, setShowPair] = useState(false);
  const [pairingPayload, setPairingPayload] = useState("");
  const [deviceName, setDeviceName] = useState(`${APP_NAME} controller`);
  const [serverConfigId, setServerConfigId] = useState("");
  const [relayEndpoint, setRelayEndpoint] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<SyndicateMachine | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function submitPair() {
    if (!pairingPayload.trim() || !deviceName.trim() || !serverConfigId) return;
    setBusyId("pair");
    setError(null);
    try {
      const machine = await pair(
        pairingPayload,
        deviceName,
        serverConfigId,
        // Native parsing and URL policy remain authoritative. Supplying no
        // override lets it use the Host-selected endpoint in the package.
        relayEndpoint.trim() || undefined,
      );
      setPairingPayload("");
      setShowPair(false);
      if (machine.grantStatus === "active") await refresh(machine.machineId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmRevoke(forgetOnly: boolean) {
    if (!pendingRevoke || busyId) return;
    setBusyId(pendingRevoke.machineId);
    setRevokeError(null);
    try {
      if (forgetOnly) await forgetOffline(pendingRevoke.machineId);
      else await revoke(pendingRevoke.machineId);
      setPendingRevoke(null);
    } catch (reason) {
      setRevokeError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
            <ServerCog size={12} className="text-accent-green" />
            Syndicate machines
          </h3>
          <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-text-muted">
            Pair a Linux execution host over a managed, host-key-pinned SSH tunnel. PacketRelay can
            then carry end-to-end encrypted controller traffic from anywhere. Device keys stay in the
            OS credential store; provider credentials remain on the server.
          </p>
          <p className="mt-1 text-[9px] text-text-muted">
            Transport: PacketRelay when configured, with the managed SSH forward as bootstrap and fallback.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowPair((value) => !value);
            setError(null);
          }}
          className="hover:bg-accent-green/10 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-green"
        >
          <Plus size={11} /> Pair machine
        </button>
      </div>

      {showPair && (
        <div className="mb-3 space-y-2 rounded border border-bg-border bg-bg-primary p-3">
          <p className="text-[10px] leading-relaxed text-text-muted">
            On the server, create a short-lived controller invite. Select its verified SSH server,
            paste the complete payload here, then approve this device in Syndicate's local browser UI.
          </p>
          <select
            value={serverConfigId}
            onChange={(event) => setServerConfigId(event.target.value)}
            aria-label="SSH server for Syndicate"
            className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent-green"
          >
            <option value="">Choose a verified SSH server…</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id} disabled={!server.hostFingerprint}>
                {server.name} · {server.username}@{server.host}
                {server.hostFingerprint ? "" : " · verify host key first"}
              </option>
            ))}
          </select>
          <input
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            aria-label="Controller device name"
            placeholder="Controller device name"
            className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent-green"
          />
          <input
            value={relayEndpoint}
            onChange={(event) => setRelayEndpoint(event.target.value)}
            aria-label="PacketRelay product-route endpoint"
            placeholder={relayEndpointFromPairingPackage(pairingPayload) ?? "Optional override: wss://relay.example/v1/product-route"}
            className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 font-mono text-[10px] text-text-primary outline-none focus:border-accent-green"
          />
          <p className="text-[9px] text-text-muted">
            The endpoint must be exact WSS /v1/product-route. Leave blank to use the Host-selected endpoint in the pairing package (or SSH-only when none is present).
          </p>
          <textarea
            value={pairingPayload}
            onChange={(event) => setPairingPayload(event.target.value)}
            aria-label="Syndicate pairing payload"
            placeholder="syndicate-pair-v1:…"
            rows={4}
            className="w-full resize-y rounded border border-bg-border bg-bg-secondary px-2 py-1.5 font-mono text-[10px] text-text-primary outline-none focus:border-accent-green"
          />
          {error && <p className="text-[10px] text-accent-red">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPair(false)}
              className="px-2 py-1 text-[10px] text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitPair()}
              disabled={
                !pairingPayload.trim() ||
                !deviceName.trim() ||
                !serverConfigId ||
                busyId === "pair"
              }
              className="border-accent-green/30 bg-accent-green/10 rounded border px-3 py-1 text-[10px] text-accent-green disabled:opacity-40"
            >
              {busyId === "pair" ? "Claiming…" : "Claim pairing invite"}
            </button>
          </div>
        </div>
      )}

      {machines.length === 0 ? (
        <div className="rounded border border-dashed border-bg-border py-7 text-center text-[10px] text-text-muted">
          No Syndicate machines paired.
        </div>
      ) : (
        <div className="space-y-2">
          {machines.map((machine) => {
            const snapshot = machine.cachedSnapshot;
            const connectionError = connectionErrors[machine.machineId];
            return (
              <div key={machine.machineId} className="rounded border border-bg-border bg-bg-primary p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-medium text-text-primary">
                        {machine.displayName}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] ${
                          connectionError
                            ? "bg-accent-red/10 text-accent-red"
                            : machine.grantStatus === "active"
                              ? "bg-accent-green/10 text-accent-green"
                              : "bg-accent-amber/10 text-accent-amber"
                        }`}
                      >
                        {connectionError ? "offline" : machine.grantStatus}
                      </span>
                      {snapshot && (
                        <span className="text-[9px] text-text-muted">
                          {snapshot.machine.os} · {snapshot.machine.architecture} ·{" "}
                          {snapshot.machine.logicalCpuCount} cores ·{" "}
                          {memoryLabel(snapshot.machine.totalMemoryBytes)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-text-muted">
                      <span>machine {machine.machineId}</span>
                      <span>device {machine.deviceId}</span>
                      <span>
                        SSH {servers.find((server) => server.id === machine.serverConfigId)?.name ?? machine.serverConfigId}
                      </span>
                      <span>127.0.0.1:{machine.localPort}</span>
                      <span>{machine.relayEndpoint ? "PacketRelay enabled" : "SSH only"}</span>
                    </div>
                    {connectionError && <p className="mt-1 text-[10px] text-accent-red">{connectionError}</p>}
                    {machine.grantStatus === "pending" && (
                      <p className="mt-1 text-[10px] text-accent-amber">
                        Pairing claim submitted. Approve this device in the server's local Syndicate UI,
                        then refresh.
                      </p>
                    )}
                    {machine.grantStatus === "active" &&
                      (!machine.scopes.includes("workspace.create") ||
                        !machine.scopes.includes("session.start") ||
                        !machine.scopes.includes("terminal.view")) && (
                        <p className="mt-1 text-[10px] text-accent-amber">
                          View-only grant: status and catalog browsing are available, but PacketADE
                          cannot launch terminal panes. Create a new Full control invite in Syndicate
                          and re-pair this device for execution.
                        </p>
                      )}
                    {snapshot && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {snapshot.agents.map((agent) => (
                          <span
                            key={agent.profileId}
                            className="flex items-center gap-1 rounded border border-bg-border px-1.5 py-0.5 text-[9px] text-text-secondary"
                          >
                            <Cpu size={9} /> {agent.displayName} {agent.version ?? ""} · {agent.state}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void refresh(machine.machineId).catch(() => {})}
                      disabled={busyId === machine.machineId}
                      className="p-1 text-text-muted hover:text-accent-green disabled:opacity-40"
                      title="Refresh capability and health"
                    >
                      {busyId === machine.machineId ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingRevoke(machine);
                        setRevokeError(null);
                      }}
                      className="p-1 text-text-muted hover:text-accent-red"
                      title="Revoke controller device"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                {machine.hostFingerprint && (
                  <div className="mt-2 flex items-center gap-1 text-[9px] text-text-muted">
                    <KeyRound size={9} /> SSH host fingerprint {machine.hostFingerprint}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-1 text-[9px] text-text-muted">
                  <KeyRound size={9} /> Syndicate machine fingerprint {machine.machineSigningFingerprint}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingRevoke && (
        <ConfirmDeleteModal
          title="Revoke Syndicate controller?"
          entityName={`${pendingRevoke.displayName} (${pendingRevoke.deviceId})`}
          description="will revoke this device grant on the Syndicate host and delete its private controller key from the OS credential store. Server workspaces and agent sessions are not deleted."
          warnings={revokeError ? [revokeError] : []}
          warningTitle={revokeError ? "Revocation did not complete" : undefined}
          confirmLabel={busyId === pendingRevoke.machineId ? "Revoking…" : "Revoke device"}
          onConfirm={() => void confirmRevoke(false)}
          onClose={() => {
            if (!busyId) setPendingRevoke(null);
          }}
        />
      )}
    </div>
  );
}
