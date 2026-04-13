import { useState } from "react";
import { Server } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import type { ServerConfig } from "@/types/server";

interface ServerFormModalProps {
  onClose: () => void;
  onSubmit: (config: Omit<ServerConfig, "id" | "installedAgents">) => void;
  initial?: ServerConfig;
}

export function ServerFormModal({ onClose, onSubmit, initial }: ServerFormModalProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authMethod, setAuthMethod] = useState<"agent" | "key" | "password">(
    initial?.authMethod ?? "agent",
  );
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [remotePath, setRemotePath] = useState(initial?.remotePath ?? "");

  function handleSubmit() {
    if (!name.trim() || !host.trim() || !username.trim()) return;
    onSubmit({
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod,
      keyPath: authMethod === "key" ? keyPath.trim() || undefined : undefined,
      password: authMethod === "password" ? password : undefined,
      remotePath: remotePath.trim() || undefined,
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
        disabled={!name.trim() || !host.trim() || !username.trim()}
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

        {authMethod === "password" && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-secondary">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="bg-bg-primary text-xs text-text-primary px-3 py-2 rounded border border-bg-border outline-none focus:border-accent-green/50"
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
      </div>
    </Modal>
  );
}
