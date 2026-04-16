import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
}

export function ThinkingBlock({ text, streaming = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const charCount = text.length;

  return (
    <div className="border-l-2 border-accent-purple/40 bg-bg-secondary/50 rounded-r my-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 w-full text-left px-2 py-1 hover:bg-bg-hover/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-secondary" />
        ) : (
          <ChevronRight size={12} className="text-text-secondary" />
        )}
        <Brain size={12} className="text-accent-purple" />
        <span className="text-[11px] italic text-text-secondary">Thinking</span>
        {streaming && (
          <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse" />
        )}
        <span className="ml-auto text-[10px] text-text-muted font-mono">
          {charCount.toLocaleString()} chars
        </span>
      </button>
      {expanded && (
        <pre className="text-[11px] font-mono text-text-secondary px-2 pb-2 pt-1 max-h-48 overflow-y-auto whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}
