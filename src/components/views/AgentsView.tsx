import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, X } from "lucide-react";
import {
  ACP_PROVIDER_ID,
  apiAgentProvider,
  authProbeProvider,
  useAgentTaskStore,
  type AgentCli,
} from "@/stores/agentTaskStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useProfileStore } from "@/stores/profileStore";
import { launchConversation } from "@/lib/launchConversation";
import { API_PROVIDERS } from "@/lib/api-models";
import { getProviderAuthStatus, type ImageAttachment } from "@/lib/tauri";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";
import { AgentsOnboarding } from "@/components/agents/AgentsOnboarding";
import { PacketCodeEngineGate } from "@/components/agents/PacketCodeEngineGate";
import { Composer } from "@/components/agents/composer/Composer";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { AgentMode, ComposerMode } from "@/components/agents/composer/utils";
import {
  recordWorkspaceAgentsEvent,
  useWorkspaceAgentsDogfoodStore,
} from "@/stores/workspaceAgentsDogfoodStore";

// First provider with a ready credential wins the empty-state default.
// Probed via `authProbeProvider`, so every entry is an API-key check.
const AUTO_PICK_ORDER: AgentCli[] = [
  "api-claude-oauth",
  "api-claude",
  "api-openai",
  "api-openai-agents",
  "api-openrouter",
  "api-ollama",
  "api-minimax",
];

const DEFAULT_AGENT: AgentCli = "api-minimax";
const DEFAULT_MODEL = "MiniMax-M3";

export interface AgentsViewProps {
  /**
   * Pin the launch composer to ONE provider instead of auto-picking the first
   * credentialed one. Set by provider-scoped routes (see `PacketCodeView`);
   * `undefined` keeps the historical behaviour exactly.
   */
  pinnedAgent?: AgentCli;
  /** Model preselected alongside `pinnedAgent`. Ignored when unpinned. */
  pinnedModel?: string;
}

export function AgentsView({ pinnedAgent, pinnedModel }: AgentsViewProps = {}) {
  const selectedRepo = useAgentTaskStore((state) => state.selectedRepo);
  const selectedConversationId = useAgentTaskStore((state) => state.selectedConversationId);
  const selectConversation = useAgentTaskStore((state) => state.selectConversation);

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>(pinnedAgent ?? DEFAULT_AGENT);
  const [selectedModel, setSelectedModel] = useState(pinnedModel ?? DEFAULT_MODEL);
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

  /**
   * Whether the ACP transport is currently selected — it is the one with an
   * engine-side session directory to show. A TRANSPORT question, not an
   * affordance one: what the directory then lets you do is still resolved from
   * `capabilitiesFor()` inside the sidebar.
   *
   * This keys off the LIVE selection, not a route-level pin. It used to read
   * `pinnedAgent`, because the engine directory belonged to the separate
   * `PacketCodeView` route. That route is gone — PacketCode is a provider you
   * select inside this one pane — so the directory follows the selection
   * instead. Pick PacketCode and it appears; pick anything else and a list of
   * packetcode-engine sessions would be noise, so it does not.
   */
  const acpSelected = apiAgentProvider(selectedAgent) === ACP_PROVIDER_ID;
  const showEngineSessions = acpSelected;

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
    // A pinned provider is the caller's explicit choice — never override it
    // with the credential auto-pick.
    if (pinnedAgent || autoPickStarted.current || selectedConversationId) return;
    autoPickStarted.current = true;
    let cancelled = false;
    void Promise.all(
      AUTO_PICK_ORDER.map(async (agent) => {
        try {
          return {
            agent,
            status: await getProviderAuthStatus(authProbeProvider(agent)),
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
  }, [pinnedAgent, selectedConversationId]);

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
        showEngineSessions={showEngineSessions}
      />

      {selectedConversationId ? (
        <>
          <ErrorBoundary fallbackMessage="This conversation encountered an error.">
            <AgentChatPane
              conversationId={selectedConversationId}
              onClose={handleNewAgent}
              // The Agents dock is a sibling of this pane, so its header owns
              // the toggle. (Workspace tiles omit this — see AgentChatPane.)
              dockSurface="agents"
            />
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
          <LaunchGate
            acpSelected={acpSelected}
            onUseAnotherProvider={() => setSelectedAgent(DEFAULT_AGENT)}
          >
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
          </LaunchGate>
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


/**
 * Wraps the launch composer in the packetcode engine gate, but only while the
 * ACP provider is the selected one.
 *
 * The gate used to wrap the whole `PacketCodeView` route. With that route gone
 * it has to be scoped to the selection instead — gating the entire Agents pane
 * because one of nine providers is unavailable would be absurd, and gating
 * nothing would let a launch fail with the engine's raw error instead of the
 * gate's install/pin remedies.
 *
 * Rendering it around the composer means it can replace the very control that
 * holds the provider picker, which is why `onUseAnotherProvider` is passed:
 * without an escape hatch the user would be stuck on a provider they cannot
 * use. Every other provider keeps working while this one is not installed.
 */
function LaunchGate({
  acpSelected,
  onUseAnotherProvider,
  children,
}: {
  acpSelected: boolean;
  onUseAnotherProvider: () => void;
  children: ReactNode;
}) {
  if (!acpSelected) return <>{children}</>;
  return (
    <PacketCodeEngineGate onUseAnotherProvider={onUseAnotherProvider}>
      {children}
    </PacketCodeEngineGate>
  );
}
