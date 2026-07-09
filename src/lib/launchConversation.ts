import {
  useAgentTaskStore,
  type AgentCli,
  type AgentSshConfigInput,
} from "@/stores/agentTaskStore";
import { requestConversationSave } from "@/stores/agentConversationPersistence";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useServerStore } from "@/stores/serverStore";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import { getDefaultModel } from "@/lib/api-models";
import {
  createConversationWorktree,
  getGitBranch,
  type ImageAttachment,
} from "@/lib/tauri";
import { generateId } from "@/lib/storage";
import { isSshUri, parseSshUri } from "@/lib/ssh-uri";
import type { AgentMode, ComposerMode } from "@/components/agents/composer/utils";
import type { AgentProfile } from "@/types/profiles";
import type { AgentConversation } from "@/types/agent-conversation";

/** Inputs the AgentsView launcher captures and hands to `launchConversation`.
 * Extracted verbatim from `AgentsView.handleLaunch` so the launch flow —
 * profile/model resolution, SSH parsing, worktree provisioning, and the
 * `createApiConversation` dispatch — lives in one testable place. AgentsView
 * now only resolves these values and delegates; behavior is identical. */
export interface LaunchConversationParams {
  rawText: string;
  attachments: ImageAttachment[];
  selectedRepo: string | null;
  selectedAgent: AgentCli;
  selectedModel: string;
  /** The four launcher mode buttons (agent | ask | manual | plan). */
  agentMode: AgentMode;
  /** local vs worktree launch (Settings-level toggle). */
  composerMode: ComposerMode;
  /** The launcher profile AgentsView resolved via `profileStore.getProfile`. */
  profile: AgentProfile | undefined;
  setLaunchError: (message: string | null) => void;
}

/**
 * Launch an API conversation from the Agents launcher. Returns `true` when the
 * launch was dispatched (the async backend work runs fire-and-forget) and
 * `false` for the synchronous guard failures (empty text, no repo, unresolved
 * SSH target). Mirrors the previous `handleLaunch` contract exactly.
 *
 * tile-program D: when launched in worktree mode, the worktree provenance —
 * including the `baseBranch` that was previously computed then discarded — is
 * stamped onto the conversation's `worktree` field so later phases can land or
 * discard it. On provisioning failure the launch falls back to the project
 * root exactly as before and no `worktree` field is stamped.
 */
