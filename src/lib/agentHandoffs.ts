import { useAgentStore } from "@/stores/agentStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { useFlightStore } from "@/stores/flightStore";
import { useRightDockStore } from "@/stores/rightDockStore";
import { useServerStore } from "@/stores/serverStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { makeSshUri } from "@/lib/ssh-uri";
import { getPreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";
import type { AgentConversation, PermissionMode } from "@/types/agent-conversation";
import type { McpTrustSnapshot } from "@/types/mcp";
import {
  isLocalWorkspace,
  isSyndicateWorkspace,
  type Workspace,
  type WorkspaceAgentSlot,
} from "@/types/workspace";
import { recordWorkspaceAgentsEvent } from "@/stores/workspaceAgentsDogfoodStore";

export type AgentHandoffErrorCode =
  | "conversation_not_found"
  | "workspace_not_found"
  | "flight_not_found"
  | "packetcode_unavailable"
  | "unsupported_target";

export type AgentHandoffResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; code: AgentHandoffErrorCode; message: string };

export interface ConversationProjectTarget {
  kind: "local" | "ssh";
  projectPath: string;
  serverId?: string;
  serverName?: string;
  worktree?: {
    basePath: string;
    worktreePath: string;
    branch: string;
  };
}

export interface PacketCodeHandoffPayload {
  schemaVersion: 1;
  source: {
    kind: "agent_conversation";
    conversationId: string;
    title: string;
    updatedAt: number;
  };
  target: ConversationProjectTarget;
  objective: string;
  references: string[];
  requestedAction: "continue_in_packetcode";
  sourcePermissionPosture: {
    permissionMode: PermissionMode | null;
    approveWrites: boolean;
    enabledMcpServerIds: string[] | null;
    mcpTrustSnapshot: McpTrustSnapshot[] | null;
  };
  constraints: {
    transcriptIncluded: false;
    secretsIncluded: false;
    hiddenReasoningIncluded: false;
    authorityTransfer: false;
  };
  createdAt: number;
}

function conversationById(conversationId: string): AgentConversation | null {
  return (
    useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === conversationId) ?? null
  );
}

function normalizePath(path: string, caseInsensitive: boolean): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isWindowsStylePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function leafName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Project";
}

export function getConversationProjectTarget(
  conversation: AgentConversation,
): ConversationProjectTarget {
  const worktree =
    conversation.worktree?.state === "active"
      ? {
          basePath: conversation.worktree.basePath,
          worktreePath: conversation.worktree.worktreePath,
          branch: conversation.worktree.branch,
        }
      : undefined;
  const projectPath = worktree?.worktreePath ?? conversation.projectPath;

  if (conversation.sshTarget) {
    return {
      kind: "ssh",
      projectPath: projectPath || conversation.sshTarget.remotePath,
      serverId: conversation.sshTarget.id,
      serverName: conversation.sshTarget.name,
      worktree,
    };
  }

  return { kind: "local", projectPath, worktree };
}

export function workspaceMatchesConversationTarget(
  workspace: Workspace,
  target: ConversationProjectTarget,
): boolean {
  if (workspace.status !== "active" || workspace.origin === "conversation") return false;
  if (target.kind === "ssh") {
    if (workspace.serverId !== target.serverId) return false;
    const workspacePath = workspace.remoteProjectPath ?? workspace.projectPath;
    return normalizePath(workspacePath, false) === normalizePath(target.projectPath, false);
  }
  if (!isLocalWorkspace(workspace)) return false;
  return (
    normalizePath(workspace.projectPath, isWindowsStylePath(workspace.projectPath)) ===
    normalizePath(target.projectPath, isWindowsStylePath(target.projectPath))
  );
}

