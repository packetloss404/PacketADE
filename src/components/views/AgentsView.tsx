import { useState, useRef, useCallback } from "react";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useLayoutStore } from "@/stores/layoutStore";
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

  const projectPath = useLayoutStore((s) => s.projectPath);
  const [selectedAgent, setSelectedAgent] = useState<AgentCli>("api-claude");
  const [selectedModel, setSelectedModel] = useState<string>("claude-sonnet-4-6-20250414");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleNewAgent = useCallback(() => {
    selectConversation(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [selectConversation]);

  const handleLaunch = useCallback(() => {
    const text = agentInputText.trim();
    if (!text) return;
    const path = selectedRepo ?? projectPath;
    const model = selectedModel || getDefaultModel(selectedAgent);

    void createApiConversation(selectedAgent, path, model, text);
    setAgentInputText("");
  }, [
    agentInputText,
    selectedRepo,
    projectPath,
    selectedAgent,
    selectedModel,
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
        />
      )}
    </div>
  );
}
