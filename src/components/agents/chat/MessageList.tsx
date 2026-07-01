import { useEffect, useState } from "react";
import { Pencil, RotateCw } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { calculateTurnCost } from "@/lib/tauri";
import { ExplorationRollupCard } from "../ExplorationRollupCard";
import { PlanModeApprovalMenu } from "../PlanModeApprovalMenu";
import { ThinkingBlock } from "../ThinkingBlock";
import { AgentQuickActions } from "../AgentQuickActions";
import { looksLikePlan } from "../planDetection";
import { ToolCallRenderer } from "./ToolCallRenderer";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";

interface MessageListProps {
  conversation: AgentConversation;
  conversationId: string;
  editingMessageId: string | null;
  editingText: string;
  onStartEdit: (msgId: string, content: string) => void;
  onChangeEdit: (text: string) => void;
  onSubmitEdit: (msgId: string) => void;
  onCancelEdit: () => void;
  onRetryLastTurn: () => void;
  isActive: boolean;
}

export function MessageList({
  conversation,
  conversationId,
  editingMessageId,
  editingText,
  onStartEdit,
  onChangeEdit,
  onSubmitEdit,
  onCancelEdit,
  onRetryLastTurn,
  isActive,
}: MessageListProps) {
  const messages = conversation.messages;
  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const isIdle = conversation.status === "idle";
  const showQuickActions = isIdle && lastAssistantMessage !== undefined;
  const showThinking =
    isActive &&
    (!lastMessage || lastMessage.role === "user") &&
    messages.length > 0;

  return (
    <>
      {messages.map((msg) => (
        <div
          key={msg.id}
          className="animate-[welcomeFadeIn_200ms_ease-out] motion-reduce:animate-none"
        >
          <MessageBubble
            message={msg}
            conversation={conversation}
            isLastAssistant={msg.id === lastAssistantMessage?.id}
            onRetry={
              msg.id === lastAssistantMessage?.id && !msg.isStreaming
                ? onRetryLastTurn
                : undefined
            }
            isEditing={editingMessageId === msg.id}
            editingText={editingText}
            onStartEdit={
              msg.role === "user"
                ? () => onStartEdit(msg.id, msg.content)
                : undefined
            }
            onChangeEdit={onChangeEdit}
            onSubmitEdit={() => onSubmitEdit(msg.id)}
            onCancelEdit={onCancelEdit}
          />
          {showQuickActions && msg.id === lastAssistantMessage?.id && (
            <AgentQuickActions
              conversationId={conversationId}
              message={msg}
            />
          )}
        </div>
      ))}

      {conversation.planMode &&
        lastMessage?.role === "assistant" &&
        !lastMessage.isStreaming &&
        looksLikePlan(lastMessage.content) && (
          <PlanModeApprovalMenu
            conversationId={conversationId}
            planText={lastMessage.content}
          />
        )}

      {showThinking && (
        <div className="flex items-start gap-2">
          <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary border border-bg-border rounded text-[11px] text-text-muted">
            <Spinner size={10} className="text-text-muted" label="Thinking" />
            Thinking...
          </div>
        </div>
      )}
    </>
  );
}

