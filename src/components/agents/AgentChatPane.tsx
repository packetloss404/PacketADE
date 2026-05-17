import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDown,
  Bookmark,
  Mic,
  Send,
  Server,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { MentionSourcePicker } from "./MentionSourcePicker";
import {
  SlashCommandPopover,
  type SlashSelection,
} from "./SlashCommandPopover";
import {
  BUILTIN_SLASH_NAMES,
  TEMPLATE_SOURCE_TAG,
} from "./slashCommandConstants";
import type { SlashCommandDef } from "@/lib/tauri";
import { MemoryInjectionCard } from "./MemoryInjectionCard";
import { CheckpointPanel } from "./CheckpointPanel";
import { AgentStatusBar } from "./AgentStatusBar";
import { AgentHeaderBadges } from "./AgentHeaderBadges";
import { SessionHealthBar } from "./SessionHealthBar";
import { PlanPanel } from "./PlanPanel";
import { SpecPanel } from "./SpecPanel";
import {
  deriveMode,
  flagsForMode,
  nextMode,
} from "./agentModeChipUtils";
import { ClickablePathsRoot } from "@/components/common/wrapClickablePaths";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import { useProfileStore } from "@/stores/profileStore";
import { API_PROVIDERS, getModelSpeed } from "@/lib/api-models";
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
import {
  buildChatKeyboardHandler,
  type MentionState,
} from "./chat/buildChatKeyboardHandler";
import { slashCommandHandlers } from "./chat/slashCommandHandlers";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  packetcode: "PacketCode",
};

