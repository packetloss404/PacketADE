export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "agent" | "key" | "password";
  keyPath?: string;
  remotePath?: string;
  lastConnectedAt?: number;
  installedAgents: string[];
  /** SHA256 host-key fingerprint captured on first save. When present,
   *  SSH connects with strict host-key checking against the app-managed
   *  known_hosts file. When absent (legacy entries), TOFU fallback is
   *  used for one connection and the user is warned. */
  hostFingerprint?: string;
}

export type ServerStatus = "disconnected" | "connecting" | "connected" | "error";

export type ConnectionStepStatus = "pending" | "running" | "success" | "error" | "skipped";

export interface ConnectionStep {
  id: string;
  label: string;
  status: ConnectionStepStatus;
  detail?: string;
}

export interface ServerConnectionState {
  status: ServerStatus;
  error?: string;
  steps: ConnectionStep[];
}
