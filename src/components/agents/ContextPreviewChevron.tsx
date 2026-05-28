import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Brain, Sparkles, Plane, Clock, Info } from "lucide-react";
import { useMemoryStore } from "@/stores/memoryStore";
import { relativeTime } from "@/lib/time";
import type { ContextItem, ContextItemKind } from "@/stores/memoryStore";

/**
 * v0.8-H: collapsible chevron mounted in the AgentInputArea toolbar
 * that previews the memory items that will be injected into the next
 * user turn. Lifted from the visual pattern in MemoryView's
 * "Injected next session" sidebar block but stripped down to a row
 * list — no markdown rendering, no token-cost panel.
 *
 * Reactive to `useMemoryStore` so adding / removing / pinning a
 * pattern updates the chevron's count live without needing the agent
 * area to remount.
 */
export interface ContextPreviewChevronProps {
  /** Future session this chevron is previewing. The composer has no
   *  session id yet because no conversation is started; we keep the
   *  prop for symmetry with the store contract and forward it through. */
  sessionId?: string;
  /** Project path used to scope memory lookups. When empty/undefined
   *  the chevron renders nothing — there's no project context to
   *  preview yet. */
  projectPath?: string;
}

const KIND_META: Record<
  ContextItemKind,
  {
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    color: string;
  }
> = {
  pattern: { label: "Pattern", icon: Sparkles, color: "text-accent-amber" },
  lesson: { label: "Lesson", icon: Plane, color: "text-accent-blue" },
  session: { label: "Session", icon: Clock, color: "text-accent-green" },
};

export function ContextPreviewChevron({ sessionId, projectPath }: ContextPreviewChevronProps) {
  const [open, setOpen] = useState(false);
  // Subscribe to the underlying state slices so the memo recomputes when
  // memory changes — `getContextItemsForSession` reads from `get()` so a
  // bare function-ref subscription wouldn't trigger re-renders.
  const events = useMemoryStore((s) => s.events);
  const patterns = useMemoryStore((s) => s.patterns);
  const getContextItemsForSession = useMemoryStore((s) => s.getContextItemsForSession);

  const items: ContextItem[] = useMemo(() => {
    if (!projectPath) return [];
    return getContextItemsForSession({ sessionId, projectPath });
    // patterns/events are read inside the store getter — track them in deps
    // so the chevron count is reactive to memory mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, sessionId, getContextItemsForSession, patterns, events]);

  if (!projectPath) return null;

  const count = items.length;
  const patternCount = items.filter((item) => item.kind === "pattern").length;
  const lessonCount = items.filter((item) => item.kind === "lesson").length;
  const sessionCount = items.filter((item) => item.kind === "session").length;
  const approxTokens = Math.max(
    0,
    Math.round(items.reduce((sum, item) => sum + item.title.length + item.reason.length, 0) / 4),
  );

  return (
    <div className="text-[10.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-text-muted transition-colors hover:text-text-secondary"
        title={
          count === 0
            ? "No memory brief sources will be injected for this project yet"
            : "Preview the compact memory brief that will be prepended to the next user turn"
        }
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Brain size={10} className="text-accent-green" />
        <span>
          Memory brief <span className="text-line-strong">·</span>{" "}
          <span className="tabular-nums">{count}</span> source
          {count === 1 ? "" : "s"}
          {count > 0 && (
            <>
              <span className="text-line-strong"> · </span>
              <span className="tabular-nums">~{approxTokens}</span> tok
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 flex max-h-[180px] flex-col gap-1 overflow-y-auto rounded border border-bg-border bg-bg-secondary px-2 py-1.5">
          {count > 0 && (
            <div className="mb-0.5 flex items-center gap-1.5 text-[9.5px] text-text-faint">
              <span>{patternCount} patterns</span>
              <span className="text-line-strong">·</span>
              <span>{lessonCount} lessons</span>
              <span className="text-line-strong">·</span>
              <span>{sessionCount} summaries</span>
            </div>
          )}
          {count === 0 ? (
            <span className="py-1 text-[10px] text-text-faint">
              # No memory brief sources yet. Complete a few sessions to start learning, or pin a
              pattern from the Memory view.
            </span>
          ) : (
            items.map((it) => {
              const meta = KIND_META[it.kind];
              const Icon = meta.icon;
              return (
                <div key={it.id} className="flex items-start gap-1.5 text-[10.5px] leading-snug">
                  <Icon size={9} className={`${meta.color} mt-0.5 flex-shrink-0`} />
                  <span className="min-w-0 flex-1 truncate text-text-secondary">{it.title}</span>
                  <span className="flex-shrink-0 text-[9.5px] text-text-faint">
                    {relativeTime(it.timestamp)}
                  </span>
                  <span
                    className="flex-shrink-0 cursor-help text-text-faint hover:text-text-secondary"
                    title={`Why this? ${it.reason}`}
                  >
                    <Info size={9} />
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
