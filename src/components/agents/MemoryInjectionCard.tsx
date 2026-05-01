import { Brain } from "lucide-react";

interface MemoryInjectionCardProps {
  patterns?: number;
  summaries?: number;
  approxTokens?: number;
}

/**
 * Inline accent-tinted card surfaced at the top of a conversation when
 * `memoryContextEnabled` is true. Visually mirrors the design's
 * "Memory injected" callout — dashed accent border, brain icon, stats.
 */
export function MemoryInjectionCard({
  patterns,
  summaries,
  approxTokens,
}: MemoryInjectionCardProps) {
  const stats: string[] = [];
  if (patterns != null) stats.push(`${patterns} pattern${patterns === 1 ? "" : "s"}`);
  if (summaries != null) stats.push(`${summaries} session summar${summaries === 1 ? "y" : "ies"}`);
  if (approxTokens != null) stats.push(`~${approxTokens} tok`);

  return (
    <div className="flex items-start gap-2 px-2.5 py-2 rounded-md bg-accent-soft border border-dashed border-accent-line text-[11px] text-text-secondary">
      <Brain size={12} className="text-accent-green mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-green">
            Memory injected
          </span>
          {stats.length > 0 && (
            <span className="text-[10px] text-text-muted">
              {stats.join(" · ")}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[10px] text-text-muted">auto · per-conv toggle</span>
        </div>
        <div className="text-[11px] text-text-secondary leading-relaxed">
          Learned patterns, prior lessons, and recent session summaries
          prepended to the system prompt for this conversation.
        </div>
      </div>
    </div>
  );
}
