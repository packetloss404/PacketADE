import { useState, useRef, useEffect, useCallback } from "react";
import { X, Loader2, CheckCircle, XCircle, Send, MessageSquare } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { AgentQuickActions } from "./AgentQuickActions";
import type { AgentMessage, AgentToolCall } from "@/types/agent-conversation";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const AGENT_DOT_COLORS: Record<string, string> = {
  "claude-code": "bg-accent-amber",
  codex: "bg-accent-blue",
  gemini: "bg-accent-purple",
  opencode: "bg-accent-green",
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

export function AgentChatPane({ conversationId, onClose }: AgentChatPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId)
  );
  const sendMessage = useAgentTaskStore((s) => s.sendMessage);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages]);

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

  if (!conversation) {
    return (
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center">
        <span className="text-[11px] text-text-muted">Conversation not found</span>
      </div>
    );
  }

  const status = STATUS_DISPLAY[conversation.status] ?? STATUS_DISPLAY.idle;
  const agentLabel = AGENT_LABELS[conversation.agent] ?? conversation.agent;
  const dotColor = AGENT_DOT_COLORS[conversation.agent] ?? "bg-text-muted";
  const folderName = conversation.projectPath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() ?? conversation.projectPath;

  const isActive = conversation.status === "active";
  const isIdle = conversation.status === "idle";
  const messages = conversation.messages;
  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const showThinking =
    isActive &&
    (!lastMessage || lastMessage.role === "user") &&
    messages.length > 0;

  // Message count for the header badge
  const messageCount = messages.length;
  const userMsgCount = messages.filter((m) => m.role === "user").length;
  const assistantMsgCount = messages.filter((m) => m.role === "assistant").length;

  // Show quick actions only on the last assistant message when idle
  const showQuickActions = isIdle && lastAssistantMessage !== undefined;

  function handleSend() {
    const text = input.trim();
    if (!text || !isActive) return;
    setInput("");
    sendMessage(conversationId, text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-bg-border shrink-0">
        {/* Left: agent dot + name + folder */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[11px] font-medium text-text-primary truncate">
          {agentLabel}
        </span>
        <span className="text-[10px] text-text-muted truncate">{folderName}</span>

        <div className="flex-1" />

        {/* Center: status */}
        <div className="flex items-center gap-1.5">
          {conversation.status === "active" && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
          )}
          <span className={`text-[10px] font-medium ${status.className}`}>
            {status.label}
          </span>
        </div>

        {/* Message count badge */}
        {messageCount > 0 && (
          <div
            className="flex items-center gap-1 text-[9px] text-text-muted"
            title={`${userMsgCount} sent, ${assistantMsgCount} received`}
          >
            <MessageSquare size={9} />
            {messageCount}
          </div>
        )}

        <div className="flex-1" />

        {/* Right: close */}
        <button
          onClick={onClose}
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
          title="Close pane"
        >
          <X size={12} />
        </button>
      </div>

      {/* Messages area */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {conversation.messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-[11px] text-text-muted">
              No messages yet
            </span>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            <MessageBubble message={msg} />
            {showQuickActions && msg.id === lastAssistantMessage?.id && (
              <AgentQuickActions conversationId={conversationId} message={msg} />
            )}
          </div>
        ))}

        {/* Thinking indicator */}
        {showThinking && (
          <div className="flex items-start gap-2">
            <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary border border-bg-border rounded-lg text-[11px] text-text-muted">
              <Loader2 size={10} className="animate-spin" />
              Thinking...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-bg-border px-3 py-2 bg-bg-primary">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            data-agent-pane-input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            rows={1}
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none leading-relaxed"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !isActive}
            className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
            title="Send"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Message bubble                                                      */
/* ------------------------------------------------------------------ */

function MessageBubble({ message }: { message: AgentMessage }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="text-[10px] text-text-muted italic px-2 py-0.5">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-1.5 bg-accent-blue/15 rounded-lg text-xs text-text-primary">
          {message.content}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1.5">
        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Content */}
        {message.content && (
          <div className="px-3 py-2 bg-bg-secondary border border-bg-border rounded-lg text-xs">
            <MarkdownRenderer content={message.content} className="text-xs leading-relaxed" />
          </div>
        )}

        {/* Streaming cursor */}
        {message.isStreaming && (
          <span className="inline-block w-1.5 h-3.5 bg-accent-green/70 rounded-sm animate-pulse ml-1" />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tool call card                                                      */
/* ------------------------------------------------------------------ */

function ToolCallCard({ toolCall }: { toolCall: AgentToolCall }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-bg-hover rounded text-[10px] text-text-muted">
      {toolCall.status === "running" ? (
        <Loader2 size={10} className="animate-spin" />
      ) : toolCall.status === "error" ? (
        <XCircle size={10} className="text-accent-red" />
      ) : (
        <CheckCircle size={10} className="text-accent-green" />
      )}
      <span className="font-mono">{toolCall.name}</span>
      {toolCall.file && (
        <span className="text-text-muted">({toolCall.file})</span>
      )}
    </div>
  );
}
