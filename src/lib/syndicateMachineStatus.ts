import { executionTargetForWorkspace, type Workspace } from "@/types/workspace";
import type { SyndicateGrantStatus, SyndicateScope, SyndicateTransport } from "@/types/syndicate";

export const SYNDICATE_SCOPE_DETAILS: ReadonlyArray<{
  scope: SyndicateScope;
  label: string;
  group: "View" | "Control";
}> = [
  { scope: "machine.read", label: "View machine status", group: "View" },
  { scope: "workspace.read", label: "View Workspaces", group: "View" },
  { scope: "terminal.view", label: "View terminal output", group: "View" },
  { scope: "workspace.create", label: "Create Workspaces", group: "Control" },
  { scope: "session.start", label: "Start coding sessions", group: "Control" },
  { scope: "terminal.input", label: "Send terminal input", group: "Control" },
  { scope: "terminal.resize", label: "Resize terminals", group: "Control" },
  { scope: "terminal.stop", label: "Stop coding sessions", group: "Control" },
];

const VIEW_ONLY_SCOPES = new Set<SyndicateScope>([
  "machine.read",
  "workspace.read",
  "terminal.view",
]);
const FULL_CONTROL_SCOPES = new Set(SYNDICATE_SCOPE_DETAILS.map(({ scope }) => scope));

function exactScopeSet(scopes: readonly string[], expected: ReadonlySet<string>): boolean {
  const unique = new Set(scopes);
  return unique.size === expected.size && [...unique].every((scope) => expected.has(scope));
}

export type SyndicateAuthoritySummary =
  | "Approval pending"
  | "Revoked"
  | "Expired"
  | "No permissions"
  | "View only"
  | "Full coding control"
  | "Custom authority";

export function syndicateAuthoritySummary(
  grantStatus: SyndicateGrantStatus,
  scopes: readonly string[],
): SyndicateAuthoritySummary {
  if (grantStatus === "pending") return "Approval pending";
  if (grantStatus === "revoked") return "Revoked";
  if (grantStatus === "expired") return "Expired";
  if (scopes.length === 0) return "No permissions";
  if (exactScopeSet(scopes, VIEW_ONLY_SCOPES)) return "View only";
  if (exactScopeSet(scopes, FULL_CONTROL_SCOPES)) return "Full coding control";
  return "Custom authority";
}

export interface SyndicateDisableImpact {
  activeWorkspaces: number;
  activePanes: number;
  knownHostSessions: number;
}

export function syndicateDisableImpact(workspaces: readonly Workspace[]): SyndicateDisableImpact {
  const syndicateWorkspaces = workspaces.filter(
    (workspace) => executionTargetForWorkspace(workspace).kind === "syndicate",
  );
  const active = syndicateWorkspaces.filter((workspace) => workspace.status === "active");
  const sessionIds = new Set<string>();
  for (const workspace of syndicateWorkspaces) {
    for (const pane of workspace.panes) {
      if (pane.syndicateSessionId) sessionIds.add(pane.syndicateSessionId);
    }
  }
  return {
    activeWorkspaces: active.length,
    activePanes: active.reduce(
      (count, workspace) =>
        count + workspace.panes.filter((pane) => !pane.kind || pane.kind === "terminal").length,
      0,
    ),
    knownHostSessions: sessionIds.size,
  };
}

export function hasSyndicateDisableImpact(impact: SyndicateDisableImpact): boolean {
  return impact.activeWorkspaces > 0 || impact.activePanes > 0 || impact.knownHostSessions > 0;
}

export function configuredTransportLabel(relayEndpoint?: string): string {
  return relayEndpoint ? "PacketRelay + managed SSH bootstrap" : "Managed SSH forward only";
}

export function transportLabel(transport: SyndicateTransport): string {
  return transport === "packet-relay" ? "PacketRelay" : "Managed SSH forward";
}

export function unknownSyndicateScopes(scopes: readonly string[]): string[] {
  const known = new Set<string>(SYNDICATE_SCOPE_DETAILS.map(({ scope }) => scope));
  return [...new Set(scopes.filter((scope) => !known.has(scope)))].sort();
}
