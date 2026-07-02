import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowDown, ArrowLeft, ChevronUp, MessageSquareOff, Mic, Send, Server, Sparkles, Square } from "lucide-react";
import { MentionSourcePicker } from "./MentionSourcePicker";
import { SlashCommandPopover, type SlashSelection } from "./SlashCommandPopover";
import { BUILTIN_SLASH_NAMES, TEMPLATE_SOURCE_TAG } from "./slashCommandConstants";
import type { SlashCommandDef } from "@/lib/tauri";
import { MemoryInjectionCard } from "./MemoryInjectionCard";
import { CheckpointPanel } from "./CheckpointPanel";
import { AgentHeaderBadges } from "./AgentHeaderBadges";
import { SessionHealthBar } from "./SessionHealthBar";
import { PlanPanel } from "./PlanPanel";
import { SpecPanel } from "./SpecPanel";
import { deriveMode, flagsForMode, nextMode } from "./agentModeChipUtils";
import type { AgentMode } from "./AgentModeChip";
import { ClickablePathsRoot } from "@/components/common/wrapClickablePaths";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentDraftStore } from "@/stores/agentDraftStore";
import {
  EMPTY_PENDING_EDITS,
  EMPTY_PENDING_PERMISSIONS,
  useAgentApprovalStore,
} from "@/stores/agentApprovalStore";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import { useProfileStore } from "@/stores/profileStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { HeaderActions } from "./chat/HeaderActions";
import { handleExport } from "./chat/handleExport";
import { EmptyConversationHint } from "./chat/EmptyConversationHint";
import { PendingDiffCommentsStrip } from "./chat/PendingDiffCommentsStrip";
import { MessageList } from "./chat/MessageList";
import { PendingApprovalsSection } from "./chat/PendingApprovalsSection";
import { CancelPendingButton } from "./chat/CancelPendingButton";
import { useScrollState } from "./hooks/useScrollState";
import { useVoiceTranscript } from "./hooks/useVoiceTranscript";
import { useLatestPlanPreview } from "./hooks/useLatestPlanPreview";
import { useProjectSlashCommands } from "./hooks/useProjectSlashCommands";
import { useDiffTotals } from "./hooks/useDiffTotals";
import { buildChatKeyboardHandler, type MentionState } from "./chat/buildChatKeyboardHandler";
import { slashCommandHandlers } from "./chat/slashCommandHandlers";
import { Tooltip } from "@/components/ui/Tooltip";
import { getAgentColor } from "@/lib/agentColors";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  packetcode: "PacketCode",
};

const STATUS_DISPLAY: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "text-accent-green" },
  idle: { label: "Idle", className: "text-text-muted" },
  done: { label: "Done", className: "text-accent-blue" },
  failed: { label: "Failed", className: "text-accent-red" },
};

interface AgentChatPaneProps {
  conversationId: string;
  onClose: () => void;
}

// "← back to plan" link shown when this conversation was spawned by a
// Codex handoff. Resolves the parent name lazily; renders nothing if the
// parent has been deleted (cleanup is automatic).
function BackToParentLink({ parentId }: { parentId: string }) {
  const parent = useAgentTaskStore((s) => s.conversations.find((c) => c.id === parentId));
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  if (!parent) return null;
  return (
    <Tooltip content={`Spawned via "Hand off to Codex" from "${parent.title}"`}>
      <button
        type="button"
        onClick={() => selectConversation(parentId)}
        className="flex items-center gap-1 rounded border border-bg-border bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:text-accent-blue"
      >
        <ArrowLeft size={11} />
        back to plan
      </button>
    </Tooltip>
  );
}

