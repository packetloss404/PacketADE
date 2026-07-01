import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";

interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
}

export function ThinkingBlock({ text, streaming = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const charCount = text.length;

  return (
    <div className="border-l-2 border-accent-purple/40 bg-bg-secondary rounded-r my-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 w-full text-left px-2 py-1 hover:bg-bg-hover transition-colors"
      >
        <ChevronRight
          size={12}
          className={`text-text-secondary shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <Brain size={12} className="text-accent-purple" />
        <span className="text-[11px] italic text-text-secondary">Thinking</span>
        {streaming && (
          <span
            role="status"
            aria-label="thinking"
            className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse motion-reduce:animate-none"
          />
        )}
        <span className="ml-auto text-[10px] text-text-muted font-mono">
          {charCount.toLocaleString()} chars
        </span>
      </button>
      {expanded && (
        <div className="text-[11px] leading-relaxed text-text-secondary px-2 pb-2 pt-1 max-h-48 overflow-y-auto whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
