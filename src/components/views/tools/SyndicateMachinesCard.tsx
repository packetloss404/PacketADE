import { useMemo, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  Cpu,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { useSyndicateStore } from "@/stores/syndicateStore";
import { useServerStore } from "@/stores/serverStore";
import type { SyndicateMachine } from "@/types/syndicate";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { Modal } from "@/components/ui/Modal";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  configuredTransportLabel,
  hasSyndicateDisableImpact,
  SYNDICATE_SCOPE_DETAILS,
  syndicateAuthoritySummary,
  syndicateDisableImpact,
  transportLabel,
  unknownSyndicateScopes,
} from "@/lib/syndicateMachineStatus";
import {
  getSyndicateTransportSnapshot,
  syndicateTransportObservation,
  subscribeSyndicateTransportSnapshot,
} from "@/lib/syndicateTransportStatus";

function memoryLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown RAM";
  return `${Math.round(bytes / 1024 ** 3)} GB RAM`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function observedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function relayEndpointFromPairingPackage(input: string): string | undefined {
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
  const enabled = useSyndicateStore((state) => state.enabled);
  const nativeReady = useSyndicateStore((state) => state.nativeReady);
  const nativeSyncError = useSyndicateStore((state) => state.nativeSyncError);
  const setEnabled = useSyndicateStore((state) => state.setEnabled);
  const syncNative = useSyndicateStore((state) => state.syncNative);
  const machines = useSyndicateStore((state) => state.machines);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
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
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const transportSnapshot = useSyncExternalStore(
    subscribeSyndicateTransportSnapshot,
    getSyndicateTransportSnapshot,
    getSyndicateTransportSnapshot,
  );
  const disableImpact = useMemo(() => syndicateDisableImpact(workspaces), [workspaces]);

  async function setIntegration(next: boolean) {
    if (toggleBusy) return;
    setToggleBusy(true);
    setToggleError(null);
    try {
      await setEnabled(next);
      if (!next) {
        setShowPair(false);
        setPendingRevoke(null);
      }
      setConfirmDisable(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setToggleError(
        !next && !useSyndicateStore.getState().enabled
          ? `Syndicate is disabled and new controller activity is blocked, but ${APP_NAME} could not confirm every managed SSH tunnel closed: ${detail}. Close ${APP_NAME} or turn the integration on and off again to retry cleanup.`
          : detail,
      );
    } finally {
      setToggleBusy(false);
    }
  }

  function toggleIntegration() {
    if (!enabled) {
      void setIntegration(true);
      return;
    }
    if (hasSyndicateDisableImpact(disableImpact)) {
      setToggleError(null);
      setConfirmDisable(true);
      return;
    }
    void setIntegration(false);
  }

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
            then carry end-to-end encrypted controller traffic from anywhere. Device keys stay in
            the OS credential store; provider credentials remain on the server.
          </p>
          <p className="mt-1 text-[9px] text-text-muted">
            Transport: managed SSH bootstraps pairing and relay grants. After PacketRelay is active,
            failed relay requests are surfaced and never retried automatically over SSH.
          </p>
        </div>
        {enabled && nativeReady && (
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
        )}
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 rounded border border-bg-border bg-bg-primary px-3 py-2.5">
        <div>
          <p className="text-[11px] font-medium text-text-primary">Enable Syndicate integration</p>
          <p
            id="syndicate-integration-consequences"
            className="mt-0.5 max-w-2xl text-[9px] leading-relaxed text-text-muted"
          >
            Turning this off closes {APP_NAME}-managed SSH tunnels, removes Syndicate from new
            Workspace targets, and pauses remote panes. Pairings and server-side sessions are kept.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-[9px] ${enabled ? "text-accent-green" : "text-text-muted"}`}>
            {toggleBusy ? "Updating…" : enabled ? "Enabled" : "Disabled"}
          </span>
          <button
            type="button"
            role="switch"
            aria-label="Syndicate integration"
            aria-checked={enabled}
            aria-describedby="syndicate-integration-consequences"
            disabled={toggleBusy || !nativeReady}
            onClick={toggleIntegration}
            className={`relative h-4 w-7 rounded-full transition-colors disabled:opacity-50 ${
              enabled ? "bg-accent-green" : "bg-bg-elevated"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                enabled ? "translate-x-3.5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {toggleError && (
        <p role="alert" className="mb-3 text-[10px] text-accent-red">
          {toggleError}
        </p>
      )}

      {!nativeReady && (
        <div className="mb-3 flex items-center justify-between gap-3 text-[10px] text-accent-amber">
          <p role="status">
            {nativeSyncError
              ? `Syndicate controller access is blocked because the native setting could not be applied: ${nativeSyncError}`
              : "Applying the saved Syndicate setting…"}
          </p>
          {nativeSyncError && (
            <button
              type="button"
              onClick={() => void syncNative().catch(() => {})}
              className="border-accent-amber/30 hover:bg-accent-amber/10 shrink-0 rounded border px-2 py-1"
            >
              Retry native sync
            </button>
          )}
        </div>
      )}

      {nativeReady && nativeSyncError && !toggleError && (
        <p role="alert" className="mb-3 text-[10px] text-accent-amber">
          Syndicate controller activity is blocked, but {APP_NAME} could not confirm every managed
          SSH tunnel closed: {nativeSyncError}. Close {APP_NAME} or turn the integration on and off
          again to retry cleanup.
        </p>
      )}

      {!enabled && machines.length === 0 && (
        <div className="rounded border border-dashed border-bg-border px-3 py-7 text-center text-[10px] text-text-muted">
          Syndicate is disabled. No machines are paired; all saved remote Workspace data is
          retained.
        </div>
      )}

      {enabled && showPair && (
        <div className="mb-3 space-y-2 rounded border border-bg-border bg-bg-primary p-3">
          <p className="text-[10px] leading-relaxed text-text-muted">
            On the server, create a short-lived controller invite. Select its verified SSH server,
            paste the complete payload here, then approve this device in Syndicate's local browser
            UI.
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
            placeholder={
              relayEndpointFromPairingPackage(pairingPayload) ??
              "Optional override: wss://relay.example/v1/product-route"
            }
            className="w-full rounded border border-bg-border bg-bg-secondary px-2 py-1.5 font-mono text-[10px] text-text-primary outline-none focus:border-accent-green"
          />
          <p className="text-[9px] text-text-muted">
            The endpoint must be exact WSS /v1/product-route. Leave blank to use the Host-selected
            endpoint in the pairing package (or SSH-only when none is present).
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
                !pairingPayload.trim() || !deviceName.trim() || !serverConfigId || busyId === "pair"
              }
              className="border-accent-green/30 bg-accent-green/10 rounded border px-3 py-1 text-[10px] text-accent-green disabled:opacity-40"
            >
              {busyId === "pair" ? "Claiming…" : "Claim pairing invite"}
            </button>
          </div>
        </div>
      )}

      {machines.length === 0 ? (
        enabled ? (
          <div className="rounded border border-dashed border-bg-border py-7 text-center text-[10px] text-text-muted">
            No Syndicate machines paired.
          </div>
        ) : null
      ) : (
        <div className="space-y-2">
          {machines.map((machine) => {
            const snapshot = machine.cachedSnapshot;
            const connectionError = enabled ? connectionErrors[machine.machineId] : undefined;
            const transportObservation = syndicateTransportObservation(
              transportSnapshot,
              machine.machineId,
              machine.deviceId,
            );
            const authority = syndicateAuthoritySummary(machine.grantStatus, machine.scopes);
            const unknownScopes = unknownSyndicateScopes(machine.scopes);
            const authorityIsCurrent = machine.grantStatus === "active";
            const effectiveScopes = authorityIsCurrent ? machine.scopes : [];
            const canLaunch = ["workspace.create", "session.start", "terminal.view"].every(
              (scope) => effectiveScopes.includes(scope),
            );
            return (
              <div
                key={machine.machineId}
                aria-disabled={!enabled || !nativeReady}
                className="rounded border border-bg-border bg-bg-primary p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-medium text-text-primary">
                        {machine.displayName}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] ${
                          !enabled || !nativeReady
                            ? "bg-bg-elevated text-text-secondary"
                            : connectionError
                              ? "bg-accent-red/10 text-accent-red"
                              : machine.grantStatus === "active"
                                ? "bg-accent-green/10 text-accent-green"
                                : "bg-accent-amber/10 text-accent-amber"
                        }`}
                      >
                        {!enabled || !nativeReady
                          ? !enabled
                            ? "paused by setting"
                            : "blocked by native sync"
                          : connectionError
                            ? "offline"
                            : machine.grantStatus}
                      </span>
                      {snapshot && (
                        <span className="text-[9px] text-text-muted">
                          {!enabled || !nativeReady ? "Last known · " : ""}
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
                        SSH{" "}
                        {servers.find((server) => server.id === machine.serverConfigId)?.name ??
                          machine.serverConfigId}
                      </span>
                      <span>127.0.0.1:{machine.localPort}</span>
                    </div>
                    <div className="mt-2 grid gap-1 text-[9px] text-text-secondary sm:grid-cols-2">
                      <p>
                        <span className="text-text-muted">Configured: </span>
                        {configuredTransportLabel(machine.relayEndpoint)}
                      </p>
                      <p>
                        <span className="text-text-muted">Last successful path: </span>
                        {transportObservation
                          ? `${transportLabel(transportObservation.transport)} · ${observedTime(transportObservation.observedAt)}`
                          : "Not observed yet"}
                      </p>
                    </div>
                    {machine.relayEndpoint && transportObservation?.transport === "ssh-forward" && (
                      <p className="mt-1 text-[9px] text-text-muted">
                        Managed SSH was used to bootstrap pairing or obtain the verified PacketRelay
                        grant.
                      </p>
                    )}
                    {connectionError && (
                      <p className="mt-1 text-[10px] text-accent-red">{connectionError}</p>
                    )}
                    {machine.grantStatus === "pending" && (
                      <p className="mt-1 text-[10px] text-accent-amber">
                        Pairing claim submitted. Approve this device in the server's local Syndicate
                        UI, then refresh.
                      </p>
                    )}
                    {machine.grantStatus === "active" && !canLaunch && (
                      <p className="mt-1 text-[10px] text-accent-amber">
                        This grant cannot launch {APP_NAME} terminal panes because one or more
                        launch permissions are missing. Its exact authority is listed below.
                      </p>
                    )}
                    {snapshot && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {snapshot.agents.map((agent) => (
                          <span
                            key={agent.profileId}
                            className="flex items-center gap-1 rounded border border-bg-border px-1.5 py-0.5 text-[9px] text-text-secondary"
                          >
                            <Cpu size={9} /> {agent.displayName} {agent.version ?? ""} ·{" "}
                            {agent.state}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void refresh(machine.machineId).catch(() => {})}
                      disabled={!enabled || !nativeReady || busyId === machine.machineId}
                      aria-label={`Refresh ${machine.displayName}`}
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
                      disabled={!enabled || !nativeReady || busyId === machine.machineId}
                      aria-label={`Revoke ${machine.displayName}`}
                      className="p-1 text-text-muted hover:text-accent-red disabled:opacity-40"
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
                  <KeyRound size={9} /> Syndicate machine fingerprint{" "}
                  {machine.machineSigningFingerprint}
                </div>
                <div className="mt-3 border-t border-bg-border pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-1 text-[10px] font-medium text-text-primary">
                      <ShieldCheck size={10} /> {authority}
                    </p>
                    <p className="text-[9px] text-text-muted">
                      {machine.grantStatus === "pending"
                        ? "Requested authority"
                        : machine.grantStatus === "revoked" || machine.grantStatus === "expired"
                          ? "Historical authority"
                          : !enabled || !nativeReady || connectionError
                            ? "Last verified authority"
                            : "Granted authority"}
                      {machine.lastConnectedAt ? ` · ${observedTime(machine.lastConnectedAt)}` : ""}
                    </p>
                  </div>
                  <ul
                    aria-label={`Permissions for ${machine.displayName}`}
                    className="mt-2 grid gap-1 sm:grid-cols-2"
                  >
                    {SYNDICATE_SCOPE_DETAILS.map(({ scope, label, group }) => {
                      const granted = effectiveScopes.includes(scope);
                      const retained = !authorityIsCurrent && machine.scopes.includes(scope);
                      const retainedLabel =
                        machine.grantStatus === "pending" ? "Requested" : "Previously granted";
                      return (
                        <li
                          key={scope}
                          className="flex items-center justify-between gap-2 rounded border border-bg-border px-2 py-1 text-[9px]"
                        >
                          <span className="text-text-secondary">
                            {label} · {group}
                          </span>
                          <span
                            className={
                              granted
                                ? "text-accent-green"
                                : retained
                                  ? "text-accent-amber"
                                  : "text-text-muted"
                            }
                          >
                            {granted ? "Granted" : retained ? retainedLabel : "Not granted"}
                          </span>
                        </li>
                      );
                    })}
                    {unknownScopes.map((scope) => (
                      <li
                        key={scope}
                        className="flex items-center justify-between gap-2 rounded border border-bg-border px-2 py-1 text-[9px]"
                      >
                        <span className="font-mono text-text-secondary">
                          Unknown permission · {scope}
                        </span>
                        <span className="text-accent-amber">
                          {authorityIsCurrent
                            ? "Granted"
                            : machine.grantStatus === "pending"
                              ? "Requested"
                              : "Previously granted"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {effectiveScopes.includes("terminal.input") && (
                    <p
                      role="note"
                      className="border-accent-amber/30 bg-accent-amber/10 mt-2 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[9px] text-accent-amber"
                    >
                      <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                      Terminal input is granted. It can execute code with the Syndicate Linux
                      user&apos;s authority.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmDisable && enabled && (
        <Modal
          title="Disable Syndicate integration?"
          width="w-[440px]"
          closeDisabled={toggleBusy}
          onClose={() => {
            if (!toggleBusy) setConfirmDisable(false);
          }}
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={toggleBusy}
                onClick={() => setConfirmDisable(false)}
                className="rounded px-3 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
              >
                Keep enabled
              </button>
              <button
                type="button"
                disabled={toggleBusy}
                onClick={() => void setIntegration(false)}
                className="bg-accent-amber/15 hover:bg-accent-amber/25 rounded px-3 py-1.5 text-[10px] font-medium text-accent-amber disabled:opacity-40"
              >
                {toggleBusy ? "Disabling…" : "Disable integration"}
              </button>
            </div>
          }
        >
          <div className="space-y-3 px-5 py-4 text-[11px] text-text-secondary">
            <p>
              {APP_NAME} will stop all Syndicate controller activity and close its managed SSH
              forwards. Pairings, Workspace data, pane identities, cursors, and Host sessions are
              retained.
            </p>
            <div
              role="alert"
              className="border-accent-amber/30 bg-accent-amber/10 rounded border px-3 py-2"
            >
              <p className="font-medium text-accent-amber">
                This will pause remote work in {APP_NAME}
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px]">
                <li>
                  {countLabel(disableImpact.activeWorkspaces, "active Syndicate Workspace")} will
                  become read-only.
                </li>
                <li>{countLabel(disableImpact.activePanes, "remote terminal pane")} will pause.</li>
                <li>
                  {countLabel(disableImpact.knownHostSessions, "known Host session")} may continue
                  running on the server.
                </li>
              </ul>
            </div>
            {toggleError && <p className="text-[10px] text-accent-red">{toggleError}</p>}
          </div>
        </Modal>
      )}

      {enabled && pendingRevoke && (
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
