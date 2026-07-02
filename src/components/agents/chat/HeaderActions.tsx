import { useState } from "react";
import {
  Brain,
  Copy,
  Download,
  FileJson,
  MoreVertical,
  PanelRightOpen,
  X,
} from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentModeChip, type AgentMode } from "../AgentModeChip";
import { ContextUsageRing } from "../ContextUsageRing";
import { ContinueInMenu } from "../ContinueInMenu";
import { DiffPaneTrigger } from "../DiffPaneTrigger";
import {
  exportConversationJson,
  copyTranscriptToClipboard,
} from "./handleExport";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { API_PROVIDERS } from "@/lib/api-models";
import type { AgentConversation } from "@/types/agent-conversation";

interface HeaderActionsProps {
  conversation: AgentConversation;
  conversationId: string;
  diffTotals: { fileCount: number; totalAdds: number; totalDels: number };
  previewOpen: boolean;
  togglePreview: () => void;
  onClose: () => void;
  onCycleMode: () => void;
  onSelectMode: (mode: AgentMode) => void;
  onSetApproveWrites: (on: boolean) => void;
  onChangeModel: (model: string) => void;
  onExport: () => void;
}

export function HeaderActions({
  conversation,
  conversationId,
  diffTotals,
  previewOpen,
  togglePreview,
  onClose,
  onCycleMode,
  onSelectMode,
  onSetApproveWrites,
  onChangeModel,
  onExport,
}: HeaderActionsProps) {
  const memoryGetContext = useMemoryStore((s) => s.getContextForSession);
  const providerInfo = API_PROVIDERS.find(
    (p) => p.agentCli === conversation.agent,
  );
  const currentModelValue = conversation.model ?? "";
  const currentModelLabel =
    providerInfo?.models.find((m) => m.value === currentModelValue)?.label ??
    currentModelValue ??
    "Model";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const handleCopyTranscript = async () => {
    const ok = await copyTranscriptToClipboard(conversation);
    setCopyState(ok ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      {conversation.mode === "api" && (
        <Tooltip content="Transcript density: Summary collapses tool calls and hides thinking; Verbose shows raw inputs.">
          <select
            value={conversation.transcriptVerbosity ?? "normal"}
            onChange={(e) => {
              const next = e.target.value as "summary" | "normal" | "verbose";
              useAgentTaskStore.setState((s) => ({
                conversations: s.conversations.map((c) =>
                  c.id === conversationId
                    ? { ...c, transcriptVerbosity: next, updatedAt: Date.now() }
                    : c,
                ),
              }));
            }}
            className="bg-bg-secondary border border-bg-border rounded text-[10px] px-1 py-0.5 text-text-secondary"
          >
            <option value="summary">Summary</option>
            <option value="normal">Normal</option>
            <option value="verbose">Verbose</option>
          </select>
        </Tooltip>
      )}

      {conversation.mode === "api" && (
        <button
          onClick={() => {
            useAgentTaskStore.setState((s) => ({
              conversations: s.conversations.map((c) =>
                c.id === conversationId
                  ? {
                      ...c,
                      memoryContextEnabled: !(c.memoryContextEnabled ?? false),
                      updatedAt: Date.now(),
                    }
                  : c,
              ),
            }));
          }}
          title={
            conversation.memoryContextEnabled
              ? (() => {
                  const ctx = memoryGetContext(conversation.projectPath);
                  if (!ctx.trim()) {
                    return "Memory context ON — no patterns learned yet for this project";
                  }
                  const preview =
                    ctx.length > 600 ? `${ctx.slice(0, 600)}…` : ctx;
                  return `Memory context ON — injecting:\n\n${preview}`;
                })()
              : "Memory context OFF — click to include learned patterns in system prompt"
          }
          aria-pressed={!!conversation.memoryContextEnabled}
          className={`inline-flex items-center gap-1 border rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            conversation.memoryContextEnabled
              ? "bg-accent-blue/15 border-accent-blue/40 text-accent-blue"
              : "border-bg-border text-text-muted hover:text-text-primary"
          }`}
        >
          <Brain size={11} />
          Memory
        </button>
      )}

      {conversation.mode === "api" && (
        <ContextUsageRing conversation={conversation} />
      )}

      {providerInfo && conversation.mode === "api" && (
        <div data-agent-pane-model-dropdown={conversationId}>
          <Dropdown
            align="right"
            trigger={
              <span className="text-[11px] text-text-secondary">
                {currentModelLabel}
              </span>
            }
          >
            {providerInfo.models.map((m) => (
              <DropdownItem
                key={m.value}
                onClick={() => onChangeModel(m.value)}
              >
                <span
                  className={
                    m.value === currentModelValue
                      ? "text-accent-green text-[11px]"
                      : "text-[11px]"
                  }
                >
                  {m.label}
                </span>
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}

      {conversation.mode === "api" && (
        <div className="flex items-center gap-1.5">
          <div data-agent-pane-mode-chip={conversationId}>
            <AgentModeChip
              conversation={conversation}
              onCycle={onCycleMode}
              onSelectMode={onSelectMode}
              onSetApproveWrites={onSetApproveWrites}
            />
          </div>
          {copyState !== "idle" && (
            <span
              className={`text-[10px] ${
                copyState === "copied" ? "text-accent-green" : "text-accent-red"
              }`}
            >
              {copyState === "copied" ? "Copied" : "Copy failed"}
            </span>
          )}
          <Dropdown
            align="right"
            trigger={
              <span className="p-0.5 text-text-muted hover:text-text-primary inline-flex">
                <MoreVertical size={12} />
              </span>
            }
          >
            <DropdownItem onClick={onExport}>
              <span className="flex items-center gap-1.5 text-[11px]">
                <Download size={11} /> Export as Markdown
              </span>
            </DropdownItem>
            <DropdownItem onClick={() => exportConversationJson(conversation)}>
              <span className="flex items-center gap-1.5 text-[11px]">
                <FileJson size={11} /> Export as JSON
              </span>
            </DropdownItem>
            <DropdownItem onClick={() => void handleCopyTranscript()}>
              <span className="flex items-center gap-1.5 text-[11px]">
                <Copy size={11} /> Copy transcript
              </span>
            </DropdownItem>
          </Dropdown>
        </div>
      )}

      {conversation.mode === "api" && (
        <DiffPaneTrigger
          conversationId={conversationId}
          fileCount={diffTotals.fileCount}
          totalAdds={diffTotals.totalAdds}
          totalDels={diffTotals.totalDels}
        />
      )}

      <Tooltip content={previewOpen ? "Collapse preview pane" : "Open preview pane"}>
        <button
          type="button"
          onClick={togglePreview}
          aria-pressed={previewOpen}
          className={`p-0.5 rounded transition-colors ${
            previewOpen
              ? "text-accent-blue bg-accent-blue/10"
              : "text-text-muted hover:text-text-primary"
          }`}
          aria-label={previewOpen ? "Collapse preview pane" : "Open preview pane"}
        >
          <PanelRightOpen size={12} />
        </button>
      </Tooltip>

      <ContinueInMenu conversation={conversation} />

      <Tooltip content="Back to list">
        <button
          onClick={onClose}
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
          aria-label="Back to list"
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
