import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Square } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { aggregateConversationCost } from "@/lib/conversationCost";
import { useConversationAttention } from "@/lib/sessionStatus";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Toolbar chip + dropdown for running API conversations. Mirrors Claude
 * Code's `Ctrl+B / /tasks` background-agent tray: shows how many agents are
 * currently doing work, with one click to jump into any of them. Lives in
 * the Toolbar so it's reachable from any view, not just the Agents pane —
 * users can navigate away to triage issues, deploy, etc., and still see a
 * persistent indicator of agents still chewing.
 */
export function RunningAgentsChip() {
  const conversations = useAgentTaskStore((s) => s.conversations);
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  const cancelActiveConversation = useAgentTaskStore(
    (s) => s.cancelActiveConversation,
  );
  const setActiveView = useAppStore((s) => s.setActiveView);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Tile program (P4-S1): "running" is derived from the SINGLE status truth
  // (sessionStatus attention === "working"), not a bespoke streaming scan, so
  // the chip, the tab-strip dot, and the sidebar can never disagree.
  const attention = useConversationAttention();
  const running = useMemo(
    () =>
      conversations.filter(
        (c) => c.mode === "api" && attention.get(c.id) === "working",
      ),
    [conversations, attention],
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (running.length === 0) return null;

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-accent-green/15 text-accent-green hover:bg-accent-green/25 transition-colors"
        title={`${running.length} agent${running.length === 1 ? "" : "s"} running — click to inspect`}
      >
        <Loader2 size={11} className="animate-spin" />
        <span>{running.length}</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-72 bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-muted">
            Running agents
          </div>
          {running.map((conv) => {
            const { totalTokens } = aggregateConversationCost(conv);
            return (
              <div
                key={conv.id}
                className="flex items-center gap-2 px-2 py-1.5 hover:bg-bg-hover transition-colors"
              >
                <Bot size={11} className="text-accent-green shrink-0" />
                <button
                  type="button"
                  onClick={() => {
                    selectConversation(conv.id);
                    setActiveView("agents");
                    setOpen(false);
                  }}
                  className="flex flex-col flex-1 min-w-0 text-left"
                  title={`Open "${conv.title}" in the Agents pane`}
                >
                  <span className="text-[11px] text-text-primary truncate">
                    {conv.title}
                  </span>
                  <span className="text-[9px] text-text-muted">
                    {conv.model ?? "?"} · {fmtTokens(totalTokens)} tok
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void cancelActiveConversation(conv.id)}
                  className="p-1 rounded text-text-muted hover:text-accent-red hover:bg-bg-hover"
                  title="Stop this agent"
                >
                  <Square size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
