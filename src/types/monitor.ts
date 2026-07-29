export type MonitorRoute =
  | { kind: "agent_conversation"; conversationId: string }
  | { kind: "flight"; flightId: string };

export interface MonitorLease {
  monitorId: string;
  label: string;
  route: MonitorRoute;
  mode: "readonly";
  nonce: string;
  createdAt: number;
}
