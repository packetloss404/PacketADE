import { useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";

interface SubagentInput {
  task: string;
  model?: string;
}

interface SubagentToolCallCardProps {
  toolCall: AgentToolCall;
  conversationId: string;
  verbosity?: "summary" | "normal" | "verbose";
}

function parseSubagentInput(raw: string | undefined): SubagentInput {
  if (!raw) return { task: "" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const task = typeof parsed.task === "string" ? parsed.task : "";
    const model = typeof parsed.model === "string" ? parsed.model : undefined;
    return { task, model };
  } catch {
    return { task: raw };
  }
}

function StatusPill({ status }: { status: AgentToolCall["status"] }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-bg-primary text-text-muted text-[10px] font-mono">
        <Loader2 size={10} className="animate-spin" />
        running
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-accent-red/10 text-accent-red text-[10px] font-mono">
        <XCircle size={10} />
        error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-accent-green/10 text-accent-green text-[10px] font-mono">
      <CheckCircle2 size={10} />
      done
    </span>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function SubagentToolCallCard({
  toolCall,
  conversationId: _conversationId,
  verbosity = "normal",
}: SubagentToolCallCardProps) {
  const { task, model } = useMemo(
    () => parseSubagentInput(toolCall.input),
    [toolCall.input],
  );

  const [expanded, setExpanded] = useState(verbosity === "verbose");

  const body = toolCall.fullContent ?? toolCall.summary ?? "";
  const hasBody = body.trim().length > 0;
  const showBody = verbosity !== "summary" && expanded && hasBody;
  const canToggle = verbosity !== "summary" && hasBody;

  const taskDisplay = task || "(no task)";
  const headerTask = expanded ? taskDisplay : truncate(taskDisplay, 80);

  return (
    <div className="bg-bg-hover rounded text-[10px] text-text-muted border border-bg-border/50">
      <div className="flex items-center gap-1.5 px-2 py-1">
        {canToggle ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label={expanded ? "Collapse summary" : "Expand summary"}
          >
            {expanded ? (
              <ChevronDown size={10} />
            ) : (
              <ChevronRight size={10} />
            )}
          </button>
        ) : (
          <span className="w-[10px]" />
        )}
        <Bot size={11} className="text-accent-green shrink-0" />
        <span
          className="italic text-text-primary truncate flex-1 min-w-0"
          title={taskDisplay}
        >
          {headerTask}
        </span>
        <StatusPill status={toolCall.status} />
      </div>
      {verbosity === "verbose" && model && (
        <div className="px-2 pb-1 font-mono text-[10px] text-text-muted/80 truncate">
          model: {model}
        </div>
      )}
      {showBody && (
        <div className="bg-bg-primary rounded p-2 mx-1 mb-1 text-text-primary overflow-y-auto" style={{ maxHeight: 320 }}>
          <MarkdownRenderer
            content={body}
            className="text-[11px] leading-relaxed"
          />
          {verbosity === "verbose" && toolCall.input && (
            <pre className="mt-2 pt-2 border-t border-bg-border/50 text-[10px] font-mono whitespace-pre-wrap text-text-muted">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(toolCall.input), null, 2);
                } catch {
                  return toolCall.input;
                }
              })()}
            </pre>
          )}
        </div>
      )}
      <div className="px-2 pb-1 flex items-center gap-1 text-[9px] uppercase tracking-wide text-text-muted/70">
        <Bot size={9} />
        <span>Sub-agent</span>
      </div>
    </div>
  );
}
