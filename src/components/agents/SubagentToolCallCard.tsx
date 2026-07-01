import { memo, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { BaseToolCard } from "./tool-cards/BaseToolCard";
import { StatusPill } from "./tool-cards/StatusPill";

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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function SubagentToolCallCardImpl({
  toolCall,
  conversationId: _conversationId,
  verbosity = "normal",
}: SubagentToolCallCardProps) {
  const { task, model } = useMemo(
    () => parseSubagentInput(toolCall.input),
    [toolCall.input],
  );

  const [expanded, setExpanded] = useState(verbosity === "verbose");

  // Keep expand state in sync when the per-conversation verbosity control
  // changes after the card has mounted.
  useEffect(() => {
    setExpanded(verbosity === "verbose");
  }, [verbosity]);

  const body = toolCall.fullContent ?? toolCall.summary ?? "";
  const hasBody = body.trim().length > 0;
  const canToggle = verbosity !== "summary" && hasBody;

  const taskDisplay = task || "(no task)";
  const headerTask = expanded ? taskDisplay : truncate(taskDisplay, 80);

  const pill =
    toolCall.status === "running" ? (
      <StatusPill status="running" />
    ) : (
      <StatusPill status={toolCall.status} variant="label" />
    );

  const subHeader =
    verbosity === "verbose" && model ? (
      <div className="px-2 pb-1 font-mono text-[10px] text-text-faint truncate">
        model: {model}
      </div>
    ) : undefined;

  return (
    <BaseToolCard
      icon={<Bot size={11} className="text-accent-green shrink-0" />}
      title={<span className="italic">{headerTask}</span>}
      titleAttr={taskDisplay}
      statusPill={pill}
      subHeader={subHeader}
      canToggle={canToggle}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={{
        expanded: "Collapse summary",
        collapsed: "Expand summary",
      }}
      isError={toolCall.status === "error"}
      footer={
        <div className="px-2 pb-1 flex items-center gap-1 text-[9px] uppercase tracking-wide text-text-faint">
          <Bot size={9} />
          <span>Sub-agent</span>
        </div>
      }
    >
      <div className="bg-bg-primary rounded p-2 mx-1 mb-1 text-text-primary overflow-y-auto max-h-[320px]">
        <MarkdownRenderer
          content={body}
          className="text-[11px] leading-relaxed"
        />
        {verbosity === "verbose" && toolCall.input && (
          <pre className="mt-2 pt-2 border-t border-bg-border text-[10px] font-mono whitespace-pre-wrap text-text-muted">
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
    </BaseToolCard>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const SubagentToolCallCard = memo(SubagentToolCallCardImpl);
