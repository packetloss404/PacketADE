import { useMemo, useState } from "react";
import {
  Brain,
  ChevronDown,
  Copy,
  Download,
  FileJson,
  MoreVertical,
  PanelRightOpen,
  MonitorUp,
} from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Tooltip } from "@/components/ui/Tooltip";
import { ContinueInMenu } from "../ContinueInMenu";
import { AddConversationToFlightModal } from "../AddConversationToFlightModal";
import { PacketCodeHandoffModal } from "../PacketCodeHandoffModal";
import { exportConversationJson, copyTranscriptToClipboard } from "./handleExport";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentSettingsStore, type TranscriptViewMode } from "@/stores/agentSettingsStore";
import { useMemoryStore, memoryBriefStats } from "@/stores/memoryStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { openMonitorWindow } from "@/lib/monitorWindows";
import {
  isRemoteConversation,
  REMOTE_UNSUPPORTED_TOOLTIP,
} from "@/lib/remoteConversation";

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
 * Verbose transcript density, keyboard-cycled with Ctrl/Cmd+Shift+O,
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
  const previewDisabled = isRemoteConversation(conversation);
  const composeMemoryBrief = useMemoryStore((s) => s.composeMemoryBrief);
  const memoryEvents = useMemoryStore((s) => s.events);
  const memoryPatterns = useMemoryStore((s) => s.patterns);
  const viewMode = useAgentSettingsStore((s) => s.transcriptViewMode);
  const setTranscriptViewMode = useAgentSettingsStore((s) => s.setTranscriptViewMode);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [memoryPreviewOpen, setMemoryPreviewOpen] = useState(false);
  const [handoffModal, setHandoffModal] = useState<"packetcode" | "flight" | null>(
    null,
  );

  const memoryBrief = useMemo(() => {
    const scope = conversation.sshTarget
      ? {
          kind: "ssh" as const,
          projectPath: conversation.projectPath,
          serverId: conversation.sshTarget.id,
          remotePath: conversation.sshTarget.remotePath,
        }
      : { kind: "local" as const, projectPath: conversation.projectPath };
    return composeMemoryBrief(scope);
    // composeMemoryBrief reads memory state through get(); include
    // events/patterns so the preview updates live while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversation.projectPath,
    conversation.sshTarget,
    composeMemoryBrief,
    memoryEvents,
    memoryPatterns,
  ]);
  const stats = useMemo(() => memoryBriefStats(memoryBrief), [memoryBrief]);

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
          <span className="inline-flex p-0.5 text-text-muted hover:text-text-primary">
            <MoreVertical size={12} />
          </span>
        }
      >
        <div className="min-w-[240px]">
          <div className="border-b border-bg-border px-3 py-1.5">
            <Tooltip content="Cycle with ⌘⇧O / Ctrl+Shift+O. Summary collapses tool detail; Verbose shows raw inputs.">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui text-text-secondary">View mode</span>
                <div className="flex items-center gap-0.5 rounded border border-bg-border bg-bg-secondary p-0.5">
                  {VIEW_MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTranscriptViewMode(opt.value)}
                      aria-pressed={viewMode === opt.value}
                      className={`rounded px-1.5 py-0.5 text-ui transition-colors ${
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
            <div className="border-b border-bg-border">
              <div className="flex items-center">
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
                  aria-pressed={!!conversation.memoryContextEnabled}
                  className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5 text-ui text-text-primary transition-colors hover:bg-bg-hover"
                >
                  <span className="flex items-center gap-1.5">
                    <Brain size={11} />
                    Memory
                  </span>
                  <span
                    className={
                      conversation.memoryContextEnabled ? "text-accent-blue" : "text-text-muted"
                    }
                  >
                    {conversation.memoryContextEnabled ? "On" : "Off"}
                  </span>
                </button>
                {conversation.memoryContextEnabled && (
                  <button
                    type="button"
                    onClick={() => setMemoryPreviewOpen((v) => !v)}
                    aria-expanded={memoryPreviewOpen}
                    aria-label={memoryPreviewOpen ? "Hide memory preview" : "Show memory preview"}
                    className="px-2 py-1.5 text-text-muted transition-colors hover:text-text-primary"
                  >
                    <ChevronDown
                      size={11}
                      className={`transition-transform ${memoryPreviewOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                )}
              </div>

              {conversation.memoryContextEnabled && (
                <div className="px-3 pb-1.5 text-meta tabular-nums text-text-muted">
                  {stats.patterns} pattern{stats.patterns === 1 ? "" : "s"} · {stats.lessons} lesson
                  {stats.lessons === 1 ? "" : "s"} · ~{stats.approxTokens} tok
                </div>
              )}

              {conversation.memoryContextEnabled && memoryPreviewOpen && (
                <div className="space-y-1 bg-bg-secondary px-3 pb-2 pt-1">
                  {memoryBrief.items.length === 0 ? (
                    <div className="text-meta text-text-muted">
                      No memory learned for this project yet — see the Memory view.
                    </div>
                  ) : (
                    <>
                      {memoryBrief.items.slice(0, 5).map((item) => (
                        <div key={item.id} className="truncate text-meta text-text-secondary">
                          <span className="mr-1 uppercase text-text-muted">{item.kind}</span>
                          {item.title}
                        </div>
                      ))}
                      {memoryBrief.items.length > 5 && (
                        <div className="text-meta text-text-muted">
                          +{memoryBrief.items.length - 5} more
                        </div>
                      )}
                      {memoryBrief.truncated && (
                        <div className="text-meta text-text-muted">
                          (truncated to fit {memoryBrief.charBudget}-char budget)
                        </div>
                      )}
                    </>
                  )}
                  <div className="text-meta text-text-muted">
                    Injected into the system prompt at session start.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* D3 / P0-4: the preview pane reads LOCAL disk — disabled (not
              hidden) for SSH-backed conversations so the capability stays
              discoverable. */}
          <button
            type="button"
            onClick={() => {
              if (previewDisabled) return;
              togglePreview();
            }}
            aria-pressed={previewOpen}
            aria-disabled={previewDisabled}
            disabled={previewDisabled}
            title={previewDisabled ? REMOTE_UNSUPPORTED_TOOLTIP : undefined}
            className={`flex w-full items-center gap-1.5 border-b border-bg-border px-3 py-1.5 text-ui text-text-primary transition-colors ${
              previewDisabled
                ? "cursor-not-allowed opacity-40"
                : "hover:bg-bg-hover"
            }`}
          >
            <PanelRightOpen size={11} />
            {previewOpen ? "Hide preview pane" : "Show preview pane"}
          </button>

          <div className="border-b border-bg-border">
            <DropdownItem
              onClick={() => {
                void openMonitorWindow({
                  kind: "agent_conversation",
                  conversationId: conversation.id,
                })
                  .then(() => flashFeedback("Sent to Monitor"))
                  .catch(() => flashFeedback("Monitor could not be opened"));
              }}
            >
              <span className="flex items-center gap-1.5 text-ui">
                <MonitorUp size={11} /> Send to Monitor
              </span>
            </DropdownItem>
            <DropdownItem onClick={onExport}>
              <span className="flex items-center gap-1.5 text-ui">
                <Download size={11} /> Export as Markdown
              </span>
            </DropdownItem>
            <DropdownItem onClick={() => exportConversationJson(conversation)}>
              <span className="flex items-center gap-1.5 text-ui">
                <FileJson size={11} /> Export as JSON
              </span>
            </DropdownItem>
            <DropdownItem onClick={() => void handleCopyTranscript()}>
              <span className="flex items-center gap-1.5 text-ui">
                <Copy size={11} /> Copy transcript
              </span>
            </DropdownItem>
          </div>

          <ContinueInMenu
            conversation={conversation}
            onFeedback={flashFeedback}
            onRequestPacketCode={() => setHandoffModal("packetcode")}
            onRequestFlight={() => setHandoffModal("flight")}
          />
        </div>
      </Dropdown>
      {handoffModal === "packetcode" && (
        <PacketCodeHandoffModal
          conversation={conversation}
          onClose={() => setHandoffModal(null)}
          onFeedback={flashFeedback}
        />
      )}
      {handoffModal === "flight" && (
        <AddConversationToFlightModal
          conversation={conversation}
          onClose={() => setHandoffModal(null)}
          onFeedback={flashFeedback}
        />
      )}
      {feedback && (
        <div className="absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded border border-bg-border bg-bg-elevated px-2 py-1 text-meta text-text-secondary shadow">
          {feedback}
        </div>
      )}
    </div>
  );
}
