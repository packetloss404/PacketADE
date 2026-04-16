import { useRef, useEffect } from "react";
import { Monitor, Mic, Zap } from "lucide-react";
import { useAgentTaskStore, repoDisplayName } from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import type { AgentCli } from "@/stores/agentTaskStore";
import { API_PROVIDERS } from "@/lib/api-models";

interface AgentInputAreaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  onLaunch: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
}

export function AgentInputArea({ textareaRef, selectedAgent, onAgentChange, onLaunch, selectedModel, onModelChange }: AgentInputAreaProps) {
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const repos = useGitHubStore((s) => s.repos);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const { isListening, transcript, startListening, stopListening, isSupported } = useVoiceInput();
  const prevTranscriptRef = useRef("");

  // Append voice transcript to input
  useEffect(() => {
    if (transcript && transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = transcript;
      const current = useAgentTaskStore.getState().agentInputText;
      setAgentInputText(current + transcript);
    }
  }, [transcript, setAgentInputText]);

  // Collect unique project paths for the repo selector
  const conversations = useAgentTaskStore((s) => s.conversations);
  const repoPaths = Array.from(
    new Set([projectPath, ...conversations.map((c) => c.projectPath)].filter(Boolean))
  );

  const currentRepoPath = selectedRepo ?? projectPath;
  const currentDisplayName = repoDisplayName(currentRepoPath, repos);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      onLaunch();
    }
    // Enter without shift also sends
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onLaunch();
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[600px]">
        {/* Header */}
        <div className="flex items-center gap-2 mb-6">
          <Zap size={16} className="text-accent-amber" />
          <h2 className="text-sm font-medium text-text-primary">New Agent</h2>
        </div>

        {/* Repo selector */}
        <div className="mb-3">
          <Dropdown
            trigger={
              <span className="flex items-center gap-1.5 text-text-primary">
                <Monitor size={12} className="text-text-muted" />
                {currentDisplayName}
              </span>
            }
          >
            {repoPaths.map((path) => (
              <DropdownItem key={path} onClick={() => setSelectedRepo(path)}>
                {repoDisplayName(path, repos)}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>

        {/* Input box */}
        <div className="relative border border-bg-border rounded-lg bg-bg-primary">
          <textarea
            ref={textareaRef}
            value={agentInputText}
            onChange={(e) => setAgentInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What would you like to work on?"
            rows={4}
            className="w-full bg-transparent px-4 py-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
          />

          {/* Action row inside the input box */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-bg-border/50">
            <div className="flex items-center gap-2">
              {/* Provider selector */}
              <Dropdown
                trigger={
                  <span className="text-text-secondary flex items-center gap-1">
                    <Zap size={10} className="text-accent-amber" />
                    {API_PROVIDERS.find((p) => p.agentCli === selectedAgent)?.name ?? "Select Provider"}
                  </span>
                }
              >
                {API_PROVIDERS.map((p) => (
                  <DropdownItem key={p.agentCli} onClick={() => {
                    onAgentChange(p.agentCli);
                    onModelChange(p.models[0]?.value ?? "");
                  }}>
                    <span className="flex items-center gap-1.5">
                      <Zap size={10} className="text-accent-amber" />
                      {p.name}
                    </span>
                  </DropdownItem>
                ))}
              </Dropdown>

              {/* Model selector */}
              {(() => {
                const provider = API_PROVIDERS.find((p) => p.agentCli === selectedAgent);
                if (!provider) return null;
                const currentModel = provider.models.find((m) => m.value === selectedModel) ?? provider.models[0];
                return (
                  <Dropdown
                    trigger={
                      <span className="text-text-muted text-[10px]">
                        {currentModel?.label ?? "Select model"}
                      </span>
                    }
                  >
                    {provider.models.map((m) => (
                      <DropdownItem key={m.value} onClick={() => onModelChange(m.value)}>
                        {m.label}
                      </DropdownItem>
                    ))}
                  </Dropdown>
                );
              })()}
            </div>

            {/* Mic button */}
            {isSupported && (
              <button
                onClick={isListening ? stopListening : startListening}
                className={`p-1.5 rounded-full transition-colors ${
                  isListening
                    ? "bg-accent-green/20 text-accent-green animate-pulse"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                title={isListening ? "Stop listening" : "Voice input"}
              >
                <Mic size={14} />
              </button>
            )}
          </div>
        </div>

        <p className="text-[9px] text-text-muted mt-2 text-center">
          Enter to send &middot; Shift+Enter for newline &middot; Ctrl+N for new agent
        </p>
      </div>
    </div>
  );
}
