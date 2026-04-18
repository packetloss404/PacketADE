import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import {
  Monitor,
  Mic,
  Zap,
  Sparkles,
  FolderOpen,
  Folder,
  Server,
  Check,
  Bot,
  MessageCircle,
  Hand,
  Layers,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAgentTaskStore, repoDisplayName } from "@/stores/agentTaskStore";
import { useGitHubStore } from "@/stores/githubStore";
import { useProfileStore } from "@/stores/profileStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { useSshTargetStore } from "@/stores/sshTargetStore";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { FileMentionPopover } from "./FileMentionPopover";
import { SshConnectModal } from "./SshConnectModal";
import type { AgentCli } from "@/stores/agentTaskStore";
import { API_PROVIDERS } from "@/lib/api-models";
import {
  isSshUri,
  makeSshUri,
  parseSshTargetId,
  type SshTarget,
} from "@/types/ssh";

/** Cursor-style launch modes. */
export type AgentMode = "agent" | "ask" | "manual" | "plan";

const MODE_META: Record<AgentMode, { label: string; description: string; icon: React.ComponentType<{ size?: number; className?: string }>; color: string }> = {
  agent: {
    label: "Agent",
    description: "Full tools — read, write, run commands",
    icon: Bot,
    color: "text-accent-green",
  },
  ask: {
    label: "Ask",
    description: "Read-only — no edits or commands",
    icon: MessageCircle,
    color: "text-accent-blue",
  },
  manual: {
    label: "Manual",
    description: "Every risky tool requires your approval",
    icon: Hand,
    color: "text-accent-amber",
  },
  plan: {
    label: "Plan",
    description: "Produce a structured plan first, then execute",
    icon: Layers,
    color: "text-accent-purple",
  },
};

const MODE_ORDER: AgentMode[] = ["agent", "ask", "manual", "plan"];

