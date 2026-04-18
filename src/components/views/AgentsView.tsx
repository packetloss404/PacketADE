import { useState, useRef, useCallback } from "react";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useProfileStore } from "@/stores/profileStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentInputArea } from "@/components/agents/AgentInputArea";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { getDefaultModel } from "@/lib/api-models";

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

  const [selectedAgent, setSelectedAgent] = useState<AgentCli>("api-minimax");
  const [selectedModel, setSelectedModel] = useState<string>("MiniMax-M2.7-highspeed");
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    activeProfileId ?? profiles[0]?.id ?? "",
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleNewAgent = useCallback(() => {
    selectConversation(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [selectConversation]);

  const handleProfileChange = useCallback(
    (id: string) => {
      setSelectedProfileId(id);
      setActiveProfile(id);
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

    useProjectHistoryStore.getState().recordOpen(selectedRepo);
    void createApiConversation(selectedAgent, selectedRepo, model, text, systemPrompt);
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
        />
      )}

      <aside className="w-0 border-l border-bg-border overflow-hidden" aria-hidden="true" />
    </div>
  );
}