function MessageBubble({
  message,
  conversation,
  isLastAssistant,
  onRetry,
  isEditing,
  editingText,
  onStartEdit,
  onChangeEdit,
  onSubmitEdit,
  onCancelEdit,
}: {
  message: AgentMessage;
  conversation: AgentConversation;
  isLastAssistant?: boolean;
  onRetry?: () => void;
  isEditing?: boolean;
  editingText?: string;
  onStartEdit?: () => void;
  onChangeEdit?: (text: string) => void;
  onSubmitEdit?: () => void;
  onCancelEdit?: () => void;
}) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-[10px] text-text-muted px-2 py-1 bg-bg-secondary/50 border border-bg-border rounded max-w-[90%]">
          <MarkdownRenderer
            content={message.content}
            className="text-[10px] leading-relaxed"
          />
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    if (isEditing) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] w-full px-3 py-2 rounded text-xs bg-accent-blue/10 border border-accent-blue/40 flex flex-col gap-1.5">
            <textarea
              autoFocus
              value={editingText ?? ""}
              onChange={(e) => onChangeEdit?.(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  onSubmitEdit?.();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit?.();
                }
              }}
              rows={Math.min(
                8,
                Math.max(2, (editingText ?? "").split("\n").length),
              )}
              className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none leading-relaxed"
            />
            <div className="flex items-center justify-between gap-2">
              <Tooltip content="Truncates the transcript to this point and re-runs from here">
                <span className="text-[10px] text-text-muted">
                  Forks the conversation from this turn
                </span>
              </Tooltip>
              <div className="flex items-center gap-1.5">
                <Tooltip content="Cancel (Esc)">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="text-[11px] px-2 py-0.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  >
                    Cancel
                  </button>
                </Tooltip>
                <Tooltip content="Send (Ctrl+Enter)">
                  <button
                    type="button"
                    onClick={onSubmitEdit}
                    disabled={!(editingText ?? "").trim()}
                    className="text-[11px] px-2 py-0.5 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Resend
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="group flex justify-end">
        <div
          className={`max-w-[85%] px-3 py-1.5 rounded text-xs text-text-primary relative ${
            message.queued
              ? "bg-accent-amber/10 border border-accent-amber/30"
              : "bg-accent-blue/15"
          }`}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          {message.queued && (
            <span className="text-[10px] text-accent-amber ml-1">
              (queued)
            </span>
          )}
          {onStartEdit && !message.queued && (
            <Tooltip content="Edit & resend — forks the conversation from this turn">
              <button
                type="button"
                onClick={onStartEdit}
                className="absolute -left-6 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover:opacity-100 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-opacity transition-colors"
              >
                <Pencil size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    );
  }

  // assistant
  const verbosity = conversation.transcriptVerbosity ?? "normal";
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1.5">
        {verbosity !== "summary" &&
          message.thinking &&
          message.thinking.length > 0 && (
            <ThinkingBlock
              text={message.thinking}
              streaming={message.isStreaming}
            />
          )}

        {message.toolCalls && message.toolCalls.length > 0 && !message.isStreaming && (
          <ExplorationRollupCard toolCalls={message.toolCalls} />
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallRenderer
            toolCalls={message.toolCalls}
            isStreaming={message.isStreaming}
            conversationId={conversation.id}
            projectPath={conversation.projectPath}
            verbosity={verbosity}
          />
        )}

        {message.content && (
          <div className="px-3 py-2 bg-bg-secondary border border-bg-border rounded text-xs">
            <MarkdownRenderer
              content={message.content}
              className="text-xs leading-relaxed"
            />
            {message.isStreaming && (
              <span className="inline-block w-1.5 h-3.5 bg-accent-green/70 rounded-sm animate-pulse ml-1 align-text-bottom" />
            )}
          </div>
        )}

        {message.isStreaming && !message.content && (
          <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary border border-bg-border rounded text-[11px] text-text-muted">
            <Spinner size={10} className="text-accent-green" label="Responding" />
            Responding...
          </div>
        )}

        <div className="flex items-center gap-2">
          <AssistantCostPill
            message={message}
            model={conversation.model ?? ""}
          />
          {isLastAssistant && !message.isStreaming && onRetry && (
            <Tooltip content="Retry this turn">
              <button
                type="button"
                onClick={onRetry}
                className="text-text-muted hover:text-text-primary text-[10px] p-0.5 rounded transition-colors"
              >
                <RotateCw size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function AssistantCostPill({
  message,
  model,
}: {
  message: AgentMessage;
  model: string;
}) {
  const [cost, setCost] = useState<number | null>(null);

  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
    message;

  useEffect(() => {
    if (inputTokens == null || outputTokens == null || !model) {
      setCost(null);
      return;
    }
    let cancelled = false;
    calculateTurnCost(
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens ?? 0,
      cacheWriteTokens ?? 0,
    )
      .then((n) => {
        if (!cancelled) setCost(n);
      })
      .catch(() => {
        if (!cancelled) setCost(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model]);

  if (inputTokens == null || outputTokens == null) return null;
  const totalTokens = inputTokens + outputTokens;
  return (
    <div className="text-[10px] text-text-muted font-mono">
      {totalTokens} tok
      {cost != null && ` · $${cost.toFixed(4)}`}
    </div>
  );
}