interface AgentInputAreaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  onLaunch: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  selectedProfileId?: string;
  onProfileChange?: (profileId: string) => void;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
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
  agentMode = "agent",
  onAgentModeChange,
}: AgentInputAreaProps) {
  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const repos = useGitHubStore((s) => s.repos);
  const projectHistory = useProjectHistoryStore((s) => s.projects);
  const recordOpenProject = useProjectHistoryStore((s) => s.recordOpen);
  const sshTargets = useSshTargetStore((s) => s.targets);
  const touchSshTarget = useSshTargetStore((s) => s.touchTarget);

  const [sshModalOpen, setSshModalOpen] = useState(false);

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

  type RecentItem =
    | { kind: "local"; path: string; ts: number }
    | { kind: "ssh"; target: SshTarget; ts: number };

  const recentItems: RecentItem[] = useMemo(() => {
    const localSeen = new Set<string>();
    const local: RecentItem[] = [];
    for (const p of projectHistory) {
      if (!p.path || localSeen.has(p.path)) continue;
      localSeen.add(p.path);
      local.push({ kind: "local", path: p.path, ts: p.lastOpened });
    }
    const ssh: RecentItem[] = sshTargets.map((t) => ({
      kind: "ssh",
      target: t,
      ts: t.lastUsed ?? t.createdAt,
    }));
    return [...local, ...ssh].sort((a, b) => b.ts - a.ts);
  }, [projectHistory, sshTargets]);

  const currentDisplayName = useMemo(() => {
    if (!selectedRepo) return "Select a project";
    if (isSshUri(selectedRepo)) {
      const id = parseSshTargetId(selectedRepo);
      const target = id ? sshTargets.find((t) => t.id === id) : undefined;
      return target ? target.name : "SSH target";
    }
    return repoDisplayName(selectedRepo, repos);
  }, [selectedRepo, repos, sshTargets]);

  const mentionProjectPath =
    selectedRepo && !isSshUri(selectedRepo) ? selectedRepo : "";

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) {
        setSelectedRepo(picked);
        recordOpenProject(picked);
      }
    } catch (err) {
      console.warn("Folder picker failed:", err);
    }
  }, [setSelectedRepo, recordOpenProject]);

  const handleSelectLocal = useCallback(
    (path: string) => {
      setSelectedRepo(path);
    },
    [setSelectedRepo],
  );

  const handleSelectSsh = useCallback(
    (targetId: string) => {
      setSelectedRepo(makeSshUri(targetId));
      touchSshTarget(targetId);
    },
    [setSelectedRepo, touchSshTarget],
  );

  const handleSshConnected = useCallback(
    (target: SshTarget) => {
      setSelectedRepo(makeSshUri(target.id));
      setSshModalOpen(false);
    },
    [setSelectedRepo],
  );

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
        {/* Repo selector */}
        <div className="mb-3">
          <Dropdown
            trigger={
              <span
                className={`flex items-center gap-1.5 ${
                  selectedRepo ? "text-text-primary" : "text-text-muted"
                }`}
              >
                {selectedRepo && isSshUri(selectedRepo) ? (
                  <Server size={12} className="text-accent-green" />
                ) : (
                  <Monitor size={12} className="text-text-muted" />
                )}
                {currentDisplayName}
              </span>
            }
          >
            {recentItems.length > 0 && (
              <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-text-muted">
                Recents
              </div>
            )}
            {recentItems.map((item) =>
              item.kind === "local" ? (
                <DropdownItem
                  key={`local:${item.path}`}
                  onClick={() => handleSelectLocal(item.path)}
                >
                  <RecentRow
                    icon={<Folder size={12} className="text-text-muted" />}
                    label={repoDisplayName(item.path, repos)}
                    selected={selectedRepo === item.path}
                  />
                </DropdownItem>
              ) : (
                <DropdownItem
                  key={`ssh:${item.target.id}`}
                  onClick={() => handleSelectSsh(item.target.id)}
                >
                  <RecentRow
                    icon={<Server size={12} className="text-accent-green" />}
                    label={item.target.name}
                    selected={selectedRepo === makeSshUri(item.target.id)}
                  />
                </DropdownItem>
              ),
            )}

            {recentItems.length > 0 && (
              <div className="my-1 border-t border-bg-border" />
            )}

            <DropdownItem onClick={handleBrowse}>
              <span className="flex items-center gap-1.5 text-text-secondary">
                <FolderOpen size={12} />
                Open Folder
              </span>
            </DropdownItem>
            <DropdownItem onClick={() => setSshModalOpen(true)}>
              <span className="flex items-center gap-1.5 text-text-secondary">
                <Server size={12} />
                Connect SSH
              </span>
            </DropdownItem>
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
              {/* Mode selector — Cursor-style Agent / Ask / Manual / Plan */}
              <Dropdown
                trigger={
                  <span className="text-text-secondary flex items-center gap-1">
                    {(() => {
                      const m = MODE_META[agentMode];
                      const Icon = m.icon;
                      return (
                        <>
                          <Icon size={10} className={m.color} />
                          {m.label}
                        </>
                      );
                    })()}
                  </span>
                }
              >
                {MODE_ORDER.map((m) => {
                  const meta = MODE_META[m];
                  const Icon = meta.icon;
                  return (
                    <DropdownItem
                      key={m}
                      onClick={() => onAgentModeChange?.(m)}
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon size={10} className={meta.color} />
                        <span className={agentMode === m ? "text-accent-green" : ""}>
                          {meta.label}
                        </span>
                        <span className="text-text-muted text-[9px] ml-1">
                          {meta.description}
                        </span>
                      </span>
                    </DropdownItem>
                  );
                })}
              </Dropdown>

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

      {sshModalOpen && (
        <SshConnectModal
          onClose={() => setSshModalOpen(false)}
          onConnected={handleSshConnected}
        />
      )}
    </div>
  );
}

function RecentRow({
  icon,
  label,
  selected,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {selected && <Check size={12} className="text-accent-green shrink-0" />}
    </div>
  );
}
