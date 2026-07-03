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
import {
  useAgentSettingsStore,
  type TranscriptViewMode,
} from "@/stores/agentSettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";
import type { AgentConversation } from "@/types/agent-conversation";

const VIEW_MODE_OPTIONS: { value: TranscriptViewMode; label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "normal", label: "Normal" },
  { value: "verbose", label: "Verbose" },
];

interface HeaderOverflowMenuProps {
  conversation: AgentConversation;
  previewOpen: boolean;
  togglePreview: () => void;
  onExport: () => void;
}

/**
 * Chat header's overflow menu — everything that used to be a standing
 * control lives here now: view mode (P1-17 — one global Summary/Normal/
 * Verbose transcript density, keyboard-cycled with Ctrl/Cmd+Shift+V,
 * un-gated because it applies to PTY transcripts too), memory toggle
 * (api-only), the preview-pane toggle, export (all modes), and the
 * Continue-in section. Owns the shared feedback flash (copy/clipboard
 * confirmations) so every action in the menu reports through one place.
 */
export function HeaderOverflowMenu({
  conversation,
  previewOpen,
  togglePreview,
  onExport,
}: HeaderOverflowMenuProps) {
  const conversationId = conversation.id;
  const memoryGetContext = useMemoryStore((s) => s.getContextForSession);
  const viewMode = useAgentSettingsStore((s) => s.transcriptViewMode);
  const setTranscriptViewMode = useAgentSettingsStore(
    (s) => s.setTranscriptViewMode,
  );
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
          <div className="px-3 py-1.5 border-b border-bg-border">
            <Tooltip content="Cycle with ⌘⇧V / Ctrl+Shift+V. Summary collapses tool detail; Verbose shows raw inputs.">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-text-secondary">
                  View mode
                </span>
                <div className="flex items-center gap-0.5 bg-bg-secondary border border-bg-border rounded p-0.5">
                  {VIEW_MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTranscriptViewMode(opt.value)}
                      aria-pressed={viewMode === opt.value}
                      className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                        viewMode === opt.value
                          ? "bg-bg-elevated text-text-primary"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </Tooltip>
          </div>

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
