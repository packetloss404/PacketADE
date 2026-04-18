import { useState } from "react";
import { Server } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useSshTargetStore } from "@/stores/sshTargetStore";
import type { SshTarget } from "@/types/ssh";

interface SshConnectModalProps {
  onClose: () => void;
  onConnected: (target: SshTarget) => void;
}

export function SshConnectModal({ onClose, onConnected }: SshConnectModalProps) {
  const addTarget = useSshTargetStore((s) => s.addTarget);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = host.trim() && user.trim() && remotePath.trim();

  const handleConnect = () => {
    if (!canSubmit) {
      setError("Host, user and remote path are required.");
      return;
    }
    const portNum = parseInt(port, 10);
    if (Number.isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      setError("Port must be a number between 1 and 65535.");
      return;
    }
    const target = addTarget({
      name: name.trim() || `${user.trim()}@${host.trim()}`,
      host: host.trim(),
      port: portNum,
      user: user.trim(),
      remotePath: remotePath.trim(),
      keyPath: keyPath.trim() || undefined,
    });
    onConnected(target);
  };

  return (
    <Modal
      onClose={onClose}
      title="Connect to SSH server"
      icon={<Server size={14} className="text-accent-green" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="green" onClick={handleConnect} disabled={!canSubmit}>
            Connect
          </Button>
        </div>
      }
    >
      <div className="p-5 flex flex-col gap-3">
        <p className="text-[11px] text-text-muted leading-relaxed">
          The agent will run commands and edit files directly on the remote host
          via SSH. Remote tool-use is in progress — connections are saved now and
          will activate when the backend proxy ships.
        </p>

        <Field label="Name (optional)">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-box"
            className={inputCls}
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
            />
          </Field>
          <Field label="Port">
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className={inputCls}
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
          />
        </Field>

        <Field label="Remote path">
          <input
            type="text"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/home/ubuntu/my-project"
            className={inputCls}
          />
        </Field>

        <Field label="Private key path (optional)">
          <input
            type="text"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder="~/.ssh/id_ed25519"
            className={inputCls}
          />
        </Field>

        {error && (
          <div className="text-[11px] text-accent-red">{error}</div>
        )}
      </div>
    </Modal>
  );
}

const inputCls =
  "w-full bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/60";

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
