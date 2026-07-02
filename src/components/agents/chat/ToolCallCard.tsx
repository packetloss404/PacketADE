import { memo, useEffect, useState } from "react";
import { ChevronRight, FileEdit } from "lucide-react";
import { StatusPill } from "../tool-cards/StatusPill";
import {
  isEditToolName,
  materializeEdits,
  parseEditToolCalls,
} from "@/lib/parseToolInput";
import { countLineChanges } from "@/lib/diffUtils";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useReviewStore } from "@/stores/reviewStore";
import type { AgentToolCall } from "@/types/agent-conversation";

function ToolCallCardImpl({
  toolCall,
  conversationId,
  projectPath,
  verbosity = "normal",
}: {
  toolCall: AgentToolCall;
  conversationId: string;
  projectPath: string;
  verbosity?: "summary" | "normal" | "verbose";
}) {
  const [expanded, setExpanded] = useState(verbosity === "verbose");

  // Keep expand state in sync when the per-conversation verbosity control
  // changes after the card has mounted.
  useEffect(() => {
    setExpanded(verbosity === "verbose");
  }, [verbosity]);

  // Normalized edit descriptor: fires for every provider's edit tools
  // (write_file, Write/Edit/MultiEdit/NotebookEdit, apply_patch), not just
  // the legacy in-process `write_file`. `projectPath` relativizes absolute
  // Claude Code / Codex paths so disk fallbacks and baseline keys line up.
  const edits = isEditToolName(toolCall.name)
    ? parseEditToolCalls(toolCall, projectPath)
    : [];
  const singleEdit = edits.length === 1 ? edits[0] : null;
  // Pre-edit content recorded for THIS call (per-tool-call baseline) so the
  // diff stays truthful after the edit applies. Subscribed so a baseline
  // arriving after the card mounted re-renders it.
  const callBaseline = useEditBaselineStore((s) =>
    s.byToolCall.get(toolCall.id),
  );
  const baselineContent =
    callBaseline && singleEdit && callBaseline.path === singleEdit.path
      ? callBaseline.content
      : undefined;
  // Replacement chains (Edit/MultiEdit) need the baseline to materialize;
  // without one there is nothing to diff — fall through to the generic card.
  const writeFileInput = singleEdit
    ? (() => {
        const after = materializeEdits([singleEdit], baselineContent ?? null);
        return after !== null
          ? { path: singleEdit.path, content: after }
          : null;
      })()
    : null;

  const statusPill =
    toolCall.status === "running" ? (
      <StatusPill status="running" />
    ) : (
      <StatusPill status={toolCall.status} variant="label" />
    );

  const isError = toolCall.status === "error";

  // P1-8: inline transcript edits collapse to a one-line file chip
  // (DiffPaneTrigger-style +N/-M). Clicking deep-links into the canonical
  // review surface focused on this file — the full diff (with the protected
  // per-row comment composer) lives there, not in the transcript.
  if (writeFileInput) {
    const baseName =
      writeFileInput.path.split(/[\\/]/).pop() ?? writeFileInput.path;
    const counts =
      baselineContent !== undefined
        ? countLineChanges(baselineContent ?? "", writeFileInput.content)
        : null;
    const isNewFile = baselineContent === null;
    return (
      <button
        type="button"
        onClick={() =>
          useReviewStore
            .getState()
            .openForConversation(conversationId, writeFileInput.path)
        }
        title={`Review ${writeFileInput.path}`}
        className={`w-full flex items-center gap-2 px-2 py-1 border rounded text-left transition-colors hover:bg-bg-tertiary ${
          isError
            ? "border-accent-red/30 bg-accent-red/5"
            : "border-bg-border bg-bg-secondary"
        }`}
      >
        <FileEdit size={12} className="text-text-secondary shrink-0" />
        <span className="text-xs font-medium text-text-primary shrink-0">
          Edit
        </span>
        <span className="font-mono text-[10px] text-text-secondary truncate">
          {baseName}
        </span>
        {isNewFile && (
          <span className="text-[9px] text-accent-green border border-accent-green/30 bg-accent-green/10 px-1 rounded shrink-0">
            new
          </span>
        )}
        {counts && (
          <span className="flex items-center gap-1 font-mono text-[10px] shrink-0">
            <span className="text-accent-green">+{counts.added}</span>
            <span className="text-accent-red">-{counts.removed}</span>
          </span>
        )}
        <span className="flex-1" />
        {statusPill}
      </button>
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

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const ToolCallCard = memo(ToolCallCardImpl);
