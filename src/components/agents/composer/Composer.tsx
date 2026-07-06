import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Mic, Send, Square, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import { useProfileStore } from "@/stores/profileStore";
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { ImageAttachment } from "@/lib/tauri";
import type { AuthStatus } from "@/components/ui/AuthBadge";
import { isSshUri } from "@/lib/ssh-uri";
import { FileMentionPopover } from "../FileMentionPopover";
import { InputPopover } from "../InputPopover";
import { CancelPendingButton } from "../chat/CancelPendingButton";
import { usePrefixMatcher } from "../hooks/usePrefixMatcher";
import { useAttachmentStaging } from "../hooks/useAttachmentStaging";
import { useProviderAuthStatus } from "../hooks/useProviderAuthStatus";
import { useOllamaModels } from "../hooks/useOllamaModels";
import { useProjectSlashCommands } from "../hooks/useProjectSlashCommands";
import { useVoiceTranscript } from "../hooks/useVoiceTranscript";
import { ProjectPicker } from "./ProjectPicker";
import { ModeSelector } from "./ModeSelector";
import { ProfilePicker } from "./ProfilePicker";
import { ComposerModePicker } from "./ComposerModePicker";
import { ProviderPicker } from "./ProviderPicker";
import { ModelSelector } from "./ModelSelector";
import { ActionButtons } from "./ActionButtons";
import { AdvancedAccordion } from "./AdvancedAccordion";
import {
  COMPOSER_HELP_TEXT,
  MODE_META,
  type AgentMode,
  type ComposerMode,
} from "./utils";
import { buildComposerKeyboardHandler } from "./buildComposerKeyboardHandler";
import {
  buildSlashItems,
  templatesToSlashDefs,
  type SlashItem,
} from "./slashCommandSource";
import { slashCommandHandlers } from "./slashCommandHandlers";

export interface LaunchComposerProps {
  variant: "launch";
  /** Owned by the caller so AgentsView can focus the box (Ctrl+N / New agent). */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedAgent: AgentCli;
  onAgentChange: (agent: AgentCli) => void;
  /** Called when the user submits with the composed text + staged image
   * attachments. Return true to accept (clears the staged attachments; the
   * caller clears the launch draft once the async launch succeeds so a
   * failed launch keeps the prompt for a retry). */
  onLaunch: (text: string, attachments: ImageAttachment[]) => boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  selectedProfileId?: string;
  onProfileChange?: (id: string) => void;
  composerMode?: ComposerMode;
  onComposerModeChange?: (mode: ComposerMode) => void;
}

export interface ChatComposerProps {
  variant: "chat";
  conversationId: string;
  conversation: AgentConversation;
  /** Pending permission+edit approvals — drives the cancel-pending button. */
  pendingApprovalCount: number;
  onCancelPending: () => void;
  /** Shift+Tab mode-chip cycle (owned by the chat pane / header chip). */
  onCycleMode: () => void;
}

export type ComposerProps = LaunchComposerProps | ChatComposerProps;

/**
 * THE composer. One component with a launch/chat variant prop, replacing the
 * two parallel implementations (AgentInputArea + the AgentChatPane inline
 * composer). Both variants share ONE trigger system (usePrefixMatcher +
 * InputPopover/FileMentionPopover), ONE slash-command source of truth
 * (buildSlashItems feeds the popover AND the keyboard handler), ONE keyboard
 * handler, and the same attachment staging — so `@` and `/` behave
 * identically whether you're launching an agent or replying to one.
 *
 * Variant differences that remain are inherent to the moment:
 * - launch: project/provider/model/mode pickers, auth-gated Launch button,
 *   no conversation history to recall.
 * - chat: builtin slash commands (they act on the live conversation),
 *   shell-style ↑/↓ history, Shift+Tab mode cycle, Stop-while-streaming.
 */
