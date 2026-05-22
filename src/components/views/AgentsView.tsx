import { useState, useRef, useCallback, useEffect } from "react";
import {
  useAgentTaskStore,
  apiAgentProvider,
  type AgentCli,
  type AgentSshConfigInput,
} from "@/stores/agentTaskStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useServerStore } from "@/stores/serverStore";
import { useProfileStore } from "@/stores/profileStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentInputArea } from "@/components/agents/AgentInputArea";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";
import { AgentsOnboarding } from "@/components/agents/AgentsOnboarding";
import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import {
  getProviderAuthStatus,
  createConversationWorktree,
  getGitBranch,
  type ImageAttachment,
} from "@/lib/tauri";
import { generateId } from "@/lib/storage";
import { isSshUri, parseSshUri } from "@/lib/ssh-uri";
import type {
  AgentMode,
  ComposerMode,
} from "@/components/agents/AgentInputArea";

/**
 * Preference order for the initial auto-picked agent on a fresh Agents pane.
 * Subscription providers first, then API-key providers; Anthropic over OpenAI.
 * The first one whose live auth status is "ready" wins.
 */
const AGENT_AUTO_PICK_ORDER: AgentCli[] = [
  "api-claude-oauth",
  "api-claude",
  "api-openai-codex",
  "api-openai",
  "api-openai-agents",
  "api-openrouter",
  "api-ollama",
  "api-minimax",
];

/** Hardcoded fallback defaults — also used as the "no user intent" sentinel. */
const DEFAULT_AGENT: AgentCli = "api-minimax";
const DEFAULT_MODEL = "MiniMax-M2.7-highspeed";

