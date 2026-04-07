import { useState, useRef, useEffect, useCallback, memo } from "react";
import { Send, Bot, User, Loader2, Sparkles } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { askAgentChatStream } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";

interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface AgentChatPanelProps {
  agentId: string;
  title?: string;
}

const ChatBubble = memo(function ChatBubble({
  message,
}: {
  message: AgentChatMessage;
}) {
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

export function AgentChatPanel({ agentId, title }: AgentChatPanelProps) {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [input, setInput] = useState("");

  const msgCounterRef = useRef(0);
  const unlistenChunkRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const cleanupListeners = useCallback(() => {
    if (unlistenChunkRef.current) {
      unlistenChunkRef.current();
      unlistenChunkRef.current = null;
    }
    if (unlistenDoneRef.current) {
      unlistenDoneRef.current();
      unlistenDoneRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupListeners();
    };
  }, [cleanupListeners]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (isLoading) return;

      const msgId = ++msgCounterRef.current;
      const userMsg: AgentChatMessage = {
        id: `ac_${msgId}`,
        role: "user",
        content,
      };

      let allMessages: { role: string; content: string }[] = [];
      setMessages((prev) => {
        const next = [...prev, userMsg];
        allMessages = next.map((m) => ({ role: m.role, content: m.content }));
        return next;
      });

      setIsLoading(true);
      setStreamingContent("");
      cleanupListeners();

      let accumulated = "";

      try {
        const unlistenChunk = await listen<string>(
          "agent-chat:chunk",
          (event) => {
            accumulated += event.payload + "\n";
            if (mountedRef.current) {
              setStreamingContent(accumulated);
            }
          },
        );
        unlistenChunkRef.current = unlistenChunk;

        const donePromise = new Promise<boolean>((resolve) => {
          listen<boolean>("agent-chat:done", (event) => {
            resolve(event.payload);
          }).then((unlisten) => {
            unlistenDoneRef.current = unlisten;
          });
        });

        const projectPath = useLayoutStore.getState().projectPath;
        await askAgentChatStream(projectPath, allMessages, `agent:${agentId}`);
        await donePromise;

        cleanupListeners();

        if (!mountedRef.current) return;

        const finalContent = accumulated.trim();
        const assistantMsg: AgentChatMessage = {
          id: `ac_${++msgCounterRef.current}`,
          role: "assistant",
          content: finalContent,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setStreamingContent("");
        setIsLoading(false);
      } catch (err) {
        cleanupListeners();
        if (!mountedRef.current) return;

        const errorMsg: AgentChatMessage = {
          id: `ac_${++msgCounterRef.current}`,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        };
        setMessages((prev) => [...prev, errorMsg]);
        setStreamingContent("");
        setIsLoading(false);
      }
    },
    [isLoading, agentId, cleanupListeners],
  );

  function handleSend() {
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const headerTitle = title ?? `${agentId} chat`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-bg-border">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-accent-purple" />
          <span className="text-[11px] font-medium text-text-secondary">
            {headerTitle}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-text-muted">
            <Bot size={24} className="text-accent-purple/40" />
            <p className="text-[11px] text-center leading-relaxed">
              Send a message to start chatting with {agentId}.
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

      {/* Input */}
      <div className="px-3 pb-3 pt-1">
        <div className="flex items-end gap-1.5 bg-bg-primary rounded-lg border border-bg-border px-2 py-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${agentId}...`}
            rows={1}
            aria-label="Chat message"
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