export function launchConversation({
  rawText,
  attachments,
  selectedRepo,
  selectedAgent,
  selectedModel,
  agentMode,
  composerMode,
  profile,
  setLaunchError,
}: LaunchConversationParams): boolean {
  const text = rawText.trim();
  if (!text) return false;
  if (!selectedRepo) return false;

  const createApiConversation = useAgentTaskStore.getState().createApiConversation;

  // Profile contributes the system prompt + tool whitelist + memory flag.
  // Mode (the four launcher buttons) wins for plan/permission posture so
  // users can override a profile's defaults per-launch.
  const systemPrompt: string | null =
    profile && profile.systemPrompt.length > 0 ? profile.systemPrompt : null;
  const allowedTools: string[] | null = profile?.allowedTools ?? null;
  const memoryContextEnabled = profile?.memoryContextEnabled ?? false;

  // B9: profile.pinnedModel overrides the launcher selection so the
  // launcher's auto-pick or default doesn't silently switch a known-
  // good model out from under a Reviewer / Scout / pinned profile.
  const model =
    profile?.pinnedModel ||
    selectedModel ||
    getDefaultModel(selectedAgent);

  // Mode -> planMode + launch-time permission posture (mode overrides profile).
  const planMode = agentMode === "ask" || agentMode === "plan";
  const launchPermissionMode: "auto" | "ask_for_risky" =
    agentMode === "manual" ? "ask_for_risky" : "auto";
  const launchApproveWrites = false;
  // Plan mode alone drives planning: the backend plan-mode posture keeps
  // the agent read-only and the inline PlanModeApprovalMenu carries the
  // approval when the plan lands.
  const initialMessage = text;

  const att = attachments.length > 0 ? attachments : null;
  let sshProjectPath: string | null = null;
  let sshTarget: AgentSshConfigInput | null = null;

  if (isSshUri(selectedRepo)) {
    const parsed = parseSshUri(selectedRepo);
    const server = parsed
      ? useServerStore.getState().getServer(parsed.serverId)
      : undefined;
    if (!parsed || !server) {
      setLaunchError(
        "SSH server no longer exists. Pick another from the project dropdown.",
      );
      return false;
    }
    // Per-session remote path comes from the URI (edited inline in
    // AgentInputArea), falling back to the server-level default.
    const remotePath =
      (parsed.remotePath && parsed.remotePath.trim().length > 0
        ? parsed.remotePath.trim()
        : server.remotePath?.trim()) ?? "";
    if (!remotePath) {
      setLaunchError(
        "Enter a remote project path for this SSH server before launching.",
      );
      return false;
    }
    sshProjectPath = remotePath;
    sshTarget = {
      serverId: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      user: server.username,
      remotePath,
      keyPath: server.keyPath ?? null,
      authMethod: server.authMethod,
      hostFingerprint: server.hostFingerprint ?? null,
    };
  }

  setLaunchError(null);
  void (async () => {
    try {
      if (sshTarget && sshProjectPath) {
        // Stamp lastConnectedAt so the recents ordering reflects use.
        useServerStore.getState().updateServer(sshTarget.serverId, {
          lastConnectedAt: Date.now(),
        });
        await createApiConversation({
          agent: selectedAgent,
          projectPath: sshProjectPath,
          model,
          initialMessage,
          systemPromptOverride: systemPrompt,
          planMode,
          sshTarget,
          skipBackendStart: false,
          allowedTools,
          memoryContextEnabled,
          attachments: att,
          permissionMode: launchPermissionMode,
          approveWrites: launchApproveWrites,
        });
      } else {
        useProjectHistoryStore.getState().recordOpen(selectedRepo);

        // T3.F: when worktree mode is on, provision a fresh worktree at
        // <projectPath>/.pkt-worktrees/<convId> on a new pkt/<convId>
        // branch off the current HEAD. The conversation then runs inside
        // the worktree so its tool calls don't touch the main checkout.
        let effectiveProjectPath = selectedRepo;
        let explicitConvId: string | undefined;
        // tile-program D: retain the worktree provenance so it can be
        // stamped onto the conversation (the unlandable-work fix). Null
        // when not in worktree mode or when provisioning fails (root
        // fallback).
        let worktreeMeta: NonNullable<AgentConversation["worktree"]> | null = null;
        if (composerMode === "worktree") {
          const provisionalConvId = generateId("conv");
          try {
            const branch = await getGitBranch(selectedRepo).catch(() => "");
            const baseBranch = branch && branch.length > 0 ? branch : "HEAD";
            const wtPath = await createConversationWorktree(
              selectedRepo,
              provisionalConvId,
              baseBranch,
            );
            effectiveProjectPath = wtPath;
            explicitConvId = provisionalConvId;
            worktreeMeta = {
              basePath: selectedRepo,
              worktreePath: wtPath,
              branch: `pkt/${provisionalConvId}`,
              baseBranch,
              createdAt: Date.now(),
              state: "active",
            };
          } catch (e) {
            console.warn(
              "Worktree provisioning failed; falling back to project root:",
              e,
            );
          }
        }

        const convId = await createApiConversation({
          agent: selectedAgent,
          projectPath: effectiveProjectPath,
          model,
          initialMessage,
          systemPromptOverride: systemPrompt,
          planMode,
          sshTarget: null,
          explicitId: explicitConvId,
          skipBackendStart: false,
          allowedTools,
          memoryContextEnabled,
          attachments: att,
          permissionMode: launchPermissionMode,
          approveWrites: launchApproveWrites,
        });

        // tile-program D: stamp the worktree provenance at provisioning.
        // createApiConversation returns after the conversation exists in the
        // store (even if the backend start rejected), so patching it here and
        // requesting a save persists the field on the next debounced write.
        if (worktreeMeta) {
          const meta = worktreeMeta;
          useAgentTaskStore.setState((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === convId ? { ...c, worktree: meta } : c,
            ),
          }));
          requestConversationSave(convId);
        }
      }
      // Clear the composer only once the launch actually succeeded, so a
      // failed launch keeps the user's typed prompt intact for a retry.
      useAgentDraftStore.getState().clearDraft(LAUNCH_DRAFT_KEY);
    } catch (e) {
      setLaunchError(
        e instanceof Error ? e.message : "Failed to launch agent.",
      );
    }
  })();
  return true;
}
