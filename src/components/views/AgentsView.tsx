import { useState, useRef, useEffect, useCallback } from "react";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { AgentInputArea } from "@/components/agents/AgentInputArea";

export function AgentsView() {
  const launchTask = useAgentTaskStore((s) => s.launchTask);
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const inputMode = useAgentTaskStore((s) => s.inputMode);
  const setInputMode = useAgentTaskStore((s) => s.setInputMode);

  const projectPath = useLayoutStore((s) => s.projectPath);
  const [selectedAgent, setSelectedAgent] = useState<AgentCli>("claude-code");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleNewAgent = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const handleLaunch = useCallback(() => {
    const text = agentInputText.trim();
    if (!text) return;
    const path = selectedRepo ?? projectPath;
    const title = text.slice(0, 60);
    void launchTask(title, text, selectedAgent, path);
    setAgentInputText("");
  }, [agentInputText, selectedRepo, projectPath, selectedAgent, launchTask, setAgentInputText]);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        handleNewAgent();
      }
      if (e.key === "Tab" && document.activeElement === textareaRef.current) {
        e.preventDefault();
        setInputMode(inputMode === "plan" ? "build" : "plan");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewAgent, inputMode, setInputMode]);

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      <AgentSidebar onNewAgent={handleNewAgent} />
      <AgentInputArea
        textareaRef={textareaRef}
        selectedAgent={selectedAgent}
        onAgentChange={setSelectedAgent}
        onLaunch={handleLaunch}
      />
    </div>
  );
}
