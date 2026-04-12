import { useState, useRef, useEffect, memo } from "react";
import { Send, Bot, User, Loader2, Sparkles, Check, X, ListTree } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import type { ChatMessage, FlightSuggestion, FlightPlanSuggestion } from "@/hooks/useFlightChat";

interface FlightChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingContent: string;
  latestSuggestion: FlightSuggestion | null;
  latestPlan: FlightPlanSuggestion | null;
  onSend: (content: string) => void;
  onApplySuggestion: () => void;
  onDismissSuggestion: () => void;
  onApplyPlan: () => void;
  onDismissPlan: () => void;
}

function SuggestionBanner({
  suggestion,
  onApply,
  onDismiss,
}: {
  suggestion: FlightSuggestion;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const fields = [
    suggestion.title && "Title",
    suggestion.objective && "Objective",
    suggestion.priority && "Priority",
  ].filter(Boolean);

  return (
    <div className="mx-3 mb-2 px-3 py-2 bg-accent-purple/15 border border-accent-purple/30 rounded-lg flex items-center gap-2">
      <Sparkles size={12} className="text-accent-purple flex-shrink-0" />
      <span className="text-[11px] text-accent-purple flex-1">
        Suggested: {fields.join(", ")}
      </span>
      <button
        onClick={onApply}
        className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-accent-green bg-accent-green/15 border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors"
      >
        <Check size={10} />
        Apply
      </button>
      <button
        onClick={onDismiss}
        className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function PlanBanner({
  plan,
  onApply,
  onDismiss,
}: {
  plan: FlightPlanSuggestion;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const totalTasks = plan.milestones.reduce((sum, m) => sum + m.tasks.length, 0);
  return (
    <div className="mx-3 mb-2 px-3 py-2 bg-accent-green/10 border border-accent-green/30 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <ListTree size={12} className="text-accent-green flex-shrink-0" />
        <span className="text-[11px] font-medium text-accent-green flex-1">
          Flight Plan: {plan.milestones.length} milestone{plan.milestones.length !== 1 ? "s" : ""}, {totalTasks} task{totalTasks !== 1 ? "s" : ""}
        </span>
        <button
          onClick={onApply}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-accent-green bg-accent-green/15 border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors"
        >
          <Check size={10} />
          Apply Plan
        </button>
        <button
          onClick={onDismiss}
          className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      <div className="space-y-1.5">
        {plan.milestones.map((ms, i) => (
          <div key={i} className="text-[10px]">
            <span className="text-text-primary font-medium">
              {i + 1}. {ms.title}
            </span>
            <span className="text-text-muted ml-1">
              ({ms.tasks.length} task{ms.tasks.length !== 1 ? "s" : ""})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const ChatBubble = memo(function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
          isUser
            ? "bg-accent-green/20 text-accent-green"
            : "bg-accent-purple/20 text-accent-purple"
        }`}
      >
        {isUser ? <User size={10} /> : <Bot size={10} />}
      </div>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          isUser
            ? "bg-accent-green/10 border border-accent-green/20"
            : "bg-bg-elevated border border-bg-border"
        }`}
      >
        {isUser ? (
          <p className="text-xs whitespace-pre-wrap">{message.content}</p>
        ) : (
          <MarkdownRenderer
            content={message.content}
            className="text-xs leading-relaxed space-y-1.5"
          />
        )}
      </div>
    </div>
  );
});

export function FlightChatPanel({
  messages,
  isLoading,
  streamingContent,
  latestSuggestion,
  latestPlan,
  onSend,
  onApplySuggestion,
  onDismissSuggestion,
  onApplyPlan,
  onDismissPlan,
}: FlightChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  function handleSend() {
    if (!input.trim() || isLoading) return;
    onSend(input.trim());
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-bg-border">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-accent-purple" />
          <span className="text-[11px] font-medium text-text-secondary">
            Flight Planner
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3" role="log" aria-live="polite">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-text-muted">
            <Bot size={24} className="text-accent-purple/40" />
            <p className="text-[11px] text-center leading-relaxed">
              Describe what you want to build.<br />
              I'll help shape the flight plan.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} />
        ))}

        {isLoading && streamingContent && (
          <div className="flex gap-2">
            <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-accent-purple/20 text-accent-purple">
              <Bot size={10} />
            </div>
            <div className="max-w-[85%] rounded-lg px-3 py-2 bg-bg-elevated border border-bg-border">
              <MarkdownRenderer
                content={streamingContent}
                className="text-xs leading-relaxed space-y-1.5"
              />
            </div>
          </div>
        )}

        {isLoading && !streamingContent && (
          <div className="flex items-center gap-2 px-2 py-1">
            <Loader2 size={12} className="text-accent-purple animate-spin" />
            <span className="text-[11px] text-text-muted">Thinking...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Plan banner (takes priority over suggestion banner) */}
      {latestPlan && (
        <PlanBanner
          plan={latestPlan}
          onApply={onApplyPlan}
          onDismiss={onDismissPlan}
        />
      )}

      {/* Suggestion banner (only if no plan) */}
      {!latestPlan && latestSuggestion && (
        <SuggestionBanner
          suggestion={latestSuggestion}
          onApply={onApplySuggestion}
          onDismiss={onDismissSuggestion}
        />
      )}

      {/* Input */}
      <div className="px-3 pb-3 pt-1">
        <div className="flex items-end gap-1.5 bg-bg-primary rounded-lg border border-bg-border px-2 py-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your idea..."
            rows={1}
            aria-label="Chat message"
            autoFocus
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none resize-none max-h-[80px]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            aria-label="Send message"
            className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={12} />
          </button>
        </div>
        <span className="text-[10px] text-text-muted mt-1 block px-1">
          Enter to send, Shift+Enter for newline
        </span>
      </div>
    </div>
  );
}
