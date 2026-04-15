import { useState, useRef, useEffect } from "react";
import { Lightbulb, Plus, Trash2, Send, Loader2, MessageSquare, Terminal, Brain } from "lucide-react";
import { useInsightsStore } from "@/stores/insightsStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { writePty } from "@/lib/tauri";
import { relativeTime } from "@/lib/time";

export function InsightsView() {
  const sessions = useInsightsStore((s) => s.sessions);
  const activeSessionId = useInsightsStore((s) => s.activeSessionId);
  const isStreaming = useInsightsStore((s) => s.isStreaming);
  const createSession = useInsightsStore((s) => s.createSession);
  const deleteSession = useInsightsStore((s) => s.deleteSession);
  const setActiveSession = useInsightsStore((s) => s.setActiveSession);
  const sendMessage = useInsightsStore((s) => s.sendMessage);
  const includeMemoryContext = useInsightsStore((s) => s.includeMemoryContext);
  const setIncludeMemoryContext = useInsightsStore((s) => s.setIncludeMemoryContext);
  const projectPath = useLayoutStore((s) => s.projectPath);

  const [input, setInput] = useState("");
  const [sentMsgId, setSentMsgId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages]);

  // Focus textarea on session change
  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeSessionId]);

  function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    void sendMessage(projectPath, text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSendToTerminal(msgId: string, content: string) {
    const { panes, activePaneId } = useLayoutStore.getState();
    const pane = panes.find((p) => p.id === activePaneId);
    if (!pane?.sessionId) {
      alert("No active terminal");
      return;
    }
    await writePty(pane.sessionId, content + "\n");
    setSentMsgId(msgId);
    setTimeout(() => setSentMsgId(null), 1500);
  }

  function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    deleteSession(id);
  }

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      {/* Left panel: session list */}
      <div className="w-[260px] min-w-[200px] border-r border-bg-border flex flex-col bg-bg-secondary">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bg-border">
          <Lightbulb size={13} className="text-accent-amber" />
          <span className="text-xs font-semibold text-text-primary">Insights</span>
          <span className="text-[10px] text-text-muted">({sessions.length})</span>
          <div className="flex-1" />
          <button
            onClick={() => createSession()}
            className="p-1 text-accent-green hover:bg-accent-green/10 rounded transition-colors"
            title="New conversation"
          >
            <Plus size={12} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-text-muted">
              <MessageSquare size={24} className="text-text-muted/30" />
              <p className="text-[11px] text-center px-4">
                No conversations yet. Start one to get AI-powered insights about your project.
              </p>
              <button
                onClick={() => createSession()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
              >
                <Plus size={11} />
                New Conversation
              </button>
            </div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className={`w-full text-left px-3 py-2 border-b border-bg-border/50 hover:bg-bg-tertiary transition-colors group ${
                  session.id === activeSessionId ? "bg-bg-tertiary" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="text-xs text-text-primary truncate flex-1">
                    {session.title}
                  </span>
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    className="p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-text-muted">
                    {session.messages.length} msg{session.messages.length !== 1 ? "s" : ""}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {relativeTime(session.updatedAt)}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel: chat */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {activeSession ? (
          <>
            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {activeSession.messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-text-muted gap-2">
                  <Lightbulb size={28} className="text-text-muted/20" />
                  <p className="text-xs">Ask a question about your project</p>
                </div>
              )}
              {activeSession.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-3 py-2 ${
                      msg.role === "user"
                        ? "bg-accent-blue/15 text-text-primary"
                        : "bg-bg-secondary text-text-primary border border-bg-border"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="text-xs leading-relaxed prose-compact">
                        <MarkdownRenderer content={msg.content} />
                        {msg.content && (
                          <button
                            onClick={() => handleSendToTerminal(msg.id, msg.content)}
                            className="flex items-center gap-1 mt-2 text-[10px] text-accent-purple hover:text-accent-purple/80 transition-colors"
                          >
                            <Terminal size={10} />
                            {sentMsgId === msg.id ? "Sent!" : "Send to terminal"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed whitespace-pre-wrap">
                        {msg.content}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {isStreaming && activeSession.messages.length > 0 &&
                activeSession.messages[activeSession.messages.length - 1]?.role === "assistant" &&
                activeSession.messages[activeSession.messages.length - 1]?.content === "" && (
                <div className="flex items-center gap-2 text-text-muted text-[11px]">
                  <Loader2 size={12} className="animate-spin" />
                  Thinking...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="border-t border-bg-border px-4 py-3 bg-bg-secondary">
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setIncludeMemoryContext(!includeMemoryContext)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                    includeMemoryContext
                      ? "bg-accent-purple/15 text-accent-purple border border-accent-purple/30"
                      : "bg-bg-tertiary text-text-muted border border-bg-border hover:bg-bg-tertiary/80"
                  }`}
                  title={includeMemoryContext ? "Memory context included — click to disable" : "Memory context excluded — click to enable"}
                >
                  <Brain size={11} />
                  {includeMemoryContext ? "Memory active" : "Memory off"}
                </button>
              </div>
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your codebase..."
                  disabled={isStreaming}
                  rows={1}
                  className="flex-1 bg-bg-primary text-text-primary text-xs px-3 py-2 rounded border border-bg-border resize-none focus:outline-none focus:border-accent-blue/50 placeholder-text-muted disabled:opacity-50"
                  style={{ minHeight: 36, maxHeight: 120 }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = Math.min(target.scrollHeight, 120) + "px";
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  className="p-2 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Send (Enter)"
                >
                  {isStreaming ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Send size={14} />
                  )}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-text-muted gap-3">
            <Lightbulb size={32} className="text-text-muted/20" />
            <p className="text-xs">Select a conversation or start a new one</p>
            <button
              onClick={() => createSession()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors"
            >
              <Plus size={11} />
              New Conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
