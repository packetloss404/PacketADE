import { memo, useEffect, useState } from "react";
import { FileEdit } from "lucide-react";
import { BaseToolCard } from "../tool-cards/BaseToolCard";
import { StatusPill } from "../tool-cards/StatusPill";
import { toolRowMeta } from "../tool-cards/toolRowMeta";
import {
  isEditToolName,
  materializeEdits,
  parseEditToolCalls,
} from "@/lib/parseToolInput";
import { countLineChanges } from "@/lib/diffUtils";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useReviewStore } from "@/stores/reviewStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import type { AgentToolCall } from "@/types/agent-conversation";

function ToolCallCardImpl({
  toolCall,
  conversationId,
  projectPath,
}: {
  toolCall: AgentToolCall;
  conversationId: string;
  projectPath: string;
}) {
  const verbosity = useAgentSettingsStore((s) => s.transcriptViewMode);
  const [expanded, setExpanded] = useState(verbosity === "verbose");

  // Keep expand state in sync when the global view mode changes after the
  // card has mounted.
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
        <span className="text-ui font-medium text-text-primary shrink-0">
          Edit
        </span>
        <span className="font-mono text-ui text-text-secondary truncate">
          {baseName}
        </span>
        {isNewFile && (
          <span className="text-meta text-accent-green bg-accent-green/10 px-1 rounded shrink-0">
            new
          </span>
        )}
        {counts && (
          <span className="flex items-center gap-1 font-mono text-meta shrink-0">
            <span className="text-accent-green">+{counts.added}</span>
            <span className="text-accent-red">-{counts.removed}</span>
          </span>
        )}
        <span className="flex-1" />
        {statusPill}
      </button>
    );
  }

  // Generic bucket (not an edit chip, not bash/subagent/task_list — those
  // have dedicated cards): a uniform one-line verb row — icon · verb ·
  // target · status — expandable on click, through the same BaseToolCard
  // shell bash/subagent rows use.
  const summary = toolCall.summary ?? "";
  const body = toolCall.fullContent ?? summary;
  const canToggle = verbosity !== "summary" && body.trim().length > 0;
  const meta = toolRowMeta(toolCall);
  const Icon = meta.icon;

  return (
    <BaseToolCard
      icon={<Icon size={11} className="text-text-muted shrink-0" />}
      title={
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-text-primary shrink-0">{meta.verb}</span>
          {meta.target && (
            <span className="font-mono text-text-muted truncate min-w-0">
              {meta.target}
            </span>
          )}
        </span>
      }
      titleAttr={meta.target}
      statusPill={statusPill}
      canToggle={canToggle}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={{ expanded: "Collapse output", collapsed: "Expand output" }}
      isError={isError}
    >
      <pre className="text-ui font-mono whitespace-pre-wrap bg-bg-primary rounded p-2 mx-1 mb-1 text-text-primary overflow-y-auto max-h-[320px]">
        {body}
      </pre>
      {verbosity === "verbose" && toolCall.input && (
        <pre className="text-meta font-mono whitespace-pre-wrap bg-bg-secondary border-t border-line-soft p-2 mx-1 mb-1 max-h-48 overflow-y-auto text-text-muted">
          input: {toolCall.input}
        </pre>
      )}
    </BaseToolCard>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const ToolCallCard = memo(ToolCallCardImpl);
