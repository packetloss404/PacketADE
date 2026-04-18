import { useEffect, useRef } from "react";
import { MessageSquarePlus, Send, X } from "lucide-react";
import { useSideChatStore } from "@/stores/sideChatStore";

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

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus textarea when opened.
  useEffect(() => {
    if (open) {
      textareaRef.current?.focus();
    }
  }, [open]);

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

  return (
    <div
      className="fixed bottom-4 right-4 w-[320px] h-[400px] bg-bg-secondary border border-accent-purple/30 rounded-lg shadow-2xl flex flex-col z-50 text-[11px]"
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
      <div className="flex-1 overflow-y-auto px-3 py-2 text-text-secondary">
        {!answer && !isStreaming && (
          <p className="text-text-muted italic">
            Ask a quick question about the current conversation context. Answers stay here and don't pollute the main thread.
          </p>
        )}
        {isStreaming && (
          <p className="text-text-muted">Thinking...</p>
        )}
        {answer && !isStreaming && (
          <p className="whitespace-pre-wrap leading-relaxed">{answer}</p>
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
          className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary placeholder-text-muted resize-none focus:outline-none focus:border-accent-purple/50"
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
