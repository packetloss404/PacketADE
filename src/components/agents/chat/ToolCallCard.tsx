import { useState } from "react";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react";
import { ToolDiffView } from "../ToolDiffView";
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

  const writeFileInput =
    toolCall.name === "write_file" ? parseWriteFileInput(toolCall) : null;

  const statusIcon =
    toolCall.status === "running" ? (
      <Loader2 size={10} className="animate-spin" />
    ) : toolCall.status === "error" ? (
      <XCircle size={10} className="text-accent-red" />
    ) : (
      <CheckCircle size={10} className="text-accent-green" />
    );

  const dotClass =
    toolCall.status === "running"
      ? "bg-accent-amber animate-pulse"
      : toolCall.status === "error"
        ? "bg-accent-red"
        : "bg-accent-green";

  if (writeFileInput) {
    return (
      <div className="border border-bg-border rounded-md overflow-hidden bg-bg-secondary">
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-tertiary border-b border-line-soft">
          {statusIcon}
          <span className="text-[12px] font-medium text-text-primary">Edit</span>
          {toolCall.file && (
            <span className="font-mono text-[10.5px] text-text-secondary truncate">
              {toolCall.file}
            </span>
          )}
          <span className="flex-1" />
          <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
          <span className="text-[10.5px] capitalize text-text-secondary">
            {toolCall.status}
          </span>
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
    <div className="border border-bg-border rounded-md overflow-hidden bg-bg-secondary">
      <button
        type="button"
        onClick={() => hasMore && setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left bg-bg-tertiary ${
          hasMore ? "hover:bg-bg-elevated cursor-pointer" : "cursor-default"
        } ${expanded && hasMore ? "border-b border-line-soft" : ""} transition-colors`}
      >
        {statusIcon}
        <span className="text-[12px] font-medium text-text-primary">
          {toolCall.name}
        </span>
        {toolCall.file && (
          <span className="font-mono text-[10.5px] text-text-secondary truncate">
            {toolCall.file}
          </span>
        )}
        {!expanded && summaryPreview && verbosity !== "summary" && (
          <span className="ml-1 truncate text-text-muted text-[10.5px] flex-1 min-w-0">
            {summaryPreview.replace(/\n/g, " ↵ ")}
          </span>
        )}
        <span className="flex-1" />
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
        <span className="text-[10.5px] capitalize text-text-secondary">
          {toolCall.status}
        </span>
        {hasMore &&
          (expanded ? (
            <ChevronDown size={10} className="text-text-muted" />
          ) : (
            <ChevronRight size={10} className="text-text-muted" />
          ))}
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
