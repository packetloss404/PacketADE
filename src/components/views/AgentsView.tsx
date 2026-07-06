import { useState, useRef, useCallback, useEffect } from "react";
import {
  useAgentTaskStore,
  apiAgentProvider,
  type AgentCli,
  type AgentSshConfigInput,
} from "@/stores/agentTaskStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useServerStore } from "@/stores/serverStore";
import { useProfileStore } from "@/stores/profileStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import { sweepAutoArchive } from "@/stores/agentConversationPersistence";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { Composer } from "@/components/agents/composer/Composer";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";
import { AgentsOnboarding } from "@/components/agents/AgentsOnboarding";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { X } from "lucide-react";
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
} from "@/components/agents/composer/utils";

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
const DEFAULT_MODEL = "MiniMax-M3";

export function AgentsView() {
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const selectedConversationId = useAgentTaskStore((s) => s.selectedConversationId);
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  const createApiConversation = useAgentTaskStore((s) => s.createApiConversation);

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>(DEFAULT_AGENT);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const getProfile = useProfileStore((s) => s.getProfile);
  const [selectedProfileId, setSelectedProfileId] =
    useState<string>(defaultProfileId);
  const userPickedProfileRef = useRef(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const composerMode = useAgentSettingsStore(
    (s) => s.composerMode,
  ) as ComposerMode;
  const setComposerMode = useAgentSettingsStore((s) => s.setComposerMode);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoPickRanRef = useRef(false);

  // Keep the launcher's profile in sync with the store's default until the
  // user makes an explicit pick — defaultProfileId can hydrate after mount,
  // so reading it once via useState would strand the launcher on a stale id.
  useEffect(() => {
    if (!userPickedProfileRef.current) setSelectedProfileId(defaultProfileId);
  }, [defaultProfileId]);

  // Auto-clear the inline launch error so it behaves like a transient toast.
  useEffect(() => {
    if (!launchError) return;
    const t = window.setTimeout(() => setLaunchError(null), 5000);
    return () => window.clearTimeout(t);
  }, [launchError]);

  const handleProfileChange = useCallback((id: string) => {
    userPickedProfileRef.current = true;
    setSelectedProfileId(id);
  }, []);

  // Self-curating sidebar: sweep done+stale conversations into the archive
  // on mount, then again every hour so long-running sessions don't need a
  // reload to fall out of the active list.
  useEffect(() => {
    sweepAutoArchive();
    const interval = window.setInterval(sweepAutoArchive, 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

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
    // Focus after the launcher has had a frame to mount, rather than racing a
    // hardcoded timer that can fire before the textarea exists.
    requestAnimationFrame(() => textareaRef.current?.focus());
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

  // Ctrl/Cmd+Shift+V cycles the global transcript view mode (P1-17:
  // Summary → Normal → Verbose → Summary). Same typing guard as Ctrl+N so
  // composer/inputs never lose the keystroke.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v";
      if (!isShortcut) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (target?.isContentEditable ?? false);
      if (isEditable) return;
      e.preventDefault();
      useAgentSettingsStore.getState().cycleTranscriptViewMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleLaunch = useCallback(
    (rawText: string, attachments: ImageAttachment[]) => {
      const text = rawText.trim();
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

          await createApiConversation({
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
    },
    [
      selectedRepo,
      selectedAgent,
      selectedModel,
      setLaunchError,
      createApiConversation,
      agentMode,
      selectedProfileId,
      getProfile,
      composerMode,
    ],
  );

  // The pane "X" is a NON-destructive close: it returns to the launcher/list
  // and leaves the conversation in the sidebar. Permanent deletion lives
  // behind the sidebar's explicit Delete action (gated by a confirm).
  const handleClosePane = useCallback(() => {
    selectConversation(null);
  }, [selectConversation]);

  return (
    <div className="relative flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar
        onNewAgent={handleNewAgent}
        selectedId={selectedConversationId}
        onSelect={selectConversation}
      />

      {selectedConversationId ? (
        <>
          <ErrorBoundary fallbackMessage="This conversation hit an error.">
            <AgentChatPane
              conversationId={selectedConversationId}
              onClose={handleClosePane}
            />
          </ErrorBoundary>
          <ErrorBoundary fallbackMessage="The inspector hit an error.">
            <AgentInspectorPane conversationId={selectedConversationId} />
          </ErrorBoundary>
        </>
      ) : (
        <Composer
          variant="launch"
          textareaRef={textareaRef}
          selectedAgent={selectedAgent}
          onAgentChange={setSelectedAgent}
          onLaunch={handleLaunch}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          agentMode={agentMode}
          onAgentModeChange={setAgentMode}
          selectedProfileId={selectedProfileId}
          onProfileChange={handleProfileChange}
          composerMode={composerMode}
          onComposerModeChange={setComposerMode}
        />
      )}

      {launchError && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 max-w-[480px] px-3 py-2 rounded bg-accent-red/15 border border-accent-red/30 text-accent-red text-[11px] shadow-lg">
          <span className="flex-1">{launchError}</span>
          <button
            onClick={() => setLaunchError(null)}
            className="text-accent-red hover:text-text-primary transition-colors"
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <AgentsOnboarding />
    </div>
  );
}