function ensureProjectWorkspace(
  conversation: AgentConversation,
  initialSession?: WorkspaceAgentSlot,
): { workspaceId: string; created: boolean } {
  const target = getConversationProjectTarget(conversation);
  const workspaceStore = useWorkspaceStore.getState();
  const activeMatch = workspaceStore.workspaces.find(
    (workspace) =>
      workspace.id === workspaceStore.activeWorkspaceId &&
      workspaceMatchesConversationTarget(workspace, target),
  );
  const existing =
    activeMatch ??
    workspaceStore.workspaces.find((workspace) =>
      workspaceMatchesConversationTarget(workspace, target),
    );

  if (existing) {
    workspaceStore.setActiveWorkspace(existing.id);
    return { workspaceId: existing.id, created: false };
  }

  const session = initialSession ?? getPreferredWorkspaceCli(target.serverId);
  const serverPrefix = target.kind === "ssh" && target.serverName ? `${target.serverName} · ` : "";
  const workspaceId = workspaceStore.createWorkspace(
    `${serverPrefix}${leafName(target.projectPath)}`,
    [session],
    target.projectPath,
    target.kind === "ssh"
      ? {
          serverId: target.serverId,
          remoteProjectPath: target.projectPath,
        }
      : undefined,
  );
  return { workspaceId, created: true };
}

function focusWorkspacePane(workspaceId: string, paneId: string): void {
  useWorkspaceStore.getState().requestPaneFocus(workspaceId, paneId);
  useAppStore.getState().setActiveView("workspace");
}

function packetCodeAvailable(serverId?: string): boolean {
  if (serverId) {
    return (
      useServerStore.getState().getServer(serverId)?.installedAgents.includes("packetcode") ?? false
    );
  }
  return useAgentStore.getState().getAgent("packetcode")?.installed ?? false;
}

export function delegateWorkspaceToAgents(
  workspaceId: string,
): AgentHandoffResult<{ workspaceId: string; selectedRepo: string }> {
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: "That Workspace no longer exists.",
    };
  }
  if (isSyndicateWorkspace(workspace)) {
    return {
      ok: false,
      code: "unsupported_target",
      message: "Agent handoff for Syndicate Workspaces is not exposed in this release.",
    };
  }

  const selectedRepo = workspace.serverId
    ? makeSshUri(workspace.serverId, workspace.remoteProjectPath ?? workspace.projectPath)
    : workspace.projectPath;
  const agentStore = useAgentTaskStore.getState();
  agentStore.setSelectedRepo(selectedRepo);
  agentStore.selectConversation(null);
  useAppStore.getState().setActiveView("agents");
  recordWorkspaceAgentsEvent("workspace_delegated_agents");
  return { ok: true, workspaceId, selectedRepo };
}

export function openConversationProjectInWorkspace(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  created: boolean;
}> {
  const conversation = conversationById(conversationId);
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }
  try {
    const workspace = ensureProjectWorkspace(conversation);
    useAppStore.getState().setActiveView("workspace");
    recordWorkspaceAgentsEvent("agent_opened_workspace_project");
    return { ok: true, conversationId, ...workspace };
  } catch (cause) {
    return {
      ok: false,
      code: "workspace_not_found",
      message:
        cause instanceof Error ? cause.message : "The project Workspace could not be opened.",
    };
  }
}

export function attachTerminalToConversationProject(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  paneId: string;
}> {
  const conversation = conversationById(conversationId);
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }

  let ensured: { workspaceId: string; created: boolean };
  try {
    ensured = ensureProjectWorkspace(conversation, "terminal");
  } catch (cause) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: cause instanceof Error ? cause.message : "The terminal target is unavailable.",
    };
  }
  const { workspaceId, created } = ensured;
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  const paneId = created
    ? workspace?.panes[0]?.id
    : useWorkspaceStore.getState().addPane(workspaceId, "terminal");
  if (!paneId) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: "The terminal could not be added to Workspace.",
    };
  }
  focusWorkspacePane(workspaceId, paneId);
  recordWorkspaceAgentsEvent("agent_attached_terminal");
  return { ok: true, conversationId, workspaceId, paneId };
}

export function openConversationInPacketCode(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  paneId: string;
  createdWorkspace: boolean;
  createdPane: boolean;
}> {
  const conversation = conversationById(conversationId);
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }

  const target = getConversationProjectTarget(conversation);
  if (!packetCodeAvailable(target.serverId)) {
    return {
      ok: false,
      code: "packetcode_unavailable",
      message:
        target.kind === "ssh"
          ? `PacketCode is not detected on ${target.serverName ?? "the selected server"}.`
          : "PacketCode is not detected. Open Settings to install or locate it.",
    };
  }

  let ensured: { workspaceId: string; created: boolean };
  try {
    ensured = ensureProjectWorkspace(conversation, "packetcode");
  } catch (cause) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: cause instanceof Error ? cause.message : "The PacketCode target is unavailable.",
    };
  }
  const { workspaceId, created } = ensured;
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  const existingPane = workspace?.panes.find(
    (pane) => pane.kind !== "conversation" && pane.agentId === "packetcode",
  );
  const paneId =
    existingPane?.id ??
    (created
      ? workspace?.panes[0]?.id
      : useWorkspaceStore.getState().addPane(workspaceId, "packetcode"));
  if (!paneId) {
    return {
      ok: false,
      code: "workspace_not_found",
      message: "PacketCode could not be added to Workspace.",
    };
  }
  focusWorkspacePane(workspaceId, paneId);
  recordWorkspaceAgentsEvent("agent_packetcode_handoff");
  return {
    ok: true,
    conversationId,
    workspaceId,
    paneId,
    createdWorkspace: created,
    createdPane: !existingPane && !created,
  };
}