export function Composer(props: ComposerProps) {
  const isChat = props.variant === "chat";
  const launch = props.variant === "launch" ? props : undefined;
  const conversation = isChat ? props.conversation : undefined;
  const conversationId = isChat ? props.conversationId : "";

  // ─── Draft text — always in the per-conversation draft store ─────────
  const draftKey = isChat ? conversationId : LAUNCH_DRAFT_KEY;
  const input = useAgentDraftStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useAgentDraftStore((s) => s.setDraft);
  const setInput = useCallback(
    (text: string) => setDraft(draftKey, text),
    [draftKey, setDraft],
  );

  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = launch ? launch.textareaRef : internalTextareaRef;

  // ─── Store wiring ─────────────────────────────────────────────────────
  const selectedRepo = useAgentTaskStore((s) => s.selectedRepo);
  const setSelectedRepo = useAgentTaskStore((s) => s.setSelectedRepo);
  const chatActions = useAgentTaskStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      cancelActiveConversation: s.cancelActiveConversation,
      createApiConversation: s.createApiConversation,
      selectConversation: s.selectConversation,
      setPlanMode: s.setPlanMode,
    })),
  );
  const setActiveView = useAppStore((s) => s.setActiveView);
  const profiles = useProfileStore((s) => s.profiles);
  const defaultProfileId = useProfileStore((s) => s.defaultProfileId);
  const setDefaultProfile = useProfileStore((s) => s.setDefaultProfile);
  const reviewerProfile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === "builtin-reviewer"),
  );
  const activeProfileId = launch?.selectedProfileId ?? defaultProfileId;
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  // ─── Attachment staging (paste / drag-drop) — both variants ──────────
  const { staged, addFiles, removeStaged, clear: clearStaged } =
    useAttachmentStaging();
  const [dragActive, setDragActive] = useState(false);
  // Enter/leave depth counter so the drag border doesn't flicker off when the
  // pointer crosses into nested children (textarea, staged chips, popovers).
  const dragDepthRef = useRef(0);

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
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void addFiles(files);
    },
    [addFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  // dragover must preventDefault for the drop to fire, but doesn't touch the
  // depth counter — enter/leave own the active state.
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  // ─── Voice input ──────────────────────────────────────────────────────
  const appendToInput = useCallback(
    (chunk: string) => {
      const current = useAgentDraftStore.getState().drafts[draftKey] ?? "";
      setDraft(draftKey, current + chunk);
    },
    [draftKey, setDraft],
  );
  const voice = useVoiceTranscript(appendToInput);

  // ─── Prefix-trigger pickers (@ mentions, / slash-commands) ───────────
  const mention = usePrefixMatcher("@");
  const slash = usePrefixMatcher("/");
  // The mention popover owns its directory scan; we keep a ref to the
  // current list so ArrowUp/Down/Enter can read it synchronously.
  const mentionItemsRef = useRef<string[]>([]);

  // Launch mentions/commands come from the picked project (local only —
  // memory/file scans are project-path-keyed and remote paths aren't a
  // stable key here); chat uses the conversation's own project path.
  const mentionProjectPath = isChat
    ? (conversation?.projectPath ?? "")
    : selectedRepo && !isSshUri(selectedRepo)
      ? selectedRepo
      : "";

  const promptTemplates = usePromptStore((s) => s.templates);
  const templateDefs = useMemo(
    () => templatesToSlashDefs(promptTemplates),
    [promptTemplates],
  );
  const { customSlashCommands, userSkills } =
    useProjectSlashCommands(mentionProjectPath);
  const allCustomSlashCommands = useMemo(
    () => [...customSlashCommands, ...templateDefs],
    [customSlashCommands, templateDefs],
  );

  // THE slash list — rendered by the popover and resolved by the keyboard
  // handler, so the two can never disagree.
  const slashItems = useMemo<SlashItem[]>(
    () =>
      slash.state.active
        ? buildSlashItems(slash.state.query, {
            includeBuiltins: isChat,
            customCommands: allCustomSlashCommands,
            userSkills,
          })
        : [],
    [slash.state.active, slash.state.query, isChat, allCustomSlashCommands, userSkills],
  );
  const clampSlashHighlight = slash.clampHighlight;
  useEffect(() => {
    clampSlashHighlight(slashItems.length);
  }, [slashItems.length, clampSlashHighlight]);

  const detectTriggers = useCallback(
    (value: string, caret: number) => {
      const mentionHit = mention.detect(value, caret);
      // Slash is suppressed while the mention popover is active so the two
      // triggers don't fight.
      if (!mentionHit) {
        slash.detect(value, caret);
      } else {
        slash.close();
      }
    },
    [mention, slash],
  );

  // ─── Chat prompt history (↑/↓ recall) ────────────────────────────────
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historySourceRef = useRef<"user" | "history">("user");
  const messages = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages],
  );
  const turnCount = useMemo(
    () => messages.filter((m) => m.role === "user").length,
    [messages],
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);
      const caret = e.target.selectionStart ?? value.length;
      detectTriggers(value, caret);
      if (historySourceRef.current === "history") {
        historySourceRef.current = "user";
      } else if (historyIndex !== -1) {
        setHistoryIndex(-1);
      }
    },
    [setInput, detectTriggers, historyIndex],
  );

  // Re-detect on caret movement (arrow keys, clicks) so the popovers track
  // the token under the caret, not just the last edit.
  const handleSelectionChange = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? ta.value.length;
    detectTriggers(ta.value, caret);
  }, [textareaRef, detectTriggers]);

  const handleBlur = useCallback(() => {
    // Delay so onMouseDown selection in the popover can still fire.
    setTimeout(() => {
      mention.close();
      slash.close();
    }, 120);
  }, [mention, slash]);

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
      const before = input.slice(0, atIndex);
      const caret = textareaRef.current?.selectionStart ?? input.length;
      const after = input.slice(caret);
      const inserted = `@${path} `;
      const next = `${before}${inserted}${after}`;
      setInput(next);
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
    [input, setInput, textareaRef, mention],
  );

  /** Resolve a picked slash item. Builtins run immediately (they're actions
   * on the live conversation); body-carrying commands (templates, custom
   * commands, skills) expand INTO the composer at the trigger position —
   * identically in both variants — so the user can append arguments/details
   * before Enter sends (chat) or launches (launch). */
  const pickSlashItem = useCallback(
    (item: SlashItem) => {
      const slashIdx = slash.state.prefixIndex;
      if (slashIdx < 0) return;
      const before = input.slice(0, slashIdx);
      const afterStart = slashIdx + 1 + slash.state.query.length;
      const after = input.slice(afterStart);
      slash.close();

      const sel = item.selection;
      if (sel.kind === "builtin") {
        setInput((before + after).trim());
        if (isChat && conversation) {
          const handler = slashCommandHandlers[sel.name];
          if (handler) {
            handler({
              conversationId,
              conversation,
              setPlanMode: chatActions.setPlanMode,
              createApiConversation: chatActions.createApiConversation,
              selectConversation: chatActions.selectConversation,
              setActiveView,
              reviewerProfile,
            });
          }
        }
        return;
      }

      // Trim trailing whitespace on the body, leave the user's `after`
      // content untouched to avoid double-newlines.
      const body = sel.def.body.replace(/\s+$/, "");
      const next = `${before}${body}${after}`;
      setInput(next);
      const newCaret = before.length + body.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCaret, newCaret);
        }
      });
    },
    [
      slash,
      input,
      setInput,
      isChat,
      conversation,
      conversationId,
      chatActions,
      setActiveView,
      reviewerProfile,
      textareaRef,
    ],
  );

  // ─── Provider auth + Ollama models (launch variant only) ─────────────
  const { authStatus, refreshAuthStatuses } = useProviderAuthStatus(!isChat);
  const { ollamaModels, refresh: refreshOllamaModels } = useOllamaModels(
    launch?.selectedAgent ?? "",
  );

  const selectedAuth = launch ? authStatus[launch.selectedAgent] : undefined;
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
      ? launch?.selectedAgent === "api-claude-oauth"
        ? "claude"
        : launch?.selectedAgent === "api-openai-codex"
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

  // ─── Submit ───────────────────────────────────────────────────────────
  // Single-flight guard (launch): onLaunch returns synchronously while async
  // work (worktree provisioning, conversation creation) is still in flight,
  // so a second submit can race the first. The 500ms window blocks rapid
  // Enter/Send mashing without delaying legitimate quick consecutive submits.
  const submitInFlightRef = useRef(false);
  const submitLaunch = useCallback(() => {
    if (!launch || !launchReady) return;
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    const toSend = staged.map((s) => s.attachment);
    const accepted = launch.onLaunch(input, toSend);
    if (accepted) {
      clearStaged();
    }
    window.setTimeout(() => {
      submitInFlightRef.current = false;
    }, 500);
  }, [launch, launchReady, staged, input, clearStaged]);

  const isActive = conversation?.status === "active";

  const submitChat = useCallback(() => {
    if (!isChat || !conversation) return;
    const text = input.trim();
    if (!text) return;
    // While a turn is streaming the store QUEUES the text (protected
    // queued-send-while-streaming behavior) — queued messages carry no
    // attachments, so keep any staged images for the next live send
    // instead of silently dropping them.
    const streaming =
      conversation.status === "active" &&
      conversation.messages.some((m) => m.isStreaming);
    const attachments = streaming ? null : staged.map((s) => s.attachment);
    setInput("");
    mention.close();
    slash.close();
    setHistoryIndex(-1);
    if (!streaming) clearStaged();
    chatActions.sendMessage(
      conversationId,
      text,
      attachments && attachments.length > 0 ? attachments : null,
    );
  }, [
    isChat,
    conversation,
    input,
    staged,
    setInput,
    mention,
    slash,
    clearStaged,
    chatActions,
    conversationId,
  ]);

  const submit = isChat ? submitChat : submitLaunch;

  const handleStop = useCallback(() => {
    void chatActions.cancelActiveConversation(conversationId);
  }, [chatActions, conversationId]);

  // ─── Keyboard handler — ONE for both variants ────────────────────────
  const handleKeyDown = buildComposerKeyboardHandler({
    textareaRef,
    input,
    setInput,
    mention,
    getMentionItems: () => mentionItemsRef.current,
    insertMentionPath,
    slash,
    slashItems,
    pickSlashItem,
    submit,
    history: isChat
      ? { messages, historyIndex, setHistoryIndex, historySourceRef }
      : undefined,
    cycleMode: isChat ? props.onCycleMode : undefined,
  });

  // Auto-resize the chat textarea (launch uses a fixed 4-row box).
  useEffect(() => {
    if (!isChat) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [isChat, input, textareaRef]);

  // ─── Shared pieces ────────────────────────────────────────────────────
  const popovers = (
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
        items={slashItems}
        highlightedIndex={slash.state.highlightedIndex}
        onSelect={(item) => {
          const match = slashItems.find((si) => si.key === item.key);
          if (match) pickSlashItem(match);
        }}
        emptyLabel="No matching commands"
      />
    </div>
  );

  const stagedChips = staged.length > 0 && (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2">
      {staged.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded bg-bg-secondary text-meta text-text-secondary"
        >
          <Tooltip
            content={`${s.name} · ${(s.sizeBytes / 1024).toFixed(1)} KB`}
          >
            <span className="flex items-center gap-1.5">
              <img
                src={s.previewUrl}
                alt=""
                className="w-5 h-5 rounded object-cover"
              />
              <span className="truncate max-w-[140px]">{s.name}</span>
            </span>
          </Tooltip>
          <Tooltip content="Remove">
            <button
              type="button"
              aria-label="Remove"
              onClick={() => removeStaged(s.id)}
              className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-accent-red"
            >
              <X size={9} />
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );

  const textarea = (
    <textarea
      ref={textareaRef}
      value={input}
      onChange={handleTextChange}
      onKeyDown={handleKeyDown}
      onKeyUp={handleSelectionChange}
      onClick={handleSelectionChange}
      onPaste={handlePaste}
      onBlur={handleBlur}
      placeholder={
        isChat ? "Send a message..." : "What would you like to work on?"
      }
      rows={isChat ? 1 : 4}
      className={
        isChat
          ? "flex-1 resize-none bg-transparent text-xs leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
          : "w-full bg-transparent px-4 py-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
      }
    />
  );

  // ─── Chat variant shell ───────────────────────────────────────────────
  if (isChat) {
    return (
      <div
        className="relative shrink-0 border-t border-bg-border bg-bg-primary px-3 py-2"
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {historyIndex >= 0 && (
          <div className="pointer-events-none absolute right-3 top-1 inline-flex select-none items-center gap-0.5 font-mono text-meta text-text-faint">
            <ChevronUp size={10} />
            {historyIndex + 1}/{turnCount}
          </div>
        )}

        <div className="relative">
          {popovers}
          <div
            className={`rounded border bg-bg-primary transition-colors ${
              dragActive
                ? "border-accent-green ring-2 ring-accent-green/30"
                : "border-bg-border focus-within:border-accent-green/50"
            }`}
          >
            {stagedChips}
            <div className="flex items-end gap-2 px-2 py-1.5">
              {textarea}

              {voice.isSupported && (
                <Tooltip
                  content={voice.isListening ? "Stop recording" : "Voice input"}
                >
                  <button
                    type="button"
                    onClick={
                      voice.isListening
                        ? voice.stopListening
                        : voice.startListening
                    }
                    className={`shrink-0 rounded p-1 transition-colors ${
                      voice.isListening
                        ? "bg-accent-green/20 animate-pulse motion-reduce:animate-none text-accent-green"
                        : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
                    }`}
                  >
                    <Mic size={12} />
                  </button>
                </Tooltip>
              )}

              <CancelPendingButton
                pendingCount={props.pendingApprovalCount}
                onCancel={props.onCancelPending}
              />

              {isActive ? (
                <Tooltip content="Stop turn">
                  <button
                    type="button"
                    onClick={handleStop}
                    className="shrink-0 rounded bg-accent-red/15 p-1.5 text-accent-red transition-colors hover:bg-accent-red/25"
                  >
                    <Square size={12} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content="Send (Enter)">
                  <button
                    type="button"
                    onClick={submitChat}
                    disabled={!input.trim()}
                    className="shrink-0 rounded bg-accent-green/20 p-1.5 text-accent-green transition-colors hover:bg-accent-green/30 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Send size={12} />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Launch variant shell ─────────────────────────────────────────────
  if (!launch) return null; // unreachable — `variant` is a closed union
  const agentMode = launch.agentMode ?? "agent";
  const composerMode = launch.composerMode ?? "local";

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[600px]">
        <ProjectPicker
          selectedRepo={selectedRepo}
          setSelectedRepo={setSelectedRepo}
        />

        <div
          className={`relative border rounded bg-bg-primary transition-colors ${
            dragActive
              ? "border-accent-green ring-2 ring-accent-green/30"
              : "border-bg-border focus-within:border-accent-green/50"
          }`}
          onDrop={handleDrop}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {/* Popovers positioned above the textarea. */}
          {popovers}

          {stagedChips}

          {textarea}

          <div className="flex flex-col gap-2 px-3 py-2 border-t border-bg-border/50">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <ProviderPicker
                  selectedAgent={launch.selectedAgent}
                  onAgentChange={launch.onAgentChange}
                  onModelChange={launch.onModelChange}
                  authStatus={authStatus}
                  refreshAuthStatuses={refreshAuthStatuses}
                  needsLogin={needsLogin}
                  loginTooltip={loginTooltip}
                  onOpenLogin={handleOpenLogin}
                />
                <ModelSelector
                  selectedAgent={launch.selectedAgent}
                  selectedModel={launch.selectedModel}
                  onModelChange={launch.onModelChange}
                  ollamaModels={ollamaModels}
                  refreshOllamaModels={refreshOllamaModels}
                />
              </div>

              <ActionButtons
                isSupported={voice.isSupported}
                isListening={voice.isListening}
                startListening={voice.startListening}
                stopListening={voice.stopListening}
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
                onLaunch={submitLaunch}
              />
            </div>

            <AdvancedAccordion
              summary={[
                {
                  label:
                    agentMode === "agent" ? null : MODE_META[agentMode].label,
                },
                {
                  // Profile: "default" here means the built-in default —
                  // picking any profile also pins it as `defaultProfileId`,
                  // so we can't use that flag. Truncate long names so the
                  // summary stays one line.
                  label:
                    !activeProfile || activeProfile.id === "builtin-default"
                      ? null
                      : activeProfile.name,
                  maxChars: 12,
                },
                {
                  label:
                    composerMode === "local"
                      ? null
                      : composerMode === "worktree"
                        ? "Worktree"
                        : "Cloud",
                },
              ]}
              forceOpenOnFirstMount={
                agentMode !== "agent" ||
                (!!activeProfile && activeProfile.id !== "builtin-default") ||
                composerMode !== "local"
              }
            >
              <ModeSelector value={agentMode} onChange={launch.onAgentModeChange} />
              <ProfilePicker
                profiles={profiles}
                selectedProfileId={launch.selectedProfileId}
                activeProfile={activeProfile}
                onProfileChange={launch.onProfileChange}
                setDefaultProfile={setDefaultProfile}
              />
              {selectedRepo && !isSshUri(selectedRepo) && (
                <ComposerModePicker
                  value={composerMode}
                  onChange={launch.onComposerModeChange}
                />
              )}
            </AdvancedAccordion>
          </div>
        </div>

        <p className="text-meta text-text-muted mt-2 text-center">
          {COMPOSER_HELP_TEXT}
        </p>
      </div>
    </div>
  );
}
