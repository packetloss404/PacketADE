import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ToolDiffView } from "../ToolDiffView";
import { StatusPill } from "../tool-cards/StatusPill";
import type { AgentToolCall } from "@/types/agent-conversation";

interface WriteFileInput {
  path?: string;
  content?: string;
}

/**
 * Parse a tool call's `input` field (if captured on the tool call) for
 * write_file path+content. Returns null if unavailable or malformed.
 */
function parseWriteFileInput(tc: AgentToolCall): WriteFileInput | null {
  const anyTc = tc as AgentToolCall & { input?: unknown };
  const raw = anyTc.input;
  if (raw == null) return null;
  try {
    let obj: unknown = raw;
    if (typeof raw === "string") obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const path =
        typeof rec.path === "string"
          ? rec.path
          : typeof rec.file_path === "string"
            ? (rec.file_path as string)
            : undefined;
      const content =
        typeof rec.content === "string" ? rec.content : undefined;
      if (path && content != null) return { path, content };
    }
  } catch {
    return null;
  }
  return null;
}

export function ToolCallCard({
  toolCall,
  projectPath,
  verbosity = "normal",
}: {
  toolCall: AgentToolCall;
  projectPath: string;
  verbosity?: "summary" | "normal" | "verbose";
}) {
  const [expanded, setExpanded] = useState(verbosity === "verbose");

  // Keep expand state in sync when the per-conversation verbosity control
  // changes after the card has mounted.
  useEffect(() => {
    setExpanded(verbosity === "verbose");
  }, [verbosity]);

  const writeFileInput =
    toolCall.name === "write_file" ? parseWriteFileInput(toolCall) : null;

  const statusPill =
    toolCall.status === "running" ? (
      <StatusPill status="running" />
    ) : (
      <StatusPill status={toolCall.status} variant="label" />
    );

  const isError = toolCall.status === "error";

  if (writeFileInput) {
    return (
      <div
        className={`border rounded overflow-hidden ${
          isError
            ? "border-accent-red/30 bg-accent-red/5"
            : "border-bg-border bg-bg-secondary"
        }`}
      >
        <div className="flex items-center gap-2 px-2 py-1 bg-bg-tertiary border-b border-line-soft">
          <span className="text-xs font-medium text-text-primary">Edit</span>
          {toolCall.file && (
            <span className="font-mono text-[10px] text-text-secondary truncate">
              {toolCall.file}
            </span>
          )}
          <span className="flex-1" />
          {statusPill}
        </div>
        <ToolDiffView
          projectPath={projectPath}
          filePath={writeFileInput.path!}
          newContent={writeFileInput.content!}
        />
      </div>
    );
  }

  const summary = toolCall.summary ?? "";
  const fullContent = toolCall.fullContent ?? summary;
  const summaryPreview = summary.split("\n").slice(0, 2).join("\n");
  const hasMore =
    (toolCall.fullContent && toolCall.fullContent !== summary) ||
    summary.split("\n").length > 2 ||
    summary.length > 160;

  return (
    <div
      className={`border rounded overflow-hidden ${
        isError
          ? "border-accent-red/30 bg-accent-red/5"
          : "border-bg-border bg-bg-secondary"
      }`}
    >
      <button
        type="button"
        onClick={() => hasMore && setExpanded((v) => !v)}
        aria-expanded={hasMore ? expanded : undefined}
        className={`w-full flex items-center gap-2 px-2 py-1 text-left bg-bg-tertiary ${
          hasMore ? "hover:bg-bg-elevated cursor-pointer" : "cursor-default"
        } ${expanded && hasMore ? "border-b border-line-soft" : ""} transition-colors`}
      >
        <span className="text-xs font-medium text-text-primary">
          {toolCall.name}
        </span>
        {toolCall.file && (
          <span className="font-mono text-[10px] text-text-secondary truncate">
            {toolCall.file}
          </span>
        )}
        {!expanded && summaryPreview && verbosity !== "summary" && (
          <span className="ml-1 truncate text-text-muted text-[10px] flex-1 min-w-0">
            {summaryPreview.replace(/\n/g, " ↵ ")}
          </span>
        )}
        <span className="flex-1" />
        {statusPill}
        {hasMore && (
          <ChevronRight
            size={10}
            className={`text-text-muted shrink-0 transition-transform motion-reduce:transition-none ${
              expanded ? "rotate-90" : ""
            }`}
          />
        )}
      </button>
      {expanded && hasMore && (
        <pre className="text-[11px] font-mono whitespace-pre-wrap bg-bg-primary p-2 max-h-96 overflow-y-auto text-text-primary">
          {fullContent}
        </pre>
      )}
      {expanded && verbosity === "verbose" && toolCall.input && (
        <pre className="text-[10px] font-mono whitespace-pre-wrap bg-bg-secondary border-t border-line-soft p-2 max-h-48 overflow-y-auto text-text-muted">
          input: {toolCall.input}
        </pre>
      )}
    </div>
  );
}
