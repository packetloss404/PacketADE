import { useState } from "react";
import {
  Brain,
  Copy,
  Download,
  FileJson,
  MoreVertical,
  PanelRightOpen,
} from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Tooltip } from "@/components/ui/Tooltip";
import { ContinueInMenu } from "../ContinueInMenu";
import {
  exportConversationJson,
  copyTranscriptToClipboard,
} from "./handleExport";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useMemoryStore } from "@/stores/memoryStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface HeaderOverflowMenuProps {
  conversation: AgentConversation;
  previewOpen: boolean;
  togglePreview: () => void;
  onExport: () => void;
}

/**
 * Chat header's overflow menu — everything that used to be a standing
 * control lives here now: transcript density (api-only, P1-17 will replace
 * the <select> with a global cycled enum — this is the named slot, not a
 * redesign), memory toggle (api-only), the preview-pane toggle, export
 * (all modes), and the Continue-in section. Owns the shared feedback flash
 * (copy/clipboard confirmations) so every action in the menu reports through
 * one place.
 */
export function HeaderOverflowMenu({
  conversation,
  previewOpen,
  togglePreview,
  onExport,
}: HeaderOverflowMenuProps) {
  const conversationId = conversation.id;
  const memoryGetContext = useMemoryStore((s) => s.getContextForSession);
  const [feedback, setFeedback] = useState<string | null>(null);

  function flashFeedback(msg: string) {
    setFeedback(msg);
    window.setTimeout(() => setFeedback(null), 1800);
  }

  const handleCopyTranscript = async () => {
    const ok = await copyTranscriptToClipboard(conversation);
    flashFeedback(ok ? "Copied" : "Copy failed");
  };

  const isApi = conversation.mode === "api";

  return (
    <div className="relative">
      <Dropdown
        align="right"
        trigger={
          <span className="p-0.5 text-text-muted hover:text-text-primary inline-flex">
            <MoreVertical size={12} />
          </span>
        }
      >
        <div className="min-w-[240px]">
          {isApi && (
            <div className="px-3 py-1.5 border-b border-bg-border">
              <Tooltip content="Transcript density: Summary collapses tool calls and hides thinking; Verbose shows raw inputs.">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-text-secondary">
                    Transcript density
                  </span>
                  <select
                    value={conversation.transcriptVerbosity ?? "normal"}
                    onChange={(e) => {
                      const next = e.target.value as
                        | "summary"
                        | "normal"
                        | "verbose";
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
                </div>
              </Tooltip>
            </div>
          )}

          {isApi && (
            <button
              type="button"
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
              className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors border-b border-bg-border"
            >
              <span className="flex items-center gap-1.5">
                <Brain size={11} />
                Memory
              </span>
              <span
                className={
                  conversation.memoryContextEnabled
                    ? "text-accent-blue"
                    : "text-text-muted"
                }
              >
                {conversation.memoryContextEnabled ? "On" : "Off"}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={togglePreview}
            aria-pressed={previewOpen}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors border-b border-bg-border"
          >
            <PanelRightOpen size={11} />
            {previewOpen ? "Hide preview pane" : "Show preview pane"}
          </button>

          <div className="border-b border-bg-border">
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
          </div>

          <ContinueInMenu conversation={conversation} onFeedback={flashFeedback} />
        </div>
      </Dropdown>
      {feedback && (
        <div className="absolute top-full right-0 mt-1 z-50 px-2 py-1 text-[10px] bg-bg-elevated border border-bg-border rounded shadow text-text-secondary whitespace-nowrap">
          {feedback}
        </div>
      )}
    </div>
  );
}