export function openConversationGitEnding(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  created: boolean;
}> {
  const project = openConversationProjectInWorkspace(conversationId);
  if (!project.ok) return project;
  useAppStore.getState().openGitPanelForConversation(conversationId, project.workspaceId);
  // D2: the panel itself is a RightDock panel now — scope in appStore,
  // visibility in the dock.
  useRightDockStore.getState().openPanel("workspace", "git");
  recordWorkspaceAgentsEvent("agent_opened_git_ending");
  return project;
}

export function openFlightAttemptInWorkspace(conversationId: string): AgentHandoffResult<{
  conversationId: string;
  workspaceId: string;
  created: boolean;
}> {
  const result = openConversationProjectInWorkspace(conversationId);
  if (result.ok) {
    recordWorkspaceAgentsEvent("flight_attempt_opened_workspace");
  }
  return result;
}

export function linkConversationToFlight(
  conversationId: string,
  flightId: string,
  options: { openFlight?: boolean } = {},
): AgentHandoffResult<{
  conversationId: string;
  flightId: string;
  alreadyLinked: boolean;
}> {
  if (!conversationById(conversationId)) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "That agent conversation no longer exists.",
    };
  }
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  if (!flight) {
    return {
      ok: false,
      code: "flight_not_found",
      message: "That Flight no longer exists.",
    };
  }

  const alreadyLinked = flight.linkedSessionIds.includes(conversationId);
  if (!alreadyLinked) {
    useFlightStore.getState().updateFlight(flightId, {
      linkedSessionIds: [...flight.linkedSessionIds, conversationId],
    });
  }
  if (options.openFlight) {
    useFlightStore.getState().setActiveFlight(flightId);
    useAppStore.getState().setActiveView("flights");
  }
  recordWorkspaceAgentsEvent("agent_linked_flight");
  return { ok: true, conversationId, flightId, alreadyLinked };
}

export function buildPacketCodeHandoffPayload(input: {
  conversation: AgentConversation;
  objective: string;
  references?: string[];
  createdAt?: number;
}): PacketCodeHandoffPayload {
  const objective = input.objective.trim();
  if (!objective) throw new Error("A PacketCode handoff objective is required.");
  const references = Array.from(
    new Set((input.references ?? []).map((item) => item.trim()).filter(Boolean)),
  );
  return {
    schemaVersion: 1,
    source: {
      kind: "agent_conversation",
      conversationId: input.conversation.id,
      title: input.conversation.title,
      updatedAt: input.conversation.updatedAt,
    },
    target: getConversationProjectTarget(input.conversation),
    objective,
    references,
    requestedAction: "continue_in_packetcode",
    sourcePermissionPosture: {
      permissionMode: input.conversation.permissionMode ?? null,
      approveWrites: input.conversation.approveWrites ?? false,
      enabledMcpServerIds: input.conversation.enabledMcpServerIds ?? null,
      mcpTrustSnapshot: input.conversation.mcpTrustSnapshot ?? null,
    },
    constraints: {
      transcriptIncluded: false,
      secretsIncluded: false,
      hiddenReasoningIncluded: false,
      authorityTransfer: false,
    },
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function formatPacketCodeHandoffPayload(payload: PacketCodeHandoffPayload): string {
  return [
    "packetade-packetcode-handoff/v1",
    JSON.stringify(payload, null, 2),
    "",
    "Continue this objective in the exact target above. Treat the listed permission posture as",
    "provenance only; do not broaden tools, roots, MCP access, or credentials without approval.",
  ].join("\n");
}