export function AgentsView() {
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const selectedConversationId = useAgentTaskStore((s) => s.selectedConversationId);
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  const createApiConversation = useAgentTaskStore((s) => s.createApiConversation);
  const deleteConversation = useAgentTaskStore((s) => s.deleteConversation);

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>(DEFAULT_AGENT);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const getProfile = useProfileStore((s) => s.getProfile);
  const [selectedProfileId, setSelectedProfileId] =
    useState<string>(defaultProfileId);
  const composerMode = useAgentSettingsStore(
    (s) => s.composerMode,
  ) as ComposerMode;
  const setComposerMode = useAgentSettingsStore((s) => s.setComposerMode);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoPickRanRef = useRef(false);

  // One-shot: on mount, if the Agents pane has no active conversation and the
  // user hasn't already manually picked a provider (state still equals the
  // hardcoded default), probe auth status for each provider in preference
  // order and switch to the highest-priority "ready" one. Probes run in
  // parallel; we pick the earliest-preference ready provider.
  useEffect(() => {
    if (autoPickRanRef.current) return;
    if (selectedConversationId) return;
    // Treat a non-default initial selection as explicit user intent.
    if (selectedAgent !== DEFAULT_AGENT) return;
    autoPickRanRef.current = true;

    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        AGENT_AUTO_PICK_ORDER.map(async (agent) => {
          try {
            const status = await getProviderAuthStatus(apiAgentProvider(agent));
            return { agent, status };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      for (const res of results) {
        if (res && res.status.status === "ready") {
          const provider = API_PROVIDERS.find((p) => p.agentCli === res.agent);
          const firstModel = provider?.models[0]?.value;
          setSelectedAgent(res.agent);
          if (firstModel) setSelectedModel(firstModel);
          return;
        }
      }
      // No provider returned "ready" — leave the hardcoded fallback in place.
    })();

    return () => {
      cancelled = true;
    };
    // Mount-only: we intentionally don't react to later changes of
    // selectedAgent / selectedConversationId here. The ref guard enforces
    // one-shot semantics even if the effect re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewAgent = useCallback(() => {
    selectConversation(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [selectConversation]);

  // Ctrl+N (Cmd+N on macOS) opens a fresh agent. Suppressed when the user is
  // typing in an input/textarea so they can still type the literal "n".
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n";
      if (!isShortcut) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (target?.isContentEditable ?? false);
      if (isEditable) return;
      e.preventDefault();
      handleNewAgent();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewAgent]);

  const handleLaunch = useCallback(
    (attachments: ImageAttachment[]) => {
      const text = agentInputText.trim();
      if (!text) return false;
      if (!selectedRepo) return false;

      // Profile contributes the system prompt + tool whitelist + memory flag.
      // Mode (the four launcher buttons) wins for plan/permission posture so
      // users can override a profile's defaults per-launch.
      const profile = getProfile(selectedProfileId);
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
      // F10: Plan mode now drives the three-stage Spec → Plan → Code FSM.
      // Tell the agent to lead with bullet success criteria and STOP — the
      // SpecPanel will render those criteria as editable rows for the user.
      const initialMessage =
        agentMode === "plan"
          ? `Before any plan or code, propose 3-7 success-criterion bullets for this task and STOP. Wait for the user to lock the spec before producing a Plan.\n\nTask:\n${text}`
          : text;

      const att = attachments.length > 0 ? attachments : null;
      let sshProjectPath: string | null = null;
      let sshTarget: AgentSshConfigInput | null = null;

      if (isSshUri(selectedRepo)) {
        const parsed = parseSshUri(selectedRepo);
        const server = parsed
          ? useServerStore.getState().getServer(parsed.serverId)
          : undefined;
        if (!parsed || !server) {
          alert(
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
          alert(
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
          hostFingerprint: server.hostFingerprint ?? null,
        };
      }

      void (async () => {
        let convId: string | undefined;
        if (sshTarget && sshProjectPath) {
          // Stamp lastConnectedAt so the recents ordering reflects use.
          useServerStore.getState().updateServer(sshTarget.serverId, {
            lastConnectedAt: Date.now(),
          });
          convId = await createApiConversation(
            selectedAgent,
            sshProjectPath,
            model,
            initialMessage,
            systemPrompt,
            undefined,
            planMode,
            sshTarget,
            undefined,
            false,
            allowedTools,
            memoryContextEnabled,
            att,
            undefined,
            launchPermissionMode,
            launchApproveWrites,
          );
        } else {
          useProjectHistoryStore.getState().recordOpen(selectedRepo);

          // T3.F: when worktree mode is on, provision a fresh worktree at
          // <projectPath>/.pkt-worktrees/<convId> on a new pkt/<convId>
          // branch off the current HEAD. The conversation then runs inside
          // the worktree so its tool calls don't touch the main checkout.
          let effectiveProjectPath = selectedRepo;
          let explicitConvId: string | undefined;
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
            } catch (e) {
              console.warn(
                "Worktree provisioning failed; falling back to project root:",
                e,
              );
            }
          }

          convId = await createApiConversation(
            selectedAgent,
            effectiveProjectPath,
            model,
            initialMessage,
            systemPrompt,
            undefined,
            planMode,
            null,
            explicitConvId,
            false,
            allowedTools,
            memoryContextEnabled,
            att,
            undefined,
            launchPermissionMode,
            launchApproveWrites,
          );
        }
        // F10: enter the spec stage so SpecPanel renders criteria as the
        // model emits them. The model is instructed to bullet-and-stop.
        if (convId && agentMode === "plan") {
          const plans = useAgentPlanStore.getState();
          plans.setSpec(convId, []);
          plans.setSpecStage(convId, "spec");
        }
      })();
      setAgentInputText("");
      return true;
    },
    [
      agentInputText,
      selectedRepo,
      selectedAgent,
      selectedModel,
      setAgentInputText,
      createApiConversation,
      agentMode,
      selectedProfileId,
      getProfile,
      composerMode,
    ],
  );

  const handleCloseConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
    },
    [deleteConversation],
  );

  return (
    <div className="relative flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar
        onNewAgent={handleNewAgent}
        selectedId={selectedConversationId}
        onSelect={selectConversation}
      />

      {selectedConversationId ? (
        <>
          <AgentChatPane
            conversationId={selectedConversationId}
            onClose={() => handleCloseConversation(selectedConversationId)}
          />
          <AgentInspectorPane conversationId={selectedConversationId} />
        </>
      ) : (
        <AgentInputArea
          textareaRef={textareaRef}
          selectedAgent={selectedAgent}
          onAgentChange={setSelectedAgent}
          onLaunch={handleLaunch}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          agentMode={agentMode}
          onAgentModeChange={setAgentMode}
          selectedProfileId={selectedProfileId}
          onProfileChange={setSelectedProfileId}
          composerMode={composerMode}
          onComposerModeChange={setComposerMode}
        />
      )}

      <AgentsOnboarding />
    </div>
  );
}
