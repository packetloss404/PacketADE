import { useState } from "react";
import { Server, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useSshTargetStore } from "@/stores/sshTargetStore";
import { sshTestConnection, setSshPassword } from "@/lib/tauri";
import type { SshTarget } from "@/types/ssh";

interface SshConnectModalProps {
  onClose: () => void;
  onConnected: (target: SshTarget) => void;
}

type Phase = "edit" | "testing" | "success" | "error";

export function SshConnectModal({ onClose, onConnected }: SshConnectModalProps) {
  const addTarget = useSshTargetStore((s) => s.addTarget);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phase, setPhase] = useState<Phase>("edit");
  const [error, setError] = useState<string | null>(null);

  const trimmedHost = host.trim();
  const trimmedUser = user.trim();
  const trimmedRemotePath = remotePath.trim();
  const canSubmit =
    trimmedHost && trimmedUser && trimmedRemotePath && phase !== "testing";

  const handleConnect = async () => {
    setError(null);
    if (!canSubmit) {
      setError("Host, user and remote path are required.");
      return;
    }
    const portNum = parseInt(port, 10);
    if (Number.isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      setError("Port must be a number between 1 and 65535.");
      return;
    }

    setPhase("testing");
    try {
      await sshTestConnection({
        host: trimmedHost,
        port: portNum,
        user: trimmedUser,
        keyPath: keyPath.trim() || null,
        password: password.length > 0 ? password : null,
      });
    } catch (e) {
      setPhase("error");
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "Connection failed");
      return;
    }

    const target = addTarget({
      name: name.trim() || `${trimmedUser}@${trimmedHost}`,
      host: trimmedHost,
      port: portNum,
      user: trimmedUser,
      remotePath: trimmedRemotePath,
      keyPath: keyPath.trim() || undefined,
    });

    if (password.length > 0) {
      try {
        await setSshPassword(target.id, password);
      } catch (e) {
        // Target already saved; password persistence failed. Surface but don't block.
        console.warn("SSH password keychain store failed:", e);
      }
    }

    setPhase("success");
    // Brief success feedback before closing
    setTimeout(() => onConnected(target), 350);
  };

  const isTesting = phase === "testing";
  const isSuccess = phase === "success";

  return (
    <Modal
      onClose={isTesting ? () => {} : onClose}
      title="Connect to SSH server"
      icon={<Server size={14} className="text-accent-green" />}
      footer={
        <div className="flex justify-between items-center w-full">
          <PhaseIndicator phase={phase} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={isTesting}>
              Cancel
            </Button>
            <Button
              variant="green"
              onClick={handleConnect}
              disabled={!canSubmit || isSuccess}
            >
              {isTesting ? "Testing…" : isSuccess ? "Connected" : "Connect"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="p-5 flex flex-col gap-3">
        <p className="text-[11px] text-text-muted leading-relaxed">
          PacketCode will run an `echo` over SSH to verify the credentials, then
          save the target. Passwords are stored in your OS keychain so you don't
          have to re-enter them — leave blank to use key-based auth only.
        </p>

        <Field label="Name (optional)">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-box"
            className={inputCls}
            disabled={isTesting}
          />
        </Field>

        <div className="grid grid-cols-[1fr_80px] gap-2">
          <Field label="Host">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="server.example.com"
              className={inputCls}
              autoFocus
              disabled={isTesting}
            />
          </Field>
          <Field label="Port">
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className={inputCls}
              disabled={isTesting}
            />
          </Field>
        </div>

        <Field label="User">
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="ubuntu"
            className={inputCls}
            disabled={isTesting}
          />
        </Field>

        <Field label="Remote path">
          <input
            type="text"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/home/ubuntu/my-project"
            className={inputCls}
            disabled={isTesting}
          />
        </Field>

        <Field label="Password">
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="leave blank to use key auth"
              className={`${inputCls} pr-8`}
              autoComplete="new-password"
              disabled={isTesting}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-1.5 flex items-center text-text-muted hover:text-text-primary"
              tabIndex={-1}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
        </Field>

        <Field label="Private key path (optional)">
          <input
            type="text"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder="~/.ssh/id_ed25519"
            className={inputCls}
            disabled={isTesting}
          />
        </Field>

        {error && <div className="text-[11px] text-accent-red">{error}</div>}
      </div>
    </Modal>
  );
}

function PhaseIndicator({ phase }: { phase: Phase }) {
  if (phase === "testing") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-accent-blue">
        <Loader2 size={12} className="animate-spin" />
        Testing connection…
      </span>
    );
  }
  if (phase === "success") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-accent-green">
        <CheckCircle2 size={12} />
        Connected
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-accent-red">
        <AlertCircle size={12} />
        Connection failed
      </span>
    );
  }
  return <span />;
}

const inputCls =
  "w-full bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/60 disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
