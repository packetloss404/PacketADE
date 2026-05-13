import { useState } from "react";
import { Server, ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { sshFetchFingerprint, sshPinHost, type HostKey } from "@/lib/tauri";
import type { ServerConfig } from "@/types/server";

interface ServerFormModalProps {
  onClose: () => void;
  onSubmit: (config: Omit<ServerConfig, "id" | "installedAgents">) => void;
  initial?: ServerConfig;
}

type VerifyPhase = "idle" | "fetching" | "review" | "pinned" | "error";

export function ServerFormModal({ onClose, onSubmit, initial }: ServerFormModalProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authMethod, setAuthMethod] = useState<"agent" | "key" | "password">(
    initial?.authMethod ?? "agent",
  );
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [remotePath, setRemotePath] = useState(initial?.remotePath ?? "");

  // Host-key pinning state
  const [hostFingerprint, setHostFingerprint] = useState<string | undefined>(
    initial?.hostFingerprint,
  );
  const [verifyPhase, setVerifyPhase] = useState<VerifyPhase>(
    initial?.hostFingerprint ? "pinned" : "idle",
  );
  const [discoveredKeys, setDiscoveredKeys] = useState<HostKey[]>([]);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const trimmedHost = host.trim();
  // First-time / changed-host: require explicit verification before save.
  const hostChangedFromInitial = !!initial && initial.host !== trimmedHost;
  const needsVerification =
    !!trimmedHost && (!hostFingerprint || hostChangedFromInitial) && verifyPhase !== "pinned";

  async function handleVerify() {
    if (!trimmedHost) return;
    setVerifyError(null);
    setVerifyPhase("fetching");
    try {
      const keys = await sshFetchFingerprint(trimmedHost, port);
      if (!keys.length) {
        setVerifyError("No host keys returned by ssh-keyscan.");
        setVerifyPhase("error");
        return;
      }
      setDiscoveredKeys(keys);
      setVerifyPhase("review");
    } catch (e) {
      setVerifyError(typeof e === "string" ? e : (e as Error)?.message ?? "Lookup failed");
      setVerifyPhase("error");
    }
  }

  async function handleTrust(key: HostKey) {
    try {
      await sshPinHost(trimmedHost, port, key.key);
      setHostFingerprint(key.fingerprint);
      setVerifyPhase("pinned");
    } catch (e) {
      setVerifyError(typeof e === "string" ? e : (e as Error)?.message ?? "Pin failed");
      setVerifyPhase("error");
    }
  }

  function handleSubmit() {
    if (!name.trim() || !host.trim() || !username.trim()) return;
    if (needsVerification) return; // gate save until pinned
    onSubmit({
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod,
      keyPath: authMethod === "key" ? keyPath.trim() || undefined : undefined,
      remotePath: remotePath.trim() || undefined,
      hostFingerprint,
    });
    onClose();
  }

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={onClose}
        className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={handleSubmit}
        disabled={
          !name.trim() ||
          !host.trim() ||
          !username.trim() ||
          needsVerification
        }
        title={needsVerification ? "Verify the host key before saving" : undefined}
        className="px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40"
      >
        {initial ? "Save" : "Add Server"}
      </button>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      title={initial ? "Edit Server" : "Add Server"}
      icon={<Server size={14} className="text-accent-blue" />}
      width="w-[480px]"
      footer={footer}
    >
      <div className="p-4 space-y-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Server"
            className="bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-secondary">Host</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100 or dev.example.com"
              className="bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-secondary">Port</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 22)}
              className="bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ubuntu"
            className="bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">Authentication</label>
          <div className="flex rounded-lg border border-bg-border overflow-hidden">
            {(["agent", "key", "password"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setAuthMethod(m)}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors border-r last:border-r-0 border-bg-border ${
                  authMethod === m
                    ? "bg-accent-green/15 text-accent-green"
                    : "bg-bg-primary text-text-muted hover:text-text-secondary"
                }`}
              >
                {m === "agent" ? "SSH Agent" : m === "key" ? "Key File" : "Password"}
              </button>
            ))}
          </div>
        </div>

        {authMethod === "key" && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-secondary">Private Key Path</label>
            <input
              type="text"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_rsa"
              className="bg-bg-primary text-xs text-text-primary font-mono px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">
            Default Remote Path <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/home/ubuntu/projects/my-app"
            className="bg-bg-primary text-xs text-text-primary font-mono px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
          />
        </div>

        {/* Host-key verification block. Required on first save and when
            the host field changes; pins the SHA256 fingerprint into the
            app-managed known_hosts file so later connects use
            StrictHostKeyChecking=yes instead of TOFU. */}
        <div className="flex flex-col gap-2 rounded border border-bg-border bg-bg-primary p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
              <ShieldCheck size={12} className="text-accent-green" />
              Verify host key
            </div>
            {verifyPhase === "pinned" && hostFingerprint && (
              <span className="text-[10px] text-accent-green">Pinned</span>
            )}
          </div>

          {verifyPhase === "pinned" && hostFingerprint && !hostChangedFromInitial && (
            <div className="text-[10px] font-mono text-text-muted break-all">
              {hostFingerprint}
            </div>
          )}

          {(verifyPhase === "idle" || verifyPhase === "error" || hostChangedFromInitial) && (
            <button
              type="button"
              disabled={!trimmedHost || verifyPhase === "fetching"}
              onClick={handleVerify}
              className="self-start px-2.5 py-1 text-[11px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded font-medium hover:bg-accent-blue/25 transition-colors disabled:opacity-40"
            >
              {hostChangedFromInitial && verifyPhase !== "fetching"
                ? "Re-verify host key"
                : "Fetch host key"}
            </button>
          )}

          {verifyPhase === "fetching" && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              Running ssh-keyscan…
            </div>
          )}

          {verifyPhase === "review" && discoveredKeys.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-1.5 text-[10px] text-accent-yellow">
                <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                <span>
                  If you don't recognise this fingerprint, do <strong>not</strong>{" "}
                  proceed — verify it out-of-band with the server operator.
                </span>
              </div>
              {discoveredKeys.map((k) => (
                <div
                  key={k.fingerprint}
                  className="flex flex-col gap-1 rounded border border-bg-border p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-text-muted">
                      {k.algorithm}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleTrust(k)}
                      className="px-2 py-0.5 text-[10px] bg-accent-green/15 text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors"
                    >
                      Trust this host
                    </button>
                  </div>
                  <div className="text-[10px] font-mono text-text-primary break-all">
                    {k.fingerprint}
                  </div>
                </div>
              ))}
            </div>
          )}

          {verifyError && (
            <div className="text-[10px] text-accent-red">{verifyError}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
