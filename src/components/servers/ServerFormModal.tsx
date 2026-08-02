import { useEffect, useState } from "react";
import { Server, ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  getSshPasswordExists,
  sshCheckRemotePath,
  sshFetchFingerprint,
  sshPinHost,
  type HostKey,
} from "@/lib/tauri";
import { generateId } from "@/lib/storage";
import { isSafeKeyPath, UNSAFE_KEYPATH_MESSAGE } from "@/lib/sshKeyPath";
import type { ServerConfig } from "@/types/server";

interface ServerFormModalProps {
  onClose: () => void;
  onSubmit: (submission: ServerFormSubmission) => Promise<void>;
  initial?: ServerConfig;
}

export interface ServerFormSubmission {
  serverId: string;
  config: Omit<ServerConfig, "id" | "installedAgents">;
  passwordAction: { kind: "keep" } | { kind: "set"; password: string } | { kind: "delete" };
}

type VerifyPhase = "idle" | "fetching" | "review" | "pinned" | "error";

export function ServerFormModal({ onClose, onSubmit, initial }: ServerFormModalProps) {
  const [serverId] = useState(() => initial?.id ?? generateId("srv"));
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authMethod, setAuthMethod] = useState<"agent" | "key" | "password">(
    initial?.authMethod ?? "agent",
  );
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [remotePath, setRemotePath] = useState(initial?.remotePath ?? "");
  const [password, setPassword] = useState("");
  const [passwordLookup, setPasswordLookup] = useState<"checking" | "stored" | "missing" | "error">(
    initial ? "checking" : "missing",
  );
  const [credentialAccessError, setCredentialAccessError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "passed" | "failed">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!initial) return;
    void getSshPasswordExists(initial.id)
      .then((exists) => {
        if (!cancelled) setPasswordLookup(exists ? "stored" : "missing");
      })
      .catch((error) => {
        if (!cancelled) {
          setPasswordLookup("error");
          setCredentialAccessError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initial]);

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

  function invalidateConnectionTest() {
    setTestStatus("idle");
    setTestMessage(null);
  }

  function invalidatePinnedEndpoint() {
    setHostFingerprint(undefined);
    setVerifyPhase("idle");
    setVerifyError(null);
    setDiscoveredKeys([]);
    invalidateConnectionTest();
  }

  async function handleVerify() {
    if (!trimmedHost) return;
    setVerifyError(null);
    invalidateConnectionTest();
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
      setVerifyError(typeof e === "string" ? e : ((e as Error)?.message ?? "Lookup failed"));
      setVerifyPhase("error");
    }
  }

  async function handleTrust(key: HostKey) {
    try {
      await sshPinHost(trimmedHost, port, key.key);
      setHostFingerprint(key.fingerprint);
      setVerifyPhase("pinned");
      invalidateConnectionTest();
    } catch (e) {
      setVerifyError(typeof e === "string" ? e : ((e as Error)?.message ?? "Pin failed"));
      setVerifyPhase("error");
    }
  }

  // S2: reject key paths with control/shell-special bytes before they reach argv.
  const keyPathInvalid = authMethod === "key" && !isSafeKeyPath(keyPath.trim());

  const passwordRequired =
    authMethod === "password" &&
    password.length === 0 &&
    !(initial?.authMethod === "password" && passwordLookup === "stored");

  async function handleTestConnection() {
    if (!hostFingerprint || passwordRequired || keyPathInvalid) return;
    setTestStatus("testing");
    setTestMessage(null);
    try {
      const result = await sshCheckRemotePath({
        targetId: initial ? serverId : null,
        host: trimmedHost,
        port,
        user: username.trim(),
        authMethod,
        keyPath: authMethod === "key" ? keyPath.trim() || null : null,
        password: authMethod === "password" ? password || null : null,
        hostFingerprint,
        remotePath: remotePath.trim() || ".",
      });
      if (!result.exists || !result.isDirectory) {
        throw new Error(
          "Authentication succeeded, but the configured remote path is not a directory.",
        );
      }
      setTestStatus("passed");
      setTestMessage(
        result.isGitRepo
          ? "Connected. The remote path is a Git repository."
          : "Connected. The remote path is reachable.",
      );
    } catch (error) {
      setTestStatus("failed");
      setTestMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSubmit() {
    if (!name.trim() || !host.trim() || !username.trim()) return;
    if (needsVerification) return; // gate save until pinned
    if (keyPathInvalid) return;
    if (passwordRequired) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await onSubmit({
        serverId,
        config: {
          name: name.trim(),
          host: host.trim(),
          port,
          username: username.trim(),
          authMethod,
          keyPath: authMethod === "key" ? keyPath.trim() || undefined : undefined,
          remotePath: remotePath.trim() || undefined,
          hostFingerprint,
        },
        passwordAction:
          authMethod === "password" && password
            ? { kind: "set", password }
            : initial?.authMethod === "password" && authMethod !== "password"
              ? { kind: "delete" }
              : { kind: "keep" },
      });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={onClose}
        className="px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
      >
        Cancel
      </button>
      <button
        onClick={() => void handleSubmit()}
        disabled={
          saving ||
          !name.trim() ||
          !host.trim() ||
          !username.trim() ||
          needsVerification ||
          keyPathInvalid ||
          passwordRequired
        }
        title={
          needsVerification
            ? "Verify the host key before saving"
            : keyPathInvalid
              ? UNSAFE_KEYPATH_MESSAGE
              : undefined
        }
        className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 rounded border px-4 py-1.5 text-xs font-medium text-accent-green transition-colors disabled:opacity-40"
      >
        {saving ? "Saving…" : initial ? "Save" : "Add Server"}
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
      <div className="space-y-3 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Server"
            className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-secondary">Host</label>
            <input
              type="text"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                invalidatePinnedEndpoint();
              }}
              placeholder="192.168.1.100 or dev.example.com"
              className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-secondary">Port</label>
            <input
              type="number"
              value={port}
              onChange={(e) => {
                setPort(Number(e.target.value) || 22);
                invalidatePinnedEndpoint();
              }}
              className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              invalidateConnectionTest();
            }}
            placeholder="ubuntu"
            className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">Authentication</label>
          <div className="flex overflow-hidden rounded-lg border border-bg-border">
            {(["agent", "key", "password"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setAuthMethod(m);
                  invalidateConnectionTest();
                }}
                className={`flex-1 border-r border-bg-border py-1.5 text-xs font-medium transition-colors last:border-r-0 ${
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
              onChange={(e) => {
                setKeyPath(e.target.value);
                invalidateConnectionTest();
              }}
              placeholder="~/.ssh/id_rsa"
              aria-invalid={keyPathInvalid}
              aria-describedby={keyPathInvalid ? "keypath-error" : undefined}
              className={`rounded border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary outline-none ${
                keyPathInvalid
                  ? "border-accent-red/60 focus:border-accent-red"
                  : "focus:border-accent-green/50 border-bg-border"
              }`}
            />
            {keyPathInvalid && (
              <p id="keypath-error" className="text-[10px] text-accent-red">
                {UNSAFE_KEYPATH_MESSAGE}
              </p>
            )}
          </div>
        )}

        {authMethod === "password" && (
          <div className="flex flex-col gap-1">
            <label
              htmlFor="server-password"
              className="text-[11px] font-medium text-text-secondary"
            >
              Password
            </label>
            <input
              id="server-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setSubmitError(null);
                invalidateConnectionTest();
              }}
              autoComplete="new-password"
              placeholder={
                passwordLookup === "stored"
                  ? "Stored in OS credential manager"
                  : passwordLookup === "checking"
                    ? "Checking OS credential manager…"
                    : "Required"
              }
              aria-invalid={passwordRequired}
              className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none"
            />
            <p className="text-[10px] text-text-muted">
              Stored only in the OS credential manager. Leave blank to keep the saved password.
            </p>
            {credentialAccessError && (
              <p role="alert" className="text-[10px] text-accent-red">
                Could not access the saved credential: {credentialAccessError}. Enter a password to
                replace it, or retry after unlocking the OS credential manager.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-secondary">
            Default Remote Path <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            type="text"
            value={remotePath}
            onChange={(e) => {
              setRemotePath(e.target.value);
              invalidateConnectionTest();
            }}
            placeholder="/home/ubuntu/projects/my-app"
            className="focus:border-accent-green/50 rounded border border-bg-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary outline-none"
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
            <div className="break-all font-mono text-[10px] text-text-muted">{hostFingerprint}</div>
          )}

          {(verifyPhase === "idle" || verifyPhase === "error" || hostChangedFromInitial) && (
            <button
              type="button"
              disabled={!trimmedHost || verifyPhase === "fetching"}
              onClick={handleVerify}
              className="bg-accent-blue/15 border-accent-blue/30 hover:bg-accent-blue/25 self-start rounded border px-2.5 py-1 text-[11px] font-medium text-accent-blue transition-colors disabled:opacity-40"
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
              <div className="text-accent-yellow flex items-start gap-1.5 text-[10px]">
                <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                <span>
                  If you don't recognise this fingerprint, do <strong>not</strong> proceed — verify
                  it out-of-band with the server operator.
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
                      className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 rounded border px-2 py-0.5 text-[10px] text-accent-green transition-colors"
                    >
                      Trust this host
                    </button>
                  </div>
                  <div className="break-all font-mono text-[10px] text-text-primary">
                    {k.fingerprint}
                  </div>
                </div>
              ))}
            </div>
          )}

          {verifyError && <div className="text-[10px] text-accent-red">{verifyError}</div>}
        </div>

        {verifyPhase === "pinned" && (
          <div className="rounded border border-bg-border bg-bg-primary p-3">
            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={
                testStatus === "testing" || !username.trim() || keyPathInvalid || passwordRequired
              }
              className="bg-accent-blue/15 border-accent-blue/30 hover:bg-accent-blue/25 rounded border px-2.5 py-1 text-[11px] font-medium text-accent-blue transition-colors disabled:opacity-40"
            >
              {testStatus === "testing" ? "Testing…" : "Test host, auth, and path"}
            </button>
            {testMessage && (
              <p
                role={testStatus === "failed" ? "alert" : "status"}
                className={`mt-2 text-[10px] ${
                  testStatus === "failed" ? "text-accent-red" : "text-accent-green"
                }`}
              >
                {testMessage}
              </p>
            )}
          </div>
        )}

        {submitError && (
          <p role="alert" className="text-[10px] text-accent-red">
            Could not save server: {submitError}
          </p>
        )}
      </div>
    </Modal>
  );
}
