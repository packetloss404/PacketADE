import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { Monitor, Mic, Zap, Sparkles } from "lucide-react";
import { useAgentTaskStore, repoDisplayName } from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useProfileStore } from "@/stores/profileStore";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { FileMentionPopover } from "./FileMentionPopover";
import type { AgentCli } from "@/stores/agentTaskStore";
import { API_PROVIDERS } from "@/lib/api-models";

interface AgentInputAreaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  onLaunch: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  selectedProfileId?: string;
  onProfileChange?: (profileId: string) => void;
}

interface MentionState {
  active: boolean;
  query: string;
  // @-sign position in the textarea value (character index)
  atIndex: number;
  highlightedIndex: number;
}

const INITIAL_MENTION_STATE: MentionState = {
  active: false,
  query: "",
  atIndex: -1,
  highlightedIndex: 0,
};

export function AgentInputArea({
  textareaRef,
  selectedAgent,
  onAgentChange,
  onLaunch,
  selectedModel,
  onModelChange,
  selectedProfileId,
  onProfileChange,
}: AgentInputAreaProps) {
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const repos = useGitHubStore((s) => s.repos);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const profiles = useProfileStore((s) => s.profiles);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const effectiveProfileId =
    selectedProfileId ?? activeProfileId ?? profiles[0]?.id ?? "";
  const activeProfile = profiles.find((p) => p.id === effectiveProfileId);

  const { isListening, transcript, startListening, stopListening, isSupported } =
    useVoiceInput();
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
    new Set(
      [projectPath, ...conversations.map((c) => c.projectPath)].filter(Boolean),
    ),
  );

  const currentRepoPath = selectedRepo ?? projectPath;
  const currentDisplayName = repoDisplayName(currentRepoPath, repos);

  // Project path for file-mention search. Fall back to layout projectPath.
  const mentionProjectPath = selectedRepo || projectPath || "";

  // ─── @ file-mention state ─────────────────────────────────────────────
  const [mentionState, setMentionState] = useState<MentionState>(
    INITIAL_MENTION_STATE,
  );
  // Items are owned by the popover; we track the currently-rendered list
  // here via a ref so ArrowUp/Down/Enter can read them synchronously.
  const mentionItemsRef = useRef<string[]>([]);

  const closeMention = useCallback(() => {
    setMentionState(INITIAL_MENTION_STATE);
    mentionItemsRef.current = [];
  }, []);

  /**
   * Given the current text value and caret index, detect whether the caret
   * is inside an @-mention token (i.e. there's an '@' preceded by start-of-
   * input or whitespace, with no whitespace/newline between it and the caret).
   */
  function detectMention(
    value: string,
    caret: number,
  ): { atIndex: number; query: string } | null {
    // Scan backward from the caret looking for '@'.
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i === 0 ? "" : value[i - 1];
        if (i === 0 || /\s/.test(prev)) {
          return { atIndex: i, query: value.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
    }
    return null;
  }

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setAgentInputText(value);
      const caret = e.target.selectionStart ?? value.length;
      const hit = detectMention(value, caret);
      if (hit) {
        setMentionState((prev) => ({
          active: true,
          query: hit.query,
          atIndex: hit.atIndex,
          // Reset highlight when the query changes.
          highlightedIndex:
            prev.active && prev.query === hit.query ? prev.highlightedIndex : 0,
        }));
      } else if (mentionState.active) {
        closeMention();
      }
    },
    [setAgentInputText, mentionState.active, closeMention],
  );

  const handleMentionItemsChange = useCallback((paths: string[]) => {
    mentionItemsRef.current = paths;
    setMentionState((prev) => {
      if (!prev.active) return prev;
      if (prev.highlightedIndex >= paths.length) {
        return { ...prev, highlightedIndex: 0 };
      }
      return prev;
    });
  }, []);

  const insertMentionPath = useCallback(
    (path: string) => {
      setMentionState((prev) => {
        const before = agentInputText.slice(0, prev.atIndex);
        const caret =
          textareaRef.current?.selectionStart ?? agentInputText.length;
        const after = agentInputText.slice(caret);
        const inserted = `@${path} `;
        const next = `${before}${inserted}${after}`;
        setAgentInputText(next);
        // Re-focus textarea and place caret right after the inserted chunk.
        const newCaret = before.length + inserted.length;
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(newCaret, newCaret);
          }
        });
        mentionItemsRef.current = [];
        return INITIAL_MENTION_STATE;
      });
    },
    [agentInputText, setAgentInputText, textareaRef],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // If mention popover is open, intercept navigation keys first.
    if (mentionState.active) {
      const items = mentionItemsRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          highlightedIndex:
            items.length === 0 ? 0 : (prev.highlightedIndex + 1) % items.length,
        }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          highlightedIndex:
            items.length === 0
              ? 0
              : (prev.highlightedIndex - 1 + items.length) % items.length,
        }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          const pick = items[mentionState.highlightedIndex] ?? items[0];
          insertMentionPath(pick);
          return;
        }
        // If no items, just close the popover and let Enter submit below.
        closeMention();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      onLaunch();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onLaunch();
    }
  }

  // Render profile dropdown label with icon.
  const profileTrigger = useMemo(
    () => (
      <span className="text-text-secondary flex items-center gap-1">
        <Sparkles size={12} className={activeProfile?.color ?? "text-accent-green"} />
        {activeProfile?.name ?? "Profile"}
      </span>
    ),
    [activeProfile?.color, activeProfile?.name],
  );

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
          {/* @ file-mention popover (positioned above the textarea) */}
          <div className="relative">
            <FileMentionPopover
              visible={mentionState.active && !!mentionProjectPath}
              projectPath={mentionProjectPath}
              query={mentionState.query}
              highlightedIndex={mentionState.highlightedIndex}
              onSelect={insertMentionPath}
              onItemsChange={handleMentionItemsChange}
            />
          </div>

          <textarea
            ref={textareaRef}
            value={agentInputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Delay so onMouseDown selection in the popover can still fire.
              setTimeout(() => closeMention(), 120);
            }}
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
                    {API_PROVIDERS.find((p) => p.agentCli === selectedAgent)
                      ?.name ?? "Select Provider"}
                  </span>
                }
              >
                {API_PROVIDERS.map((p) => (
                  <DropdownItem
                    key={p.agentCli}
                    onClick={() => {
                      onAgentChange(p.agentCli);
                      onModelChange(p.models[0]?.value ?? "");
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <Zap size={10} className="text-accent-amber" />
                      {p.name}
                    </span>
                  </DropdownItem>
                ))}
              </Dropdown>

              {/* Model selector */}
              {(() => {
                const provider = API_PROVIDERS.find(
                  (p) => p.agentCli === selectedAgent,
                );
                if (!provider) return null;
                const currentModel =
                  provider.models.find((m) => m.value === selectedModel) ??
                  provider.models[0];
                return (
                  <Dropdown
                    trigger={
                      <span className="text-text-muted text-[10px]">
                        {currentModel?.label ?? "Select model"}
                      </span>
                    }
                  >
                    {provider.models.map((m) => (
                      <DropdownItem
                        key={m.value}
                        onClick={() => onModelChange(m.value)}
                      >
                        {m.label}
                      </DropdownItem>
                    ))}
                  </Dropdown>
                );
              })()}

              {/* Profile selector */}
              <Dropdown trigger={profileTrigger}>
                {profiles.map((p) => (
                  <DropdownItem
                    key={p.id}
                    onClick={() => onProfileChange?.(p.id)}
                  >
                    <span className="flex items-center gap-1.5">
                      <Sparkles
                        size={10}
                        className={p.color ?? "text-accent-green"}
                      />
                      {p.name}
                    </span>
                  </DropdownItem>
                ))}
              </Dropdown>
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
          Enter to send &middot; Shift+Enter for newline &middot; Ctrl+N for new
          agent &middot; @ to mention a file
        </p>
      </div>
    </div>
  );
}
