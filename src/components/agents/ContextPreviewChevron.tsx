import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Brain,
  Sparkles,
  Plane,
  Clock,
  Info,
} from "lucide-react";
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

export function ContextPreviewChevron({
  sessionId,
  projectPath,
}: ContextPreviewChevronProps) {
  const [open, setOpen] = useState(false);
  // Subscribe to the underlying state slices so the memo recomputes when
  // memory changes — `getContextItemsForSession` reads from `get()` so a
  // bare function-ref subscription wouldn't trigger re-renders.
  const events = useMemoryStore((s) => s.events);
  const patterns = useMemoryStore((s) => s.patterns);
  const getContextItemsForSession = useMemoryStore(
    (s) => s.getContextItemsForSession,
  );

  const items: ContextItem[] = useMemo(() => {
    if (!projectPath) return [];
    return getContextItemsForSession({ sessionId, projectPath });
    // patterns/events are read inside the store getter — track them in deps
    // so the chevron count is reactive to memory mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, sessionId, getContextItemsForSession, patterns, events]);

  if (!projectPath) return null;

  const count = items.length;

  return (
    <div className="text-[10.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-text-muted hover:text-text-secondary transition-colors"
        title={
          count === 0
            ? "No memory will be injected for this project yet"
            : "Preview the memory snippets that will be prepended to the next user turn"
        }
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Brain size={10} className="text-accent-green" />
        <span>
          Context{" "}
          <span className="text-line-strong">·</span>{" "}
          <span className="tabular-nums">{count}</span> memor{count === 1 ? "y" : "ies"}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 border border-bg-border rounded bg-bg-secondary px-2 py-1.5 flex flex-col gap-1 max-h-[180px] overflow-y-auto">
          {count === 0 ? (
            <span className="text-[10px] text-text-faint py-1">
              # No memory will be injected yet. Complete a few sessions
              to start learning, or pin a pattern from the Memory view.
            </span>
          ) : (
            items.map((it) => {
              const meta = KIND_META[it.kind];
              const Icon = meta.icon;
              return (
                <div
                  key={it.id}
                  className="flex items-start gap-1.5 text-[10.5px] leading-snug"
                >
                  <Icon size={9} className={`${meta.color} mt-0.5 flex-shrink-0`} />
                  <span className="flex-1 min-w-0 text-text-secondary truncate">
                    {it.title}
                  </span>
                  <span className="text-[9.5px] text-text-faint flex-shrink-0">
                    {relativeTime(it.timestamp)}
                  </span>
                  <span
                    className="text-text-faint hover:text-text-secondary cursor-help flex-shrink-0"
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
