import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import { apiAgentProvider, useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useProfileStore } from "@/stores/profileStore";
import { launchConversation } from "@/lib/launchConversation";
import { API_PROVIDERS } from "@/lib/api-models";
import { getProviderAuthStatus, type ImageAttachment } from "@/lib/tauri";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";
import { AgentsOnboarding } from "@/components/agents/AgentsOnboarding";
import { Composer } from "@/components/agents/composer/Composer";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { AgentMode, ComposerMode } from "@/components/agents/composer/utils";
import {
  recordWorkspaceAgentsEvent,
  useWorkspaceAgentsDogfoodStore,
} from "@/stores/workspaceAgentsDogfoodStore";

const AUTO_PICK_ORDER: AgentCli[] = [
  "api-claude-oauth",
  "api-claude",
  "api-openai-codex",
  "api-openai",
  "api-openai-agents",
  "api-openrouter",
  "api-ollama",
  "api-minimax",
];

const DEFAULT_AGENT: AgentCli = "api-minimax";
const DEFAULT_MODEL = "MiniMax-M3";

export function AgentsView() {
  const selectedRepo = useAgentTaskStore((state) => state.selectedRepo);
  const selectedConversationId = useAgentTaskStore((state) => state.selectedConversationId);
  const selectConversation = useAgentTaskStore((state) => state.selectConversation);

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>(DEFAULT_AGENT);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const defaultProfileId = useProfileStore((state) => state.defaultProfileId);
  const getProfile = useProfileStore((state) => state.getProfile);
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId);
  const composerMode = useAgentSettingsStore((state) => state.composerMode) as ComposerMode;
  const setComposerMode = useAgentSettingsStore((state) => state.setComposerMode);
  const userPickedProfile = useRef(false);
  const autoPickStarted = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recordVisibleConversations = useWorkspaceAgentsDogfoodStore(
    (state) => state.recordVisibleConversations,
  );

  useEffect(() => {
    recordVisibleConversations(selectedConversationId ? 1 : 0);
  }, [recordVisibleConversations, selectedConversationId]);

  useEffect(() => {
    if (!userPickedProfile.current) setSelectedProfileId(defaultProfileId);
  }, [defaultProfileId]);

  useEffect(() => {
    if (selectedConversationId) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectedConversationId]);

  useEffect(() => {
    if (!launchError) return;
    const timer = window.setTimeout(() => setLaunchError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [launchError]);

  useEffect(() => {
    if (autoPickStarted.current || selectedConversationId) return;
    autoPickStarted.current = true;
    let cancelled = false;
    void Promise.all(
      AUTO_PICK_ORDER.map(async (agent) => {
        try {
          return {
            agent,
            status: await getProviderAuthStatus(apiAgentProvider(agent)),
          };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const ready = results.find((result) => result?.status.status === "ready");
      if (!ready) return;
      const provider = API_PROVIDERS.find((candidate) => candidate.agentCli === ready.agent);
      setSelectedAgent(ready.agent);
      if (provider?.models[0]?.value) {
        setSelectedModel(provider.models[0].value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedConversationId]);

  const handleNewAgent = useCallback(() => {
    selectConversation(null);
  }, [selectConversation]);

  const handleProfileChange = useCallback((profileId: string) => {
    userPickedProfile.current = true;
    setSelectedProfileId(profileId);
  }, []);

  const handleLaunch = useCallback(
    (rawText: string, attachments: ImageAttachment[]) =>
      launchConversation({
        rawText,
        attachments,
        selectedRepo,
        selectedAgent,
        selectedModel,
        agentMode,
        composerMode,
        profile: getProfile(selectedProfileId),
        setLaunchError,
        onCreated: () => recordWorkspaceAgentsEvent("agent_started_agents"),
      }),
    [
      agentMode,
      composerMode,
      getProfile,
      selectedAgent,
      selectedModel,
      selectedProfileId,
      selectedRepo,
    ],
  );

  return (
    <div className="relative flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar
        selectedId={selectedConversationId}
        onSelect={selectConversation}
        onNewAgent={handleNewAgent}
      />

      {selectedConversationId ? (
        <>
          <ErrorBoundary fallbackMessage="This conversation encountered an error.">
            <AgentChatPane conversationId={selectedConversationId} onClose={handleNewAgent} />
          </ErrorBoundary>
          <ErrorBoundary fallbackMessage="The agent inspector encountered an error.">
            <AgentInspectorPane conversationId={selectedConversationId} />
          </ErrorBoundary>
        </>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-4 py-2">
            <Bot size={14} className="text-accent-green" />
            <div className="flex flex-col">
              <span className="text-ui font-semibold text-text-primary">New agent</span>
              <span className="text-meta text-text-muted">
                Choose a project, provider, model, and execution posture.
              </span>
            </div>
          </div>
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
        </div>
      )}

      {launchError && (
        <div className="border-accent-red/30 absolute bottom-4 left-1/2 z-40 flex max-w-[480px] -translate-x-1/2 items-center gap-2 rounded border bg-bg-elevated px-3 py-2 text-[11px] text-accent-red shadow-lg">
          <span className="flex-1">{launchError}</span>
          <button
            type="button"
            onClick={() => setLaunchError(null)}
            className="transition-colors hover:text-text-primary"
            title="Dismiss launch error"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <AgentsOnboarding />
    </div>
  );
}
