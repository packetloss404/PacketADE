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
