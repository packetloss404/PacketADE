import { useState, useRef, useEffect, useCallback } from "react";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentInputArea } from "@/components/agents/AgentInputArea";
import { AgentPaneContainer } from "@/components/agents/AgentPaneContainer";
import { getDefaultModel } from "@/lib/api-models";

export function AgentsView() {
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const inputMode = useAgentTaskStore((s) => s.inputMode);
  const setInputMode = useAgentTaskStore((s) => s.setInputMode);

  const activeConversationIds = useAgentTaskStore((s) => s.activeConversationIds);
  const createApiConversation = useAgentTaskStore((s) => s.createApiConversation);
  const addToActiveConversations = useAgentTaskStore((s) => s.addToActiveConversations);
  const removeFromActiveConversations = useAgentTaskStore((s) => s.removeFromActiveConversations);

  const projectPath = useLayoutStore((s) => s.projectPath);
  const [selectedAgent, setSelectedAgent] = useState<AgentCli>("api-claude");
  const [selectedModel, setSelectedModel] = useState<string>("claude-sonnet-4-6-20250414");
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const [focusedPaneIndex, setFocusedPaneIndex] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleNewAgent = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const handleLaunch = useCallback(() => {
    const text = agentInputText.trim();
    if (!text) return;
    const path = selectedRepo ?? projectPath;
    const model = selectedModel || getDefaultModel(selectedAgent);

    void createApiConversation(selectedAgent, path, model, text).then((conversationId) => {
      addToActiveConversations(conversationId);
    });

    setAgentInputText("");
  }, [
    agentInputText,
    selectedRepo,
    projectPath,
    selectedAgent,
    selectedModel,
    setAgentInputText,
    createApiConversation,
    addToActiveConversations,
  ]);

  const handleClosePane = useCallback(
    (id: string) => {
      removeFromActiveConversations(id);
    },
    [removeFromActiveConversations],
  );

  const handleAddPane = useCallback(() => {
    if (activeConversationIds.length >= 4) return;
    setShowAgentSelector(true);
  }, [activeConversationIds.length]);

  const handleAgentSelectedForPane = useCallback(
    (agent: AgentCli) => {
      const path = selectedRepo ?? projectPath;
      const model = getDefaultModel(agent);
      void createApiConversation(agent, path, model, "Hello, I need help with this project.").then((conversationId) => {
        addToActiveConversations(conversationId);
      });
      setShowAgentSelector(false);
    },
    [selectedRepo, projectPath, createApiConversation, addToActiveConversations],
  );

  // Global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl+N: focus the input / new conversation
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        handleNewAgent();
        return;
      }

      // Tab in textarea: toggle plan/build mode
      if (e.key === "Tab" && document.activeElement === textareaRef.current) {
        e.preventDefault();
        setInputMode(inputMode === "plan" ? "build" : "plan");
        return;
      }

      // Ctrl+1 through Ctrl+4: focus the Nth visible pane
      if (e.ctrlKey && e.key >= "1" && e.key <= "4") {
        const index = parseInt(e.key) - 1;
        if (index < activeConversationIds.length) {
          e.preventDefault();
          setFocusedPaneIndex(index);
          // Focus the textarea inside that pane
          const panes = document.querySelectorAll<HTMLTextAreaElement>(
            "[data-agent-pane-input]"
          );
          panes[index]?.focus();
        }
        return;
      }

      // Ctrl+W: close the focused pane
      if (e.ctrlKey && e.key === "w") {
        if (activeConversationIds.length > 0) {
          e.preventDefault();
          const idToClose = activeConversationIds[focusedPaneIndex] ?? activeConversationIds[activeConversationIds.length - 1];
          if (idToClose) {
            removeFromActiveConversations(idToClose);
            setFocusedPaneIndex((prev) => Math.max(0, prev - 1));
          }
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewAgent, inputMode, setInputMode, activeConversationIds, focusedPaneIndex, removeFromActiveConversations]);

  const hasActiveConversations = activeConversationIds.length > 0;

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar onNewAgent={handleNewAgent} />

      {hasActiveConversations ? (
        <AgentPaneContainer
          conversationIds={activeConversationIds}
          onClosePane={handleClosePane}
          onAddPane={handleAddPane}
          maxPanes={4}
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

      {/* Agent selector modal for adding a new pane */}
      {showAgentSelector && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowAgentSelector(false)}
        >
          <div
            className="bg-bg-elevated border border-bg-border rounded-lg shadow-xl p-4 min-w-[220px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xs font-medium text-text-primary mb-3">
              Select Provider
            </h3>
            <div className="space-y-1">
              {(
                ["api-claude", "api-openai", "api-minimax", "api-openrouter", "api-ollama"] as AgentCli[]
              ).map((agent) => (
                <button
                  key={agent}
                  onClick={() => handleAgentSelectedForPane(agent)}
                  className="w-full text-left px-3 py-2 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                >
                  {agent === "api-claude"
                    ? "Claude (Anthropic)"
                    : agent === "api-openai"
                      ? "OpenAI"
                      : agent === "api-minimax"
                        ? "MiniMax"
                        : agent === "api-openrouter"
                          ? "OpenRouter"
                          : "Ollama (Local)"}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowAgentSelector(false)}
              className="mt-3 w-full text-center text-[10px] text-text-muted hover:text-text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
