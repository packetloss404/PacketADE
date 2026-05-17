import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useProfileStore } from "@/stores/profileStore";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { AuthStatus } from "@/components/ui/AuthBadge";
import { FileMentionPopover } from "./FileMentionPopover";
import { InputPopover, type InputPopoverItem } from "./InputPopover";
import { ContextPreviewChevron } from "./ContextPreviewChevron";
import { usePromptStore } from "@/stores/promptStore";
import type { PromptTemplate } from "@/types/prompt";
import type { AgentCli } from "@/stores/agentTaskStore";
import type { ImageAttachment } from "@/lib/tauri";
import { isSshUri } from "@/lib/ssh-uri";

import {
  COMPOSER_HELP_TEXT,
  SLASH_POPOVER_LIMIT,
  isSidecarAgent,
  templateSlug,
  type AgentMode,
  type ComposerMode,
} from "./composer/utils";
import { useAttachmentStaging } from "./hooks/useAttachmentStaging";
import { useProviderAuthStatus } from "./hooks/useProviderAuthStatus";
import { useOllamaModels } from "./hooks/useOllamaModels";
import { usePrefixMatcher } from "./hooks/usePrefixMatcher";
import { ProjectPicker } from "./composer/ProjectPicker";
import { ModeSelector } from "./composer/ModeSelector";
import { ProfilePicker } from "./composer/ProfilePicker";
import { ComposerModePicker } from "./composer/ComposerModePicker";
import { ProviderPicker } from "./composer/ProviderPicker";
import { ModelSelector } from "./composer/ModelSelector";
import { ActionButtons } from "./composer/ActionButtons";

// Re-export for callers (AgentsView imports these from this module).
export type { AgentMode, ComposerMode } from "./composer/utils";

interface AgentInputAreaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  /** Called when the user submits. Staged image attachments (drag-drop /
   * paste) are passed through; an empty array if none. */
  onLaunch: (attachments: ImageAttachment[]) => boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  selectedProfileId?: string;
  onProfileChange?: (id: string) => void;
  composerMode?: ComposerMode;
  onComposerModeChange?: (mode: ComposerMode) => void;
}

