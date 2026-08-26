import { useState } from "react";
import { ChevronRight } from "lucide-react";

interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
}

/**
 * Reasoning trace. Rendered as an aside in the document, not as a card: italic
 * faint text with no fill, no rail and no icon, so a long transcript reads as
 * prose rather than a stack of slabs. The expand affordance is retained, and
 * the purple accent survives only as the streaming pulse dot.
 */
export function ThinkingBlock({ text, streaming = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const charCount = text.length;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-1.5 text-left text-text-faint transition-colors hover:text-text-muted"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="text-body italic">Thinking</span>
        {streaming && (
          <span
            role="status"
            aria-label="thinking"
            className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse motion-reduce:animate-none"
          />
        )}
        <span className="ml-auto shrink-0 font-mono text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
          {charCount.toLocaleString()} chars
        </span>
      </button>
      {expanded && (
        <div className="selectable mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap pl-[18px] text-body italic text-text-faint">
          {text}
        </div>
      )}
    </div>
  );
}
