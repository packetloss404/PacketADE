import { useEffect, useState } from "react";
import { Bot, Check, Eye, EyeOff, Plug, Trash2 } from "lucide-react";
import {
  deletePacketAgentToken,
  getPacketAgentTokenExists,
  setPacketAgentToken,
} from "@/lib/tauri";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import { PACKET_AGENT_CONTRACT_COMMIT, WORKER_PACKAGE_SCHEMA_VERSION } from "@/types/packet-agent";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { parseContractSummary, type ContractSummary } from "@/lib/packetAgentContract";
import { formatDateTime } from "@/lib/time";

export function PacketAgentSettingsCard() {
  const endpoint = usePacketAgentStore((state) => state.endpoint);
  const workspaceId = usePacketAgentStore((state) => state.workspaceId);
  const setConnection = usePacketAgentStore((state) => state.setConnection);
  const request = usePacketAgentStore((state) => state.request);
  const [draftEndpoint, setDraftEndpoint] = useState(endpoint);
  const [draftWorkspace, setDraftWorkspace] = useState(workspaceId);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [contract, setContract] = useState<ContractSummary | null>(null);
  const [pendingRemoveToken, setPendingRemoveToken] = useState(false);

  useEffect(() => {
    void getPacketAgentTokenExists()
      .then(setHasToken)
      .catch((error) => setNotice(String(error)));
  }, []);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      setConnection(draftEndpoint, draftWorkspace);
      if (token.trim()) {
        await setPacketAgentToken(token);
        setToken("");
        setHasToken(true);
      }
      setNotice("PacketAgent connection saved.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice(null);
    setContract(null);
    try {
      setConnection(draftEndpoint, draftWorkspace);
      const health = await request("health");
      try {
        const response = await request("contract");
        setContract(parseContractSummary(response.body));
        setNotice(`PacketAgent responded successfully (HTTP ${health.status}).`);
      } catch (contractError) {
        // The contract probe is informational: a healthy but older server (or
        // a credential without inspect rights) still counts as reachable.
        setContract({
          schemaMatches: false,
          operations: [],
          allowedOperations: [],
          probeWarning: String(contractError),
        });
        setNotice(`PacketAgent responded successfully (HTTP ${health.status}).`);
      }
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeToken() {
    setBusy(true);
    try {
      await deletePacketAgentToken();
      setHasToken(false);
      setToken("");
      setNotice("PacketAgent token removed from the credential store.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-start gap-2">
        <Bot size={14} className="mt-0.5 text-accent-green" />
        <div>
          <h3 className="text-xs font-semibold text-text-primary">PacketAgent handoff</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Deploy a Flight as an always-on worker. PacketAgent owns execution; this app keeps only
            deployment references and event cursors.
          </p>
        </div>
      </div>

      <label className="mb-1 block text-[10px] font-medium text-text-secondary">Endpoint</label>
      <input
        value={draftEndpoint}
        onChange={(event) => setDraftEndpoint(event.target.value)}
        placeholder="https://agent.example.com"
        className="mb-2 w-full rounded border border-bg-border bg-bg-primary px-2.5 py-2 font-mono text-[11px] text-text-primary outline-none focus:border-accent-green"
      />
      <label className="mb-1 block text-[10px] font-medium text-text-secondary">
        PacketAgent workspace ID
      </label>
      <input
        value={draftWorkspace}
        onChange={(event) => setDraftWorkspace(event.target.value)}
        placeholder="workspace-id"
        className="mb-2 w-full rounded border border-bg-border bg-bg-primary px-2.5 py-2 font-mono text-[11px] text-text-primary outline-none focus:border-accent-green"
      />
      <label className="mb-1 block text-[10px] font-medium text-text-secondary">
        Bearer token {hasToken && <span className="text-accent-green">· stored securely</span>}
      </label>
      <div className="mb-3 flex gap-1.5">
        <div className="relative flex-1">
          <input
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={hasToken ? "Leave blank to keep current token" : "Paste service token"}
            className="w-full rounded border border-bg-border bg-bg-primary px-2.5 py-2 pr-8 font-mono text-[11px] text-text-primary outline-none focus:border-accent-green"
          />
          <button
            type="button"
            onClick={() => setShowToken((value) => !value)}
            className="absolute right-2 top-2 text-text-muted hover:text-text-primary"
            aria-label={showToken ? "Hide token" : "Show token"}
          >
            {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
        {hasToken && (
          <button
            type="button"
            onClick={() => setPendingRemoveToken(true)}
            disabled={busy}
            className="rounded border border-accent-red/30 px-2 text-accent-red hover:bg-accent-red/10 disabled:opacity-50"
            title="Remove stored token"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !draftEndpoint.trim()}
          className="inline-flex items-center gap-1.5 rounded bg-accent-green px-3 py-2 text-[11px] font-medium text-bg-primary disabled:opacity-50"
        >
          <Check size={12} />
          Save
        </button>
        <button
          onClick={() => void test()}
          disabled={busy || !draftEndpoint.trim()}
          className="inline-flex items-center gap-1.5 rounded border border-bg-border px-3 py-2 text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
        >
          <Plug size={12} />
          Test connection
        </button>
      </div>
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-text-secondary">{notice}</p>}
      {contract && (
        <div className="mt-2 rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[10px] leading-relaxed">
          {contract.probeWarning ? (
            <p className="text-accent-amber">
              Contract probe unavailable — server may predate the contract route.{" "}
              <span className="font-mono text-[9px]">{contract.probeWarning}</span>
            </p>
          ) : (
            <>
              <p className={contract.schemaMatches ? "text-accent-green" : "text-accent-amber"}>
                {contract.schemaMatches
                  ? `Schema ${contract.schemaVersion} matches this app.`
                  : `Schema mismatch: server speaks ${contract.schemaVersion ?? "an unknown version"}, this app emits ${WORKER_PACKAGE_SCHEMA_VERSION}. Proceed with caution.`}
              </p>
              {contract.allowedOperations.length > 0 && (
                <p className="mt-1 text-text-secondary">
                  Token operations: {contract.allowedOperations.join(", ")}
                </p>
              )}
              {contract.operations.length > 0 && contract.allowedOperations.length === 0 && (
                <p className="mt-1 text-text-secondary">
                  Server operations: {contract.operations.join(", ")}
                </p>
              )}
              {contract.credentialExpiresAt && (
                <p className="mt-1 text-text-muted">
                  Token expires {formatDateTime(contract.credentialExpiresAt)}
                  {contract.credentialDisplayName ? ` · ${contract.credentialDisplayName}` : ""}
                </p>
              )}
            </>
          )}
        </div>
      )}
      <p className="mt-3 font-mono text-[9px] text-text-muted">
        W9 contract {PACKET_AGENT_CONTRACT_COMMIT.slice(0, 8)} · HTTPS required outside loopback
      </p>

      {pendingRemoveToken && (
        <ConfirmDeleteModal
          title="Remove PacketAgent token?"
          description="The stored token is deleted from the OS credential store. PacketAgent requests will fail until a new token is saved."
          confirmLabel="Remove token"
          onConfirm={() => {
            void removeToken();
            setPendingRemoveToken(false);
          }}
          onClose={() => setPendingRemoveToken(false)}
        />
      )}
    </div>
  );
}
