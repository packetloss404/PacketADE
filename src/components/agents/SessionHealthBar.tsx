import { useEffect, useMemo, useState } from "react";
import { Cpu, Coins, Gauge, GitBranch as GitBranchIcon } from "lucide-react";
import {
  aggregateConversationCost,
  formatCostPill,
} from "@/lib/conversationCost";
import { getGitBranch } from "@/lib/tauri";
import type { AgentConversation } from "@/types/agent-conversation";

/**
 * Heuristic context-window size by model id. Anthropic and most modern
 * frontier models default to 200k. We don't try to enumerate every model —
 * unknowns fall through to 200k so the gauge still renders something
 * directional. Replace with an authoritative provider-side capability map
 * when the protocol surfaces one.
 */
function contextWindowFor(model: string | undefined | null): number {
  if (!model) return 200_000;
  const id = model.toLowerCase();
  if (id.includes("haiku") || id.includes("4o-mini") || id.includes("4-mini"))
    return 200_000;
  if (id.includes("opus") || id.includes("sonnet") || id.includes("claude"))
    return 200_000;
  if (id.includes("gpt-5") || id.includes("o3") || id.includes("o4"))
    return 400_000;
  if (id.includes("gpt-4o")) return 128_000;
  if (id.includes("minimax")) return 256_000;
  return 200_000;
}

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

  // Approximate context usage as cumulative input tokens / model context
  // window. This is a worst-case proxy — real usage is closer to the last
  // turn's input — but it tracks "you are getting deep into the budget,
  // think about /compact" trends which is what the gauge is for.
  const cumulativeInput = useMemo(() => {
    let n = 0;
    for (const m of conversation.messages ?? []) {
      if (m.inputTokens) n += m.inputTokens;
    }
    return n;
  }, [conversation]);

  const ctxWindow = contextWindowFor(conversation.model);
  const ctxPct = Math.min(100, Math.round((cumulativeInput / ctxWindow) * 100));
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
        title={`Cumulative input: ~${fmtTokens(cumulativeInput)} of ~${fmtTokens(ctxWindow)} model window`}
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