// Scan backward from `cursor` for a trigger char (`@` or `/`). Valid trigger:
// at start-of-string OR preceded by whitespace, with no whitespace between
// trigger and cursor.
function findTrigger(
  text: string,
  cursor: number,
  triggerChar: string,
): { triggerIndex: number; query: string } | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === triggerChar) {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { triggerIndex: i, query: text.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function AgentChatPane({ conversationId, onClose }: AgentChatPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );

  // Grouped store actions — keeps reference stable across renders.
  const actions = useAgentTaskStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      cancelActiveConversation: s.cancelActiveConversation,
      changeModel: s.changeModel,
      createApiConversation: s.createApiConversation,
      selectConversation: s.selectConversation,
      setPlanMode: s.setPlanMode,
      setPermissionMode: s.setPermissionMode,
      setApproveWrites: s.setApproveWrites,
      appendAllowedToolPattern: s.appendAllowedToolPattern,
      removeDiffComment: s.removeDiffComment,
      clearDiffComments: s.clearDiffComments,
      retryLastTurn: s.retryLastTurn,
      forkAndResend: s.forkAndResend,
    })),
  );

  // Approval actions live in their own substore now — group them so the
  // PendingApprovalsSection / CancelPendingButton see stable references.
  const approvalActions = useAgentApprovalStore(
    useShallow((s) => ({
      respondPermission: s.respondPermission,
      respondEdit: s.respondEdit,
      cancelPendingTools: s.cancelPendingTools,
    })),
  );
  // Live queues read from the substore — drives both the per-item cards
  // and the header status line counters.
  const pendingPermissions = useAgentApprovalStore(
    (s) => s.permissions.get(conversationId) ?? EMPTY_PENDING_PERMISSIONS,
  );
  const pendingEdits = useAgentApprovalStore(
    (s) => s.edits.get(conversationId) ?? EMPTY_PENDING_EDITS,
  );

  // Preview pane + settings selectors grouped to reduce subscription count.
  const preview = usePreviewPaneStore(
    useShallow((s) => ({
      previewOpen: s.open,
      togglePreview: s.toggle,
      openMarkdownPreview: s.openMarkdown,
      openPlanPreview: s.openPlan,
    })),
  );
  const promptTemplates = usePromptStore((s) => s.templates);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const reviewerProfile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === "builtin-reviewer"),
  );
  const memoryEvents = useMemoryStore((s) => s.events);
  const memoryPatterns = useMemoryStore((s) => s.patterns);
  const getMemoryItemsForSession = useMemoryStore((s) => s.getContextItemsForSession);

  // Composer text lives in the per-conversation draft store (keyed by
  // conversation id), so switching conversations never bleeds or loses a
  // half-typed draft. Cleared on send.
  const input = useAgentDraftStore((s) => s.drafts[conversationId] ?? "");
  const setDraft = useAgentDraftStore((s) => s.setDraft);
  const setInput = useCallback(
    (text: string) => setDraft(conversationId, text),
    [conversationId, setDraft],
  );
  const [mentionState, setMentionState] = useState<MentionState>({ kind: "none" });
  const [showRewind, setShowRewind] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historySourceRef = useRef<"user" | "history">("user");
  // Inline edit of a prior user message. Submit forks the conversation here.
  const [editState, setEditState] = useState<{ id: string | null; text: string }>({
    id: null,
    text: "",
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { messagesContainerRef, messagesContentRef, messagesEndRef, isAtBottom, unreadCount, jumpToBottom } =
    useScrollState(conversationId, conversation?.messages);

  const appendToInput = useCallback(
    (chunk: string) => {
      const current = useAgentDraftStore.getState().drafts[conversationId] ?? "";
      setDraft(conversationId, current + chunk);
    },
    [conversationId, setDraft],
  );
  const voice = useVoiceTranscript(appendToInput);

  useLatestPlanPreview(conversation, preview.openPlanPreview);

  const projectPathForSlash = conversation?.projectPath ?? "";
  const { customSlashCommands, userSkills } = useProjectSlashCommands(projectPathForSlash);

  const diffTotals = useDiffTotals(conversation);
  const memoryBriefStats = useMemo(() => {
    if (!conversation?.projectPath) {
      return { patterns: 0, summaries: 0, lessons: 0, approxTokens: 0 };
    }
    const items = getMemoryItemsForSession({
      sessionId: conversation.sessionId ?? conversation.id,
      projectPath: conversation.projectPath,
    });
    const patterns = items.filter((item) => item.kind === "pattern").length;
    const lessons = items.filter((item) => item.kind === "lesson").length;
    const summaries = items.filter((item) => item.kind === "session").length;
    const approxTokens = Math.max(
      0,
      Math.round(items.reduce((sum, item) => sum + item.title.length + item.reason.length, 0) / 4),
    );
    return { patterns, summaries, lessons, approxTokens };
    // getContextItemsForSession reads memory state through get(); include
    // events/patterns so counts update live while the conversation is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversation?.id,
    conversation?.projectPath,
    conversation?.sessionId,
    getMemoryItemsForSession,
    memoryEvents,
    memoryPatterns,
  ]);

  // Auto-resize textarea
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, []);
  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  // Synthesize a SlashCommandDef per saved prompt template so they appear in
  // the popover alongside file-loaded custom commands.
  const templateSlashCommands = useMemo<SlashCommandDef[]>(
    () =>
      promptTemplates.map((t) => ({
        name: t.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, ""),
        description: t.name,
        body: t.content,
        source: TEMPLATE_SOURCE_TAG,
      })),
    [promptTemplates],
  );

  const allCustomSlashCommands = useMemo<SlashCommandDef[]>(
    () => [...customSlashCommands, ...templateSlashCommands],
    [customSlashCommands, templateSlashCommands],
  );

  // Hooks must run in the same order every render — compute popover count
  // before the early return.
  const popoverItemCount = useMemo(() => {
    if (mentionState.kind === "slash") {
      const q = mentionState.query.toLowerCase();
      const builtins = BUILTIN_SLASH_NAMES.filter((c) => c.startsWith(q)).length;
      const custom = allCustomSlashCommands.filter((c) =>
        c.name.toLowerCase().startsWith(q),
      ).length;
      const skills = userSkills.filter(
        (s) => s.userInvocable && s.name.toLowerCase().startsWith(q),
      ).length;
      return builtins + custom + skills;
    }
    return 0;
  }, [mentionState, allCustomSlashCommands, userSkills]);

  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg-primary">
        <MessageSquareOff size={24} className="text-text-muted opacity-40" />
        <span className="text-xs text-text-secondary">Conversation not found</span>
        <span className="text-[10px] text-text-muted">It may have been deleted.</span>
      </div>
    );
  }

  const status = STATUS_DISPLAY[conversation.status] ?? STATUS_DISPLAY.idle;
  const agentLabel = AGENT_LABELS[conversation.agent] ?? conversation.agent;
  const agentColor = getAgentColor(conversation.agent);

  // isActive = actively streaming / waiting for the agent ("running" in the UI sense).
  const isActive = conversation.status === "active";
  const messages = conversation.messages;

  /* ----------------- popover / input handling ----------------- */

  function updateMentionStateFromInput(text: string, cursor: number) {
    const fileHit = findTrigger(text, cursor, "@");
    if (fileHit) {
      setMentionState({
        kind: "file",
        query: fileHit.query,
        triggerIndex: fileHit.triggerIndex,
        highlightedIndex: 0,
      });
      return;
    }
    const slashHit = findTrigger(text, cursor, "/");
    if (slashHit) {
      setMentionState({
        kind: "slash",
        query: slashHit.query,
        triggerIndex: slashHit.triggerIndex,
        highlightedIndex: 0,
      });
      return;
    }
    setMentionState({ kind: "none" });
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    setInput(text);
    const cursor = e.target.selectionStart ?? text.length;
    updateMentionStateFromInput(text, cursor);
    if (historySourceRef.current === "history") {
      historySourceRef.current = "user";
    } else if (historyIndex !== -1) {
      setHistoryIndex(-1);
    }
  }

  function handleSelectionChange() {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? ta.value.length;
    updateMentionStateFromInput(ta.value, cursor);
  }

  function selectFileMention(insertion: string) {
    if (mentionState.kind !== "file") return;
    const before = input.slice(0, mentionState.triggerIndex);
    const afterStart = mentionState.triggerIndex + 1 + mentionState.query.length;
    const after = input.slice(afterStart);
    const next = `${before}${insertion} ${after}`;
    setInput(next);
    setMentionState({ kind: "none" });
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        const pos = before.length + insertion.length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  function runSlashCommand(sel: SlashSelection) {
    if (mentionState.kind !== "slash") return;
    if (!conversation) return;
    const before = input.slice(0, mentionState.triggerIndex);
    const afterStart = mentionState.triggerIndex + 1 + mentionState.query.length;
    const after = input.slice(afterStart);
    const remaining = (before + after).trim();
    setInput(remaining);
    setMentionState({ kind: "none" });

    if (sel.kind === "custom" || sel.kind === "skill") {
      actions.sendMessage(conversationId, sel.def.body);
      return;
    }

    const handler = slashCommandHandlers[sel.name];
    if (handler) {
      handler({
        conversationId,
        conversation,
        setPlanMode: actions.setPlanMode,
        createApiConversation: actions.createApiConversation,
        selectConversation: actions.selectConversation,
        setActiveView,
        reviewerProfile,
      });
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMentionState({ kind: "none" });
    setHistoryIndex(-1);
    actions.sendMessage(conversationId, text);
  }

  function handleStop() {
    void actions.cancelActiveConversation(conversationId);
  }

  // Claude-Code-style mode set/cycle. Applies flagsForMode(next) to the
  // conversation so the chip always reflects the actual posture. The current
  // approveWrites is threaded through flagsForMode so a mode change can never
  // clobber the fine flag.
  function applyMode(next: AgentMode) {
    if (!conversation || conversation.mode !== "api") return;
    const flags = flagsForMode(next, conversation.approveWrites ?? false);
    if (flags.planMode !== (conversation.planMode ?? false)) {
      void actions.setPlanMode(conversationId, flags.planMode);
    }
    if (flags.permissionMode !== (conversation.permissionMode ?? "auto")) {
      void actions.setPermissionMode(conversationId, flags.permissionMode);
    }
    if (flags.approveWrites !== (conversation.approveWrites ?? false)) {
      void actions.setApproveWrites(conversationId, flags.approveWrites);
    }
  }

  function cycleMode() {
    if (!conversation || conversation.mode !== "api") return;
    applyMode(nextMode(deriveMode(conversation)));
  }

  function handleOpenMarkdown(path: string) {
    if (!/\.mdx?$/i.test(path)) return;
    preview.openMarkdownPreview(path);
  }

  const handleKeyDown = buildChatKeyboardHandler({
    textareaRef,
    input,
    setInput,
    messages,
    mentionState,
    setMentionState,
    historyIndex,
    setHistoryIndex,
    historySourceRef,
    popoverItemCount,
    allCustomSlashCommands,
    userSkills,
    cycleMode,
    runSlashCommand,
    handleSend,
  });

  /* ----------------- render ----------------- */

  // Session counts surfaced in the consolidated status bar below the header.
  const turnCount = messages.filter((m) => m.role === "user").length;
  const toolCallCount = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0);
  const pendingApprovalCount = pendingEdits.length + pendingPermissions.length;
  const assistantMsgCount = messages.filter((m) => m.role === "assistant").length;

  // Politely announced to screen readers: status transitions + the latest
  // assistant output as it streams in.
  let lastAssistantText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantText = messages[i].content;
      break;
    }
  }

  const chatContent = (
    <div className="flex h-full flex-col">
      {/* Header bar — sparkle avatar + title + agent/status chips. Single row
          snapped to the shared h-[33px] baseline; session counts + git/model
          moved into the consolidated SessionHealthBar below. */}
      <div className="flex h-[33px] shrink-0 items-center gap-2.5 border-b border-bg-border bg-bg-secondary px-3">
        <div className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md border border-accent-line bg-accent-soft">
          <Sparkles size={13} className="text-accent-green" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-text-primary">
            {conversation.title || agentLabel}
          </span>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${agentColor.text} bg-current ${isActive ? "animate-pulse motion-reduce:animate-none" : ""}`}
          />
          <span className={`text-[10px] font-medium ${status.className}`}>{status.label}</span>
          {conversation.sshTarget && (
            <Tooltip
              content={`Tools run on ${conversation.sshTarget.user}@${conversation.sshTarget.host}:${conversation.sshTarget.remotePath}`}
              side="bottom"
            >
              <span className="flex items-center gap-1 rounded border border-accent-line bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent-green">
                <Server size={10} />
                {conversation.sshTarget.host}
              </span>
            </Tooltip>
          )}
          <AgentHeaderBadges conversationId={conversationId} agent={conversation.agent} />
          {conversation.parentConversationId && (
            <BackToParentLink parentId={conversation.parentConversationId} />
          )}
        </div>

        <HeaderActions
          conversation={conversation}
          conversationId={conversationId}
          diffTotals={diffTotals}
          previewOpen={preview.previewOpen}
          togglePreview={preview.togglePreview}
          showRewind={showRewind}
          setShowRewind={setShowRewind}
          onClose={onClose}
          onCycleMode={cycleMode}
          onSelectMode={applyMode}
          onSetApproveWrites={(on) => void actions.setApproveWrites(conversationId, on)}
          onChangeModel={(model) => void actions.changeModel(conversationId, model)}
          onExport={() => void handleExport(conversation)}
        />
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {status.label}. {lastAssistantText}
      </div>

      <SessionHealthBar
        conversation={conversation}
        counts={{
          turns: turnCount,
          toolCalls: toolCallCount,
          pending: pendingApprovalCount,
          received: assistantMsgCount,
        }}
      />

      {/* F10: Spec → Plan → Code FSM. SpecPanel renders only during specStage="spec". */}
      <SpecPanel conversation={conversation} />
      <PlanPanel conversation={conversation} />

      <ClickablePathsRoot
        projectPath={conversation.projectPath}
        onOpenMarkdown={handleOpenMarkdown}
      >
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-3 py-3">
            {/* Inner content wrapper carries the row spacing and is measured by
                the ResizeObserver in useScrollState so "stick to bottom" stays
                pinned as virtualized rows lazily mount and grow. */}
            <div ref={messagesContentRef} className="space-y-2.5">
              {conversation.mode === "api" && conversation.memoryContextEnabled && (
                <MemoryInjectionCard {...memoryBriefStats} />
              )}

              {messages.length === 0 && <EmptyConversationHint />}

              <MessageList
                conversation={conversation}
                conversationId={conversationId}
                editingMessageId={editState.id}
                editingText={editState.text}
                onStartEdit={(id, content) => setEditState({ id, text: content })}
                onChangeEdit={(text) => setEditState((s) => ({ ...s, text }))}
                onSubmitEdit={(msgId) => {
                  const text = editState.text;
                  setEditState({ id: null, text: "" });
                  void actions.forkAndResend(conversationId, msgId, text);
                }}
                onCancelEdit={() => setEditState({ id: null, text: "" })}
                onRetryLastTurn={() => void actions.retryLastTurn(conversationId)}
                isActive={isActive}
                scrollContainerRef={messagesContainerRef}
              />

              <div ref={messagesEndRef} />
            </div>
          </div>
          {!isAtBottom && (
            <Tooltip content="Jump to latest">
              <button
                type="button"
                onClick={jumpToBottom}
                className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-bg-border bg-bg-primary px-3 py-1 text-xs text-text-secondary shadow-md transition-colors hover:border-accent-green/60 hover:text-text-primary"
              >
                <ArrowDown size={12} />
                <span>{unreadCount > 0 ? `${unreadCount} new` : "Latest"}</span>
              </button>
            </Tooltip>
          )}
        </div>
      </ClickablePathsRoot>

      <PendingApprovalsSection
        conversation={conversation}
        conversationId={conversationId}
        pendingEdits={pendingEdits}
        pendingPermissions={pendingPermissions}
        respondEdit={approvalActions.respondEdit}
        respondPermission={approvalActions.respondPermission}
        cancelPendingTools={approvalActions.cancelPendingTools}
        appendAllowedToolPattern={actions.appendAllowedToolPattern}
      />

      {(conversation.pendingDiffComments?.length ?? 0) > 0 && (
        <PendingDiffCommentsStrip
          conversation={conversation}
          onRemove={(id) => actions.removeDiffComment(conversationId, id)}
          onClear={() => actions.clearDiffComments(conversationId)}
        />
      )}

      <div className="relative shrink-0 border-t border-bg-border bg-bg-primary px-3 py-2">
        {historyIndex >= 0 && (
          <div className="pointer-events-none absolute right-3 top-1 inline-flex select-none items-center gap-0.5 font-mono text-[10px] text-text-faint">
            <ChevronUp size={10} />
            {historyIndex + 1}/{turnCount}
          </div>
        )}
        <div className="absolute bottom-full left-3 right-3" data-agent-pane-mention-popover>
          <MentionSourcePicker
            visible={mentionState.kind === "file"}
            projectPath={conversation.projectPath}
            query={mentionState.kind === "file" ? mentionState.query : ""}
            highlightedIndex={mentionState.kind === "file" ? mentionState.highlightedIndex : 0}
            onSelect={selectFileMention}
          />
          <SlashCommandPopover
            customCommands={allCustomSlashCommands}
            userSkills={userSkills}
            visible={mentionState.kind === "slash"}
            query={mentionState.kind === "slash" ? mentionState.query : ""}
            highlightedIndex={mentionState.kind === "slash" ? mentionState.highlightedIndex : 0}
            onSelect={runSlashCommand}
          />
        </div>

        <div className="flex items-end gap-2 rounded border border-bg-border bg-bg-primary px-2 py-1.5 transition-colors focus-within:border-accent-green/50">
          <textarea
            ref={textareaRef}
            data-agent-pane-input
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleSelectionChange}
            onClick={handleSelectionChange}
            placeholder="Send a message..."
            rows={1}
            className="flex-1 resize-none bg-transparent text-xs leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
          />

          {voice.isSupported && (
            <Tooltip content={voice.isListening ? "Stop recording" : "Voice input"}>
              <button
                type="button"
                onClick={voice.isListening ? voice.stopListening : voice.startListening}
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
            pendingCount={pendingApprovalCount}
            onCancel={() => void approvalActions.cancelPendingTools(conversationId)}
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
                onClick={handleSend}
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
  );

  return (
    <div className="flex h-full bg-bg-primary">
      <div className="min-w-0 flex-1">{chatContent}</div>
      {showRewind && (
        <div className="w-72 shrink-0 border-l border-bg-border">
          <CheckpointPanel conversationId={conversationId} onClose={() => setShowRewind(false)} />
        </div>
      )}
    </div>
  );
}
