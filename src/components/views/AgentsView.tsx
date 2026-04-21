import { useState, useRef, useCallback, useEffect } from "react";
import {
  useAgentTaskStore,
  apiAgentProvider,
  type AgentCli,
} from "@/stores/agentTaskStore";
import { useProfileStore } from "@/stores/profileStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useSshTargetStore } from "@/stores/sshTargetStore";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentInputArea } from "@/components/agents/AgentInputArea";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { API_PROVIDERS, getDefaultModel } from "@/lib/api-models";
import { getProviderAuthStatus } from "@/lib/tauri";
import { isSshUri, parseSshTargetId } from "@/types/ssh";
import type { AgentMode } from "@/components/agents/AgentInputArea";

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

  const profiles = useProfileStore((s) => s.profiles);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>(DEFAULT_AGENT);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    activeProfileId ?? profiles[0]?.id ?? "",
  );
  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
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

  const handleProfileChange = useCallback(
    (id: string) => {
      setSelectedProfileId(id);
      setActiveProfile(id);
      const profile = useProfileStore.getState().profiles.find((p) => p.id === id);
      if (profile && profile.defaultModel) {
        setSelectedModel(profile.defaultModel);
      }
    },
    [setActiveProfile],
  );

  const handleLaunch = useCallback(() => {
    const text = agentInputText.trim();
    if (!text) return;
    if (!selectedRepo) return;

    const model = selectedModel || getDefaultModel(selectedAgent);
    const profile = profiles.find((p) => p.id === selectedProfileId);
    const systemPrompt = profile?.systemPrompt ? profile.systemPrompt : null;

    // Mode → planMode + post-create permissionMode.
    const planMode = agentMode === "ask" || agentMode === "plan";
    const postCreatePermissionMode: "auto" | "ask_for_risky" =
      agentMode === "manual" ? "ask_for_risky" : "auto";
    // Plan mode: prepend a brief instruction so the agent leads with a plan.
    const initialMessage =
      agentMode === "plan"
        ? `Begin with a structured plan (## Plan / ## Files to change / ## Steps), then implement step by step.\n\n${text}`
        : text;

    const setPermissionMode = useAgentTaskStore.getState().setPermissionMode;

    void (async () => {
      let convId: string | undefined;
      if (isSshUri(selectedRepo)) {
        const targetId = parseSshTargetId(selectedRepo);
        const target = targetId
          ? useSshTargetStore.getState().getTarget(targetId)
          : undefined;
        if (!target) {
          alert("SSH target no longer exists. Reconnect it from the project dropdown.");
          return;
        }
        useSshTargetStore.getState().touchTarget(target.id);
        convId = await createApiConversation(
          selectedAgent,
          target.remotePath,
          model,
          initialMessage,
          systemPrompt,
          undefined,
          planMode,
          target,
        );
      } else {
        useProjectHistoryStore.getState().recordOpen(selectedRepo);
        convId = await createApiConversation(
          selectedAgent,
          selectedRepo,
          model,
          initialMessage,
          systemPrompt,
          undefined,
          planMode,
        );
      }
      if (convId && postCreatePermissionMode !== "auto") {
        try {
          await setPermissionMode(convId, postCreatePermissionMode);
        } catch (e) {
          console.warn("Failed to set permission mode:", e);
        }
      }
    })();
    setAgentInputText("");
  }, [
    agentInputText,
    selectedRepo,
    selectedAgent,
    selectedModel,
    selectedProfileId,
    profiles,
    setAgentInputText,
    createApiConversation,
    agentMode,
  ]);

  const handleCloseConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
    },
    [deleteConversation],
  );

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar
        onNewAgent={handleNewAgent}
        selectedId={selectedConversationId}
        onSelect={selectConversation}
      />

      {selectedConversationId ? (
        <AgentChatPane
          conversationId={selectedConversationId}
          onClose={() => handleCloseConversation(selectedConversationId)}
        />
      ) : (
        <AgentInputArea
          textareaRef={textareaRef}
          selectedAgent={selectedAgent}
          onAgentChange={setSelectedAgent}
          onLaunch={handleLaunch}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          selectedProfileId={selectedProfileId}
          onProfileChange={handleProfileChange}
          agentMode={agentMode}
          onAgentModeChange={setAgentMode}
        />
      )}

      <aside className="w-0 border-l border-bg-border overflow-hidden" aria-hidden="true" />
    </div>
  );
}
