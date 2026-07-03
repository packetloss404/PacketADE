import { Sparkles } from "lucide-react";

interface MemoryInjectionCardProps {
  patterns?: number;
  summaries?: number;
  lessons?: number;
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
  lessons,
  approxTokens,
}: MemoryInjectionCardProps) {
  const stats: string[] = [];
  if (patterns != null) stats.push(`${patterns} pattern${patterns === 1 ? "" : "s"}`);
  if (lessons != null) stats.push(`${lessons} lesson${lessons === 1 ? "" : "s"}`);
  if (summaries != null) stats.push(`${summaries} session summar${summaries === 1 ? "y" : "ies"}`);
  if (approxTokens != null) stats.push(`~${approxTokens} tok`);

  return (
    <div className="flex items-start gap-2 rounded border border-dashed border-accent-line bg-accent-soft px-2 py-2 text-ui text-text-secondary">
      <Sparkles size={12} className="mt-0.5 shrink-0 text-accent-green" />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="text-meta font-semibold uppercase tracking-wide text-accent-green">
            Memory brief injected
          </span>
          {stats.length > 0 && (
            <span className="text-meta text-text-muted">{stats.join(" · ")}</span>
          )}
          <span className="flex-1" />
          <span className="text-meta text-text-muted">compact · per-conv toggle</span>
        </div>
        <div className="text-ui leading-relaxed text-text-secondary">
          A bounded brief of learned patterns, flight lessons, and recent summaries was prepended
          to the system prompt for this conversation.
        </div>
      </div>
    </div>
  );
}
