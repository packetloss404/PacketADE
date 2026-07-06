import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { memoryBriefStats, type MemoryBrief } from "@/stores/memoryStore";

interface MemoryInjectionCardProps {
  brief: MemoryBrief;
}

/**
 * P2-18: the transcript's ambient memory affordance, shrunk to a one-line
 * collapsed row — the header flyout (HeaderOverflowMenu) is the surface
 * for the full preview now. Rendered whenever `memoryContextEnabled` is
 * on (even with 0 items) as the visible confirmation the toggle is ON.
 */
export function MemoryInjectionCard({ brief }: MemoryInjectionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = memoryBriefStats(brief);

  return (
    <div className="rounded border border-dashed border-accent-line bg-accent-soft text-ui text-text-secondary">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <Sparkles size={12} className="shrink-0 text-accent-green" />
        <span className="text-meta font-semibold uppercase tracking-wide text-accent-green">
          Memory brief
        </span>
        <span className="text-meta tabular-nums text-text-muted">
          {stats.patterns} pattern{stats.patterns === 1 ? "" : "s"} ·{" "}
          {stats.lessons} lesson{stats.lessons === 1 ? "" : "s"} · ~
          {stats.approxTokens} tok
        </span>
        <span className="flex-1" />
        <ChevronDown
          size={11}
          className={`shrink-0 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="space-y-1 px-2 pb-2 pt-0.5">
          {brief.items.length === 0 ? (
            <div className="text-meta text-text-muted">
              No sources yet — memory is on; briefs appear once sessions are
              learned.
            </div>
          ) : (
            brief.items.map((item) => (
              <div key={item.id} className="truncate text-ui text-text-secondary">
                <span className="mr-1 text-meta uppercase text-text-muted">
                  {item.kind}
                </span>
                {item.title}
              </div>
            ))
          )}
          {brief.truncated && (
            <div className="text-meta text-text-muted">
              (truncated to fit {brief.charBudget}-char budget)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
