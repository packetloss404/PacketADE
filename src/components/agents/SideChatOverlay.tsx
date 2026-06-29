import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, MessageSquarePlus, MessageSquareShare, Send, X } from "lucide-react";
import { useSideChatStore } from "@/stores/sideChatStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

/**
 * Floating bottom-right side chat panel. Visually distinct from the main
 * chat (purple accent border, smaller text). Toggled via Cmd/Ctrl+;.
 */
export function SideChatOverlay() {
  const open = useSideChatStore((s) => s.open);
  const question = useSideChatStore((s) => s.question);
  const answer = useSideChatStore((s) => s.answer);
  const isStreaming = useSideChatStore((s) => s.isStreaming);
  const setQuestion = useSideChatStore((s) => s.setQuestion);
  const ask = useSideChatStore((s) => s.ask);
  const close = useSideChatStore((s) => s.close);

  const selectedConversationId = useAgentTaskStore((s) => s.selectedConversationId);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = useState(false);

  // Autofocus textarea when opened.
  useEffect(() => {
    if (open) {
      textareaRef.current?.focus();
    }
  }, [open]);

  // Reset copy feedback when answer changes or overlay closes.
  useEffect(() => {
    if (!copied) return;
    const handle = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(handle);
  }, [copied]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };

  const canPromote = answer.length > 0 && !isStreaming;
  const hasConversation = Boolean(selectedConversationId);

  const buildCitation = (): string => {
    return `> Side-chat: ${question}\n> \n> ${answer.replace(/\n/g, "\n> ")}`;
  };

  const handleInsertIntoChat = () => {
    const convId = useAgentTaskStore.getState().selectedConversationId;
    if (!convId) return;
    const citation = buildCitation();
    useAgentTaskStore.getState().sendMessage(convId, citation);
    // Clear side-chat state and close the overlay.
    useSideChatStore.getState().close();
    useSideChatStore.setState({ question: "", answer: "" });
  };

  const handleCopyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
    } catch {
      // Clipboard write failed — leave the user to retry.
    }
  };

  return (
    <div
      className="fixed bottom-[34px] right-4 w-[320px] h-[400px] bg-bg-secondary border border-accent-purple/30 rounded shadow-2xl flex flex-col z-50 text-[11px] origin-bottom-right animate-[welcomeFadeIn_150ms_ease-out] motion-reduce:animate-none"
      role="dialog"
      aria-label="Side chat"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border">
        <div className="flex items-center gap-1.5">
          <MessageSquarePlus size={12} className="text-accent-purple" />
          <span className="text-xs font-semibold text-text-primary">Side chat</span>
        </div>
        <button
          onClick={close}
          className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close side chat"
        >
          <X size={12} />
        </button>
      </div>

      {/* Answer area */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 text-text-secondary"
        aria-live="polite"
        aria-busy={isStreaming}
      >
        {!answer && !isStreaming && (
          <p className="text-text-muted italic">
            Ask a quick question about the current conversation context. Answers stay here and don't pollute the main thread.
          </p>
        )}
        {isStreaming && answer.length === 0 && (
          <div className="flex items-center gap-1.5 text-text-muted">
            <Loader2 size={12} className="animate-spin text-accent-purple" />
            Thinking…
          </div>
        )}
        {answer && (
          <div className="leading-relaxed">
            <MarkdownRenderer content={answer} className="text-[11px]" />
            {isStreaming && (
              <span
                className="inline-block w-1.5 h-3 bg-accent-purple/70 animate-pulse ml-0.5 align-baseline"
                aria-hidden="true"
              />
            )}
          </div>
        )}
        {canPromote && (
          <div className="mt-2 pt-2 border-t border-bg-border flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleInsertIntoChat}
              disabled={!hasConversation}
              title={hasConversation ? "Insert this Q+A as context into the active main thread" : "Open a conversation in the Agents tab first"}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-accent-purple/15 text-accent-purple hover:bg-accent-purple/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <MessageSquareShare size={12} />
              <span>Insert into chat</span>
            </button>
            <button
              type="button"
              onClick={handleCopyAnswer}
              title="Copy answer to clipboard"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            >
              {copied ? <Check size={12} className="text-accent-green" /> : <Copy size={12} />}
              <span>{copied ? "Copied" : "Copy answer"}</span>
            </button>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-bg-border p-2 flex gap-1.5">
        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything..."
          rows={2}
          className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent-purple/50"
          disabled={isStreaming}
        />
        <button
          type="submit"
          disabled={isStreaming || !question.trim()}
          className="self-end p-1.5 rounded bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Send"
        >
          <Send size={12} />
        </button>
      </form>
    </div>
  );
}