const AGENT_DOT_COLORS: Record<string, string> = {
  "claude-code": "bg-accent-amber",
  codex: "bg-accent-blue",
  gemini: "bg-accent-purple",
  opencode: "bg-accent-green",
  packetcode: "bg-accent-purple",
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
  const parent = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === parentId),
  );
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  if (!parent) return null;
  return (
    <button
      type="button"
      onClick={() => selectConversation(parentId)}
      title={`Spawned via "Hand off to Codex" from "${parent.title}"`}
      className="flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-blue bg-bg-secondary border border-bg-border rounded px-1.5 py-0.5 transition-colors"
    >
      ← back to plan
    </button>
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
    (s) => s.permissions.get(conversationId) ?? [],
  );
  const pendingEdits = useAgentApprovalStore(
    (s) => s.edits.get(conversationId) ?? [],
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

  const [input, setInput] = useState("");
  const [mentionState, setMentionState] = useState<MentionState>({ kind: "none" });
  const [showRewind, setShowRewind] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historySourceRef = useRef<"user" | "history">("user");
  // Ctrl+S stash slot. Single slot — newer stash replaces older. Survives the
  // chat session but not a remount.
  const [stashedDraft, setStashedDraft] = useState<string | null>(null);
  // Inline edit of a prior user message. Submit forks the conversation here.
  const [editState, setEditState] = useState<{ id: string | null; text: string }>(
    { id: null, text: "" },
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { messagesContainerRef, messagesEndRef, isAtBottom, unreadCount, jumpToBottom } =
    useScrollState(conversationId, conversation?.messages);

  const appendToInput = useCallback((chunk: string) => {
    setInput((prev) => prev + chunk);
  }, []);
  const voice = useVoiceTranscript(appendToInput);

  useLatestPlanPreview(conversation, preview.openPlanPreview);

  const projectPathForSlash = conversation?.projectPath ?? "";
  const { customSlashCommands, userSkills } =
    useProjectSlashCommands(projectPathForSlash);

  const diffTotals = useDiffTotals(conversation);

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
      const builtins = BUILTIN_SLASH_NAMES.filter((c) =>
        c.startsWith(q),
      ).length;
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
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center">
        <span className="text-[11px] text-text-muted">
          Conversation not found
        </span>
      </div>
    );
  }

  const status = STATUS_DISPLAY[conversation.status] ?? STATUS_DISPLAY.idle;
  const agentLabel = AGENT_LABELS[conversation.agent] ?? conversation.agent;
  const dotColor = AGENT_DOT_COLORS[conversation.agent] ?? "bg-text-muted";
  const folderName =
    conversation.projectPath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() ?? conversation.projectPath;

  const isActive = conversation.status === "active";
  // "running" in the UI sense = actively streaming / waiting for the agent.
  const isRunning = isActive;
  const messages = conversation.messages;

  const providerInfo = API_PROVIDERS.find(
    (p) => p.agentCli === conversation.agent,
  );

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
    const afterStart =
      mentionState.triggerIndex + 1 + mentionState.query.length;
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

  // Claude-Code-style mode cycle. Applies flagsForMode(next) to the
  // conversation so the chip always reflects the actual posture.
  function cycleMode() {
    if (!conversation || conversation.mode !== "api") return;
    const current = deriveMode(conversation);
    const next = nextMode(current);
    const flags = flagsForMode(next);
    if (flags.planMode !== conversation.planMode) {
      void actions.setPlanMode(conversationId, flags.planMode);
    }
    if (flags.permissionMode !== conversation.permissionMode) {
      void actions.setPermissionMode(conversationId, flags.permissionMode);
    }
    if (flags.approveWrites !== (conversation.approveWrites ?? false)) {
      void actions.setApproveWrites(conversationId, flags.approveWrites);
    }
  }

  // Cursor-style "reasoning nudge" — Alt+. raises model thoroughness, Alt+,
  // drops it. Walks the provider's model list to the next model whose speed
  // heuristic matches the desired direction.
  function nudgeReasoning(direction: "up" | "down") {
    if (!conversation || conversation.mode !== "api") return;
    if (!providerInfo) return;
    const current = conversation.model;
    if (!current) return;
    const currentSpeed = getModelSpeed(current);
    const SPEED_ORDER: Array<"fast" | "balanced" | "thorough"> = [
      "fast",
      "balanced",
      "thorough",
    ];
    const currentIdx = SPEED_ORDER.indexOf(currentSpeed);
    const targetIdx =
      direction === "up"
        ? Math.min(SPEED_ORDER.length - 1, currentIdx + 1)
        : Math.max(0, currentIdx - 1);
    if (targetIdx === currentIdx) return;
    const targetSpeed = SPEED_ORDER[targetIdx];
    const candidate = providerInfo.models.find(
      (m) => getModelSpeed(m.value) === targetSpeed && m.value !== current,
    );
    if (!candidate) return;
    void actions.changeModel(conversationId, candidate.value);
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
    setStashedDraft,
    cycleMode,
    nudgeReasoning,
    runSlashCommand,
    handleSend,
  });

  /* ----------------- render ----------------- */

  // "N turns · M tool calls · P pending approvals".
  const turnCount = messages.filter((m) => m.role === "user").length;
  const toolCallCount = messages.reduce(
    (sum, m) => sum + (m.toolCalls?.length ?? 0),
    0,
  );
  const pendingApprovalCount = pendingEdits.length + pendingPermissions.length;
  const statusLineParts: string[] = [];
  if (turnCount > 0)
    statusLineParts.push(`${turnCount} turn${turnCount === 1 ? "" : "s"}`);
  if (toolCallCount > 0)
    statusLineParts.push(
      `${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`,
    );
  if (pendingApprovalCount > 0)
    statusLineParts.push(
      `${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`,
    );

  const userMsgCount = turnCount;
  const assistantMsgCount = messages.filter(
    (m) => m.role === "assistant",
  ).length;

  const chatContent = (
    <div className="flex flex-col h-full">
      {/* Header bar — sparkle avatar + title + status line. Standardized to
          px-3 py-2 / border-bg-border per the visual-drift audit. */}
      <div className="flex items-center gap-2.5 px-3 py-2 bg-bg-secondary border-b border-bg-border shrink-0">
        <div className="w-[26px] h-[26px] shrink-0 rounded-md bg-accent-soft border border-accent-line grid place-items-center">
          <Sparkles size={13} className="text-accent-green" />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-semibold text-text-primary truncate">
              {conversation.title || agentLabel}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
            <span className={`text-[10px] font-medium ${status.className}`}>
              {status.label}
            </span>
            {conversation.sshTarget && (
              <span
                className="flex items-center gap-1 text-[10px] text-accent-green bg-accent-soft border border-accent-line rounded px-1.5 py-0.5"
                title={`Tools run on ${conversation.sshTarget.user}@${conversation.sshTarget.host}:${conversation.sshTarget.remotePath}`}
              >
                <Server size={10} />
                {conversation.sshTarget.host}
              </span>
            )}
            <AgentHeaderBadges
              conversationId={conversationId}
              agent={conversation.agent}
            />
            {conversation.parentConversationId && (
              <BackToParentLink parentId={conversation.parentConversationId} />
            )}
          </div>
          <span
            className="text-[10.5px] text-text-secondary truncate"
            title={`${userMsgCount} sent, ${assistantMsgCount} received`}
          >
            {statusLineParts.length > 0
              ? statusLineParts.join(" · ")
              : `${folderName} · ready`}
          </span>
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
          onChangeModel={(model) => void actions.changeModel(conversationId, model)}
          setPlanMode={actions.setPlanMode}
          setPermissionMode={actions.setPermissionMode}
          setApproveWrites={actions.setApproveWrites}
          onExport={() => void handleExport(conversation)}
        />
      </div>

      <SessionHealthBar conversation={conversation} />

      {/* F10: Spec → Plan → Code FSM. SpecPanel renders only during specStage="spec". */}
      <SpecPanel conversation={conversation} />
      <PlanPanel conversation={conversation} />

      <ClickablePathsRoot
        projectPath={conversation.projectPath}
        onOpenMarkdown={handleOpenMarkdown}
      >
        <div className="relative flex-1 flex flex-col min-h-0">
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5"
          >
            {conversation.mode === "api" && conversation.memoryContextEnabled && (
              <MemoryInjectionCard />
            )}

            {messages.length === 0 && <EmptyConversationHint />}

            <MessageList
              conversation={conversation}
              conversationId={conversationId}
              editingMessageId={editState.id}
              editingText={editState.text}
              onStartEdit={(id, content) => setEditState({ id, text: content })}
              onChangeEdit={(text) =>
                setEditState((s) => ({ ...s, text }))
              }
              onSubmitEdit={(msgId) => {
                const text = editState.text;
                setEditState({ id: null, text: "" });
                void actions.forkAndResend(conversationId, msgId, text);
              }}
              onCancelEdit={() => setEditState({ id: null, text: "" })}
              onRetryLastTurn={() => void actions.retryLastTurn(conversationId)}
              isActive={isActive}
            />

            <div ref={messagesEndRef} />
          </div>
          {!isAtBottom && (
            <button
              type="button"
              onClick={jumpToBottom}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 rounded-full bg-bg-primary border border-bg-border px-3 py-1 text-xs text-text-secondary shadow-md hover:text-text-primary hover:border-accent-green/60 transition-colors"
              title="Jump to latest"
            >
              <ArrowDown size={12} />
              <span>{unreadCount > 0 ? `${unreadCount} new` : "Latest"}</span>
            </button>
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

      <AgentStatusBar conversation={conversation} />

      {(conversation.pendingDiffComments?.length ?? 0) > 0 && (
        <PendingDiffCommentsStrip
          conversation={conversation}
          onRemove={(id) => actions.removeDiffComment(conversationId, id)}
          onClear={() => actions.clearDiffComments(conversationId)}
        />
      )}

      <div className="shrink-0 border-t border-bg-border px-3 py-2 bg-bg-primary relative">
        {historyIndex >= 0 && (
          <div className="absolute top-1 right-3 text-[10px] text-text-muted/70 font-mono pointer-events-none select-none">
            ↑ {historyIndex + 1}/{messages.filter((m) => m.role === "user").length}
          </div>
        )}
        {stashedDraft !== null && (
          <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded">
            <Bookmark size={11} className="text-text-muted" />
            <span className="truncate max-w-[260px]">
              Stashed draft ({stashedDraft.length} chars)
            </span>
            <button
              type="button"
              onClick={() => {
                setInput(stashedDraft);
                setStashedDraft(null);
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              className="text-text-secondary hover:text-text-primary underline"
            >
              restore
            </button>
            <button
              type="button"
              onClick={() => setStashedDraft(null)}
              className="text-text-muted hover:text-text-primary ml-1"
              title="Discard stash"
            >
              <X size={11} />
            </button>
          </div>
        )}
        <div
          className="absolute left-3 right-3 bottom-full"
          data-agent-pane-mention-popover
        >
          <MentionSourcePicker
            visible={mentionState.kind === "file"}
            projectPath={conversation.projectPath}
            query={mentionState.kind === "file" ? mentionState.query : ""}
            highlightedIndex={
              mentionState.kind === "file" ? mentionState.highlightedIndex : 0
            }
            onSelect={selectFileMention}
          />
          <SlashCommandPopover
            customCommands={allCustomSlashCommands}
            userSkills={userSkills}
            visible={mentionState.kind === "slash"}
            query={mentionState.kind === "slash" ? mentionState.query : ""}
            highlightedIndex={
              mentionState.kind === "slash" ? mentionState.highlightedIndex : 0
            }
            onSelect={runSlashCommand}
          />
        </div>

        <div className="flex items-end gap-2">
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
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none leading-relaxed"
          />

          {voice.isSupported && (
            <button
              onClick={voice.isListening ? voice.stopListening : voice.startListening}
              className={`p-1 rounded transition-colors shrink-0 ${
                voice.isListening
                  ? "bg-accent-green/20 text-accent-green animate-pulse"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
              }`}
              title={voice.isListening ? "Stop recording" : "Voice input"}
            >
              <Mic size={12} />
            </button>
          )}

          <CancelPendingButton
            pendingCount={pendingApprovalCount}
            onCancel={() => void approvalActions.cancelPendingTools(conversationId)}
          />

          {isRunning ? (
            <button
              onClick={handleStop}
              className="p-1 text-accent-red hover:bg-accent-red/10 rounded transition-colors shrink-0"
              title="Stop turn"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              title="Send (Enter)"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full bg-bg-primary">
      <div className="flex-1 min-w-0">{chatContent}</div>
      {showRewind && (
        <div className="w-72 shrink-0 border-l border-bg-border">
          <CheckpointPanel
            conversationId={conversationId}
            onClose={() => setShowRewind(false)}
          />
        </div>
      )}
    </div>
  );
}