export function AgentInputArea({
  textareaRef,
  selectedAgent,
  onAgentChange,
  onLaunch,
  selectedModel,
  onModelChange,
  agentMode = "agent",
  onAgentModeChange,
  selectedProfileId,
  onProfileChange,
  composerMode = "local",
  onComposerModeChange,
}: AgentInputAreaProps) {
  const profiles = useProfileStore((s) => s.profiles);
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const setDefaultProfile = useProfileStore((s) => s.setDefaultProfile);
  const activeProfileId = selectedProfileId ?? defaultProfileId;
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  const agentInputText = useAgentTaskStore((s) => s.agentInputText);
  const setAgentInputText = useAgentTaskStore((s) => s.setAgentInputText);
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);

  // Sidecar (OAuth) providers route through the Node sidecar, which doesn't
  // speak SSH. The backend rejects ssh_config for these providers, so we
  // gate the SSH affordances in the UI to match.
  const sshDisabled = isSidecarAgent(selectedAgent);

  const { staged, addFiles, removeStaged, clear: clearStaged } =
    useAttachmentStaging();
  const [dragActive, setDragActive] = useState(false);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Functional setter — keeps `dragActive` out of deps so we don't
    // oscillate state / re-bind the listener every frame during a drag.
    setDragActive((cur) => (cur ? cur : true));
  }, []);

  const handleDragLeave = useCallback(() => setDragActive(false), []);

  // Single-flight guard: onLaunch returns synchronously while async work
  // (worktree provisioning, conversation creation) is still in flight, so
  // a second submit can race the first. The 500ms window blocks rapid
  // Enter/Send mashing without delaying legitimate quick consecutive submits.
  const submitInFlightRef = useRef(false);
  const submitWithAttachments = useCallback(() => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    const toSend = staged.map((s) => s.attachment);
    const accepted = onLaunch(toSend);
    if (accepted) {
      clearStaged();
    }
    window.setTimeout(() => {
      submitInFlightRef.current = false;
    }, 500);
  }, [onLaunch, staged, clearStaged]);

  const { isListening, transcript, startListening, stopListening, isSupported } =
    useVoiceInput();
  const prevTranscriptRef = useRef("");

  // Append voice transcript to input.
  useEffect(() => {
    if (transcript && transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = transcript;
      const current = useAgentTaskStore.getState().agentInputText;
      setAgentInputText(current + transcript);
    }
  }, [transcript, setAgentInputText]);

  const mentionProjectPath =
    selectedRepo && !isSshUri(selectedRepo) ? selectedRepo : "";

  // ─── Prefix-trigger pickers (@ mentions, / slash-commands) ───────────
  const mention = usePrefixMatcher("@");
  const slash = usePrefixMatcher("/");
  // The mention popover owns its directory scan; we keep a ref to the
  // current list so ArrowUp/Down/Enter can read it synchronously.
  const mentionItemsRef = useRef<string[]>([]);

  const promptTemplates = usePromptStore((s) => s.templates);
  const slashMatches = useMemo<PromptTemplate[]>(() => {
    if (!slash.state.active) return [];
    const q = slash.state.query.toLowerCase();
    if (!q) return promptTemplates.slice(0, SLASH_POPOVER_LIMIT);
    return promptTemplates
      .filter((t) => {
        const slug = templateSlug(t.name);
        return (
          slug.startsWith(q) ||
          slug.includes(q) ||
          t.name.toLowerCase().includes(q)
        );
      })
      .slice(0, SLASH_POPOVER_LIMIT);
  }, [promptTemplates, slash.state.active, slash.state.query]);

  const slashPopoverItems = useMemo<InputPopoverItem[]>(
    () =>
      slashMatches.map((t) => {
        const slug = templateSlug(t.name);
        const preview =
          t.content.length > 60 ? `${t.content.slice(0, 60)}…` : t.content;
        return {
          key: t.id,
          label: `/${slug}`,
          description: `${preview} · ${t.category}`,
        };
      }),
    [slashMatches],
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setAgentInputText(value);
      const caret = e.target.selectionStart ?? value.length;
      const mentionHit = mention.detect(value, caret);
      // Slash is suppressed while the mention popover is active so the two
      // triggers don't fight.
      if (!mentionHit) {
        slash.detect(value, caret);
      } else {
        slash.close();
      }
    },
    [setAgentInputText, mention, slash],
  );

  const handleMentionItemsChange = useCallback(
    (paths: string[]) => {
      mentionItemsRef.current = paths;
      mention.clampHighlight(paths.length);
    },
    [mention],
  );

  const insertMentionPath = useCallback(
    (path: string) => {
      const atIndex = mention.state.prefixIndex;
      if (atIndex < 0) return;
      const before = agentInputText.slice(0, atIndex);
      const caret =
        textareaRef.current?.selectionStart ?? agentInputText.length;
      const after = agentInputText.slice(caret);
      const inserted = `@${path} `;
      const next = `${before}${inserted}${after}`;
      setAgentInputText(next);
      const newCaret = before.length + inserted.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCaret, newCaret);
        }
      });
      mentionItemsRef.current = [];
      mention.close();
    },
    [agentInputText, setAgentInputText, textareaRef, mention],
  );

  /** Replace the `/query` token at the trigger position with the template's
   * body content and place the caret at the end of the inserted body. This
   * expands the prompt INTO the composer — it does not submit. */
  const insertSlashTemplate = useCallback(
    (template: PromptTemplate) => {
      const slashIdx = slash.state.prefixIndex;
      if (slashIdx < 0) return;
      const before = agentInputText.slice(0, slashIdx);
      const afterStart = slashIdx + 1 + slash.state.query.length;
      const after = agentInputText.slice(afterStart);
      // Trim trailing whitespace on the template body, leave user's `after`
      // content untouched to avoid double-newlines.
      const body = template.content.replace(/\s+$/, "");
      const next = `${before}${body}${after}`;
      setAgentInputText(next);
      const newCaret = before.length + body.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCaret, newCaret);
        }
      });
      slash.close();
    },
    [agentInputText, setAgentInputText, slash, textareaRef],
  );

  // ─── Provider auth + Ollama models hooks ─────────────────────────────
  const { authStatus, refreshAuthStatuses } = useProviderAuthStatus();
  const { ollamaModels, refresh: refreshOllamaModels } =
    useOllamaModels(selectedAgent);

  const selectedAuth = authStatus[selectedAgent];
  const selectedAuthStatus: AuthStatus =
    selectedAuth === "loading" || !selectedAuth
      ? "loading"
      : selectedAuth.status;
  const launchReady = selectedAuthStatus === "ready";
  const launchLabel =
    selectedAuthStatus === "coming_soon" ? "Coming soon" : "Launch";
  // Which provider (if any) needs an interactive login to become ready.
  const needsLogin: "claude" | "codex" | null =
    selectedAuthStatus === "login_required"
      ? selectedAgent === "api-claude-oauth"
        ? "claude"
        : selectedAgent === "api-openai-codex"
          ? "codex"
          : null
      : null;

  const handleOpenLogin = useCallback(() => {
    if (needsLogin === "claude") {
      window.dispatchEvent(new CustomEvent("packetade:open-claude-login"));
    } else if (needsLogin === "codex") {
      window.dispatchEvent(new CustomEvent("packetade:open-codex-login"));
    }
  }, [needsLogin]);

  const loginTooltip =
    needsLogin === "codex"
      ? "Log in to ChatGPT to continue"
      : "Log in to Claude to continue";

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Slash-command popover first — detect() closes itself if the trigger
    // no longer matches, so no orphan-state guard needed here.
    if (slash.state.active) {
      const items = slashMatches;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slash.moveHighlight(1, items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slash.moveHighlight(-1, items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          const pick = items[slash.state.highlightedIndex] ?? items[0];
          if (pick) insertSlashTemplate(pick);
          return;
        }
        slash.close();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        slash.close();
        return;
      }
    }

    if (mention.state.active) {
      const items = mentionItemsRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mention.moveHighlight(1, items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mention.moveHighlight(-1, items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          const pick = items[mention.state.highlightedIndex] ?? items[0];
          insertMentionPath(pick);
          return;
        }
        // No items — close and let Enter submit below.
        mention.close();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mention.close();
        return;
      }
    }

    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      if (launchReady) submitWithAttachments();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (launchReady) submitWithAttachments();
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[600px]">
        <ProjectPicker
          selectedRepo={selectedRepo}
          setSelectedRepo={setSelectedRepo}
          sshDisabled={sshDisabled}
        />

        {/* v0.8-H — preview of memory snippets injected into the next user
            turn. Hidden for SSH targets since memory is project-path-keyed
            and remote paths aren't a stable key here. */}
        {selectedRepo && !isSshUri(selectedRepo) && (
          <div className="mb-2">
            <ContextPreviewChevron projectPath={selectedRepo} />
          </div>
        )}

        <div
          className={`relative border rounded-lg bg-bg-primary transition-colors ${
            dragActive
              ? "border-accent-green ring-2 ring-accent-green/30"
              : "border-bg-border"
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {/* Popovers positioned above the textarea. */}
          <div className="relative">
            <FileMentionPopover
              visible={mention.state.active && !!mentionProjectPath}
              projectPath={mentionProjectPath}
              query={mention.state.query}
              highlightedIndex={mention.state.highlightedIndex}
              onSelect={insertMentionPath}
              onItemsChange={handleMentionItemsChange}
            />
            <InputPopover
              visible={slash.state.active}
              items={slashPopoverItems}
              highlightedIndex={slash.state.highlightedIndex}
              onSelect={(item) => {
                const t = promptTemplates.find((pt) => pt.id === item.key);
                if (t) insertSlashTemplate(t);
              }}
              emptyLabel="No matching templates"
            />
          </div>

          {staged.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {staged.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded border border-bg-border bg-bg-secondary text-[10px] text-text-secondary"
                  title={`${s.name} · ${(s.sizeBytes / 1024).toFixed(1)} KB`}
                >
                  <img
                    src={s.previewUrl}
                    alt=""
                    className="w-5 h-5 rounded object-cover"
                  />
                  <span className="truncate max-w-[140px]">{s.name}</span>
                  <button
                    type="button"
                    onClick={() => removeStaged(s.id)}
                    className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-accent-red"
                    title="Remove"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={agentInputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => {
              // Delay so onMouseDown selection in the popover can still fire.
              setTimeout(() => {
                mention.close();
                slash.close();
              }, 120);
            }}
            placeholder="What would you like to work on?  (drag-drop or paste images)"
            rows={4}
            className="w-full bg-transparent px-4 py-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
          />

          <div className="flex items-center justify-between px-3 py-2 border-t border-bg-border/50">
            <div className="flex items-center gap-2">
              <ModeSelector value={agentMode} onChange={onAgentModeChange} />
              <ProfilePicker
                profiles={profiles}
                selectedProfileId={selectedProfileId}
                activeProfile={activeProfile}
                onProfileChange={onProfileChange}
                setDefaultProfile={setDefaultProfile}
              />
              {selectedRepo && !isSshUri(selectedRepo) && (
                <ComposerModePicker
                  value={composerMode}
                  onChange={onComposerModeChange}
                />
              )}
              <ProviderPicker
                selectedAgent={selectedAgent}
                onAgentChange={onAgentChange}
                onModelChange={onModelChange}
                authStatus={authStatus}
                refreshAuthStatuses={refreshAuthStatuses}
                needsLogin={needsLogin}
                loginTooltip={loginTooltip}
                onOpenLogin={handleOpenLogin}
              />
              <ModelSelector
                selectedAgent={selectedAgent}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                ollamaModels={ollamaModels}
                refreshOllamaModels={refreshOllamaModels}
              />
            </div>

            <ActionButtons
              isSupported={isSupported}
              isListening={isListening}
              startListening={startListening}
              stopListening={stopListening}
              launchReady={launchReady}
              launchLabel={launchLabel}
              launchTitle={
                launchReady
                  ? "Launch (Enter)"
                  : needsLogin
                    ? loginTooltip
                    : selectedAuth && selectedAuth !== "loading"
                      ? selectedAuth.hint || launchLabel
                      : launchLabel
              }
              onLaunch={submitWithAttachments}
            />
          </div>
        </div>

        <p className="text-[9px] text-text-muted mt-2 text-center">
          {COMPOSER_HELP_TEXT}
        </p>
      </div>
    </div>
  );
}
