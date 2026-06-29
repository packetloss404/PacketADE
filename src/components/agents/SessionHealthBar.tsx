import { useEffect, useMemo, useState } from "react";
import { Cpu, Coins, Gauge, GitBranch as GitBranchIcon } from "lucide-react";
import {
  aggregateConversationCost,
  formatCostPill,
} from "@/lib/conversationCost";
import { getGitBranch } from "@/lib/tauri";
import { computeContextOccupancy } from "@/lib/modelContext";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface SessionHealthBarProps {
  conversation: AgentConversation;
}

/**
 * Compact "always-visible session health" strip mounted in the chat header.
 *
 * Shows model · context-budget gauge · cumulative tokens · session $ · git
 * branch. All four research reports flagged this as a baseline competitive
 * feature — every Claude Code statusline project ships an equivalent.
 *
 * Only renders for API-mode conversations (PTY conversations expose their
 * own per-CLI status bar elsewhere).
 */
export function SessionHealthBar({ conversation }: SessionHealthBarProps) {
  const [branch, setBranch] = useState<string | null>(null);

  // Per-conversation git branch poll. The shared `useGitInfo` hook is tied
  // to `layoutStore.projectPath`, but each conversation can target a
  // different project (especially in the Agents pane), so we poll directly
  // off `conversation.projectPath` here.
  useEffect(() => {
    if (!conversation.projectPath) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    const fetchBranch = () => {
      getGitBranch(conversation.projectPath)
        .then((b) => {
          if (!cancelled) setBranch(b || null);
        })
        .catch(() => {
          if (!cancelled) setBranch(null);
        });
    };
    fetchBranch();
    const id = setInterval(fetchBranch, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [conversation.projectPath]);

  const { totalTokens, estCost } = useMemo(
    () => aggregateConversationCost(conversation),
    [conversation],
  );

  // Context usage = the LATEST assistant turn's resident window
  // (input + cache read + cache write), not a cross-turn sum. Each turn
  // re-sends the whole window, so summing multi-counts the same context
  // and pins the gauge to 100%. The shared lib is the single source of
  // truth for both the window size and the occupancy math.
  const occupancy = useMemo(() => {
    const messages = conversation.messages ?? [];
    let latest: AgentMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.role === "assistant" &&
        ((m.inputTokens ?? 0) > 0 ||
          (m.cacheReadTokens ?? 0) > 0 ||
          (m.cacheWriteTokens ?? 0) > 0)
      ) {
        latest = m;
        break;
      }
    }
    return computeContextOccupancy({
      inputTokens: latest?.inputTokens,
      cacheReadTokens: latest?.cacheReadTokens,
      cacheWriteTokens: latest?.cacheWriteTokens,
      model: conversation.model,
    });
  }, [conversation.messages, conversation.model]);

  const ctxWindow = occupancy.totalTokens;
  const ctxPct = Math.round(occupancy.fraction * 100);
  const ctxColor =
    ctxPct >= 85
      ? "text-accent-red"
      : ctxPct >= 60
        ? "text-accent-amber"
        : "text-text-muted";

  const cost = formatCostPill(estCost, totalTokens);

  if (conversation.mode !== "api") return null;

  return (
    <div className="flex items-center gap-3 px-3.5 py-1 bg-bg-primary border-b border-line-soft text-[10px] text-text-muted shrink-0 overflow-hidden">
      {conversation.model && (
        <span
          className="flex items-center gap-1 shrink-0"
          title={`Active model: ${conversation.model}`}
        >
          <Cpu size={10} />
          <span className="text-text-secondary truncate max-w-[180px]">
            {conversation.model}
          </span>
        </span>
      )}

      <span
        className={`flex items-center gap-1 shrink-0 ${ctxColor}`}
        title={`Context: ~${fmtTokens(occupancy.usedTokens)} of ~${fmtTokens(ctxWindow)} model window (latest turn)`}
      >
        <Gauge size={10} />
        <span>{ctxPct}% ctx</span>
      </span>

      {totalTokens > 0 && (
        <span
          className="flex items-center gap-1 shrink-0"
          title={`Total tokens this conversation: ${totalTokens.toLocaleString()}`}
        >
          <span>{fmtTokens(totalTokens)} tok</span>
        </span>
      )}

      {cost && (
        <span
          className="flex items-center gap-1 shrink-0"
          title="Estimated session cost (sums per-message tokens × model rates)"
        >
          <Coins size={10} />
          <span>{cost}</span>
        </span>
      )}

      {branch && (
        <span
          className="flex items-center gap-1 shrink-0 truncate"
          title={`Git branch in ${conversation.projectPath}`}
        >
          <GitBranchIcon size={10} />
          <span className="truncate max-w-[140px]">{branch}</span>
        </span>
      )}
    </div>
  );
}
